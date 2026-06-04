import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getBlobServiceClient, containerName } from "../../utils/blob/blobStorage";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import { isGroupMember } from "../../utils/cosmos/cosmosClient";
import type sharpT from "sharp";

// Lazy-load sharp so a missing native binary doesn't crash the function app
let sharpFn: typeof sharpT | null = null;
function getSharp(): typeof sharpT | null {
  if (sharpFn !== null) return sharpFn;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sharpFn = require("sharp") as typeof sharpT;
    return sharpFn;
  } catch {
    return null;
  }
}

const THUMBNAIL_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

function getMeta(metadata: Record<string, string> | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  return metadata[key] ?? metadata[key.toLowerCase()];
}

app.http("backfillThumbnails", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "photos/backfill-thumbnails",
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) {
      return { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    const sharp = getSharp();
    if (!sharp) {
      return { status: 503, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "sharp 未就绪，请稍后重试" }) };
    }

    const groupId = request.query.get("groupId") ?? "";
    if (groupId && !(await isGroupMember(groupId, payload.userId))) {
      return { status: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Not a member" }) };
    }

    const scope = groupId ? `groups/${groupId}` : `personal/${payload.userId}`;
    const prefix = `${scope}/`;

    try {
      const containerClient = getBlobServiceClient().getContainerClient(containerName);
      let processed = 0, generated = 0, skipped = 0, failed = 0;

      for await (const blob of containerClient.listBlobsFlat({ prefix, includeMetadata: true })) {
        // Skip soft-deleted and internal blobs
        if (getMeta(blob.metadata, "deletedAt")) continue;
        const segs = blob.name.split("/");
        const filename = segs[segs.length - 1];
        if (filename.startsWith("_th_")) continue;

        // Only process images that support thumbnail generation
        const mime = blob.properties.contentType ?? "";
        if (!THUMBNAIL_MIME.has(mime)) { skipped++; continue; }

        // Skip animated images (GIFs and detected animated blobs)
        if (getMeta(blob.metadata, "isAnimated") === "1") { skipped++; continue; }

        // Skip blobs that already have a thumbnail
        if (getMeta(blob.metadata, "thumbnailName")) { skipped++; continue; }

        processed++;
        try {
          // Derive thumbnail blob name: same folder, _th_ prefix, .webp suffix
          const lastSlash = blob.name.lastIndexOf("/");
          const dir = blob.name.substring(0, lastSlash + 1);
          const thumbName = `${dir}_th_${filename}.webp`;

          const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
          const buf = await blockBlobClient.downloadToBuffer();

          const thumbBuf = await sharp(buf)
            .resize({ width: 400, withoutEnlargement: true })
            .webp({ quality: 75 })
            .toBuffer();

          // Upload thumbnail blob
          const thumbClient = containerClient.getBlockBlobClient(thumbName);
          await thumbClient.uploadData(thumbBuf, {
            blobHTTPHeaders: { blobContentType: "image/webp" },
            metadata: { isThumb: "1" },
          });

          // Update original blob metadata to point to thumbnail
          await blockBlobClient.setMetadata({
            ...blob.metadata,
            thumbnailName: thumbName,
          });

          generated++;
          context.log(`Thumbnail generated: ${thumbName}`);
        } catch (e) {
          failed++;
          context.warn(`Thumbnail failed for ${blob.name}:`, e);
        }
      }

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processed, generated, skipped, failed }),
      };
    } catch (error) {
      context.error("backfillThumbnails error:", error);
      return { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "回填失败" }) };
    }
  },
});
