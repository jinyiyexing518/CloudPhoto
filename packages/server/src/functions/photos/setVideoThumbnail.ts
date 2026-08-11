import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import {
  getBlobServiceClient,
  containerName,
  getUserDelegationKey,
  generateSasUrlWithKey,
} from "../../utils/blob/blobStorage";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import { canAccessPhotoPath } from "../../utils/auth/photoAccess";
import { isGroupMember } from "../../utils/cosmos/cosmosClient";
import { expectedPhotoDerivativeNames } from "./photoDerivatives";
import type sharpT from "sharp";
let _sharp: typeof sharpT | null = null;
function getSharp(): typeof sharpT | null {
  if (_sharp !== null) return _sharp;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _sharp = require("sharp") as typeof sharpT;
    return _sharp;
  } catch {
    return null;
  }
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;

function getMeta(metadata: Record<string, string> | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  return metadata[key] ?? metadata[key.toLowerCase()];
}

function setMeta(metadata: Record<string, string>, key: string, value: string): void {
  for (const existing of Object.keys(metadata)) {
    if (existing.toLowerCase() === key.toLowerCase()) delete metadata[existing];
  }
  metadata[key] = value;
}

function isPreconditionFailed(error: unknown): boolean {
  return !!error && typeof error === "object"
    && (error as { statusCode?: number }).statusCode === 412;
}

/**
 * POST /api/photos/set-thumbnail?blobName=xxx
 *
 * Accepts a WebP image body (extracted client-side from a video frame),
 * stores it as the _th_ thumbnail blob, and writes thumbnailName into the
 * original blob's metadata so listPhotos can return a thumbnailUrl.
 *
 * Returns: { thumbnailUrl: string }
 */
app.http("setVideoThumbnail", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "photos/set-thumbnail",
  handler: async (
    request: HttpRequest,
    context: InvocationContext,
  ): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) {
      return { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    const blobName = request.query.get("blobName") ?? "";
    if (!blobName) {
      return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "blobName required" }) };
    }
    const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "image/webp") {
      return { status: 415, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "WebP thumbnail required" }) };
    }
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_THUMBNAIL_BYTES) {
      return { status: 413, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Thumbnail body too large" }) };
    }

    try {
      if (!await canAccessPhotoPath(blobName, payload, isGroupMember)) {
        return { status: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Forbidden" }) };
      }

      const body = await request.arrayBuffer();
      if (!body.byteLength) {
        return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Empty thumbnail body" }) };
      }
      if (body.byteLength > MAX_THUMBNAIL_BYTES) {
        return { status: 413, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Thumbnail body too large" }) };
      }

      const containerClient = getBlobServiceClient().getContainerClient(containerName);
      const origClient = containerClient.getBlockBlobClient(blobName);
      const initialProps = await origClient.getProperties();
      if (getMeta(initialProps.metadata, "deletedAt")) {
        return { status: 409, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Photo was deleted" }) };
      }

      // Derive thumbnail blob name — same pattern used in uploadPhoto and backfillThumbnails
      const { thumbnailName: thumbnailBlobName } = expectedPhotoDerivativeNames(blobName);

      // Resize thumbnail to 400px wide before storing — client sends raw canvas
      // frames which can be 1920×1080 WebP (~500KB); we need ~50KB like image thumbs.
      const sharpFn = getSharp();
      if (!sharpFn) {
        return { status: 503, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Thumbnail processing unavailable" }) };
      }
      let resizedBuf: Buffer;
      try {
        resizedBuf = await sharpFn(Buffer.from(body))
            .resize({ width: 400, withoutEnlargement: true })
            .webp({ quality: 75 })
            .toBuffer();
      } catch {
        return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Invalid thumbnail image" }) };
      }

      // Store the thumbnail blob
      const thumbClient = containerClient.getBlockBlobClient(thumbnailBlobName);
      await thumbClient.uploadData(resizedBuf, {
        blobHTTPHeaders: {
          blobContentType: "image/webp",
          blobCacheControl: "private, max-age=3600, immutable",
        },
        metadata: { isThumb: "1" },
      });

      // Publish the derivative name only after upload, merging the latest
      // metadata under ETag protection so concurrent edits are never clobbered.
      let metadataUpdated = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const props = await origClient.getProperties();
        const metadata: Record<string, string> = { ...(props.metadata ?? {}) };
        if (getMeta(metadata, "deletedAt")) break;
        setMeta(metadata, "thumbnailName", b64(thumbnailBlobName));
        try {
          if (!props.etag) throw new Error("Missing photo ETag");
          await origClient.setMetadata(metadata, { conditions: { ifMatch: props.etag } });
          metadataUpdated = true;
          break;
        } catch (error) {
          if (isPreconditionFailed(error) && attempt < 3) continue;
          throw error;
        }
      }
      if (!metadataUpdated) {
        return { status: 409, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Photo changed while saving thumbnail" }) };
      }

      // Return a fresh SAS URL so the client can update state immediately
      const delegationKey = await getUserDelegationKey();
      const thumbnailUrl = generateSasUrlWithKey(thumbnailBlobName, delegationKey);

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thumbnailUrl }),
      };
    } catch (err) {
      context.error("setVideoThumbnail error:", err);
      return { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Internal error" }) };
    }
  },
});
