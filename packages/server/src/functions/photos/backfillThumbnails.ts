import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getBlobServiceClient, containerName } from "../../utils/blob/blobStorage";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import { isGroupMember } from "../../utils/cosmos/cosmosClient";
import {
  BACKFILL_PAGE_SIZE,
  decodeBackfillCursor,
  encodeBackfillCursor,
} from "./backfillCursor";
import { expectedPhotoDerivativeNames } from "./photoDerivatives";
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

const THUMBNAIL_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);

function getMeta(metadata: Record<string, string> | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  return metadata[key] ?? metadata[key.toLowerCase()];
}

function decodeMeta(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return Buffer.from(raw, "base64").toString("utf8") || undefined;
  } catch {
    return raw;
  }
}

function setMeta(metadata: Record<string, string>, key: string, value: string): void {
  for (const existingKey of Object.keys(metadata)) {
    if (existingKey.toLowerCase() === key.toLowerCase()) delete metadata[existingKey];
  }
  metadata[key] = value;
}

function isPreconditionFailed(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { statusCode?: number }).statusCode === 412;
}

app.http("backfillThumbnails", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "photos/backfill-thumbnails",
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    try {
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
    // Max blobs to process per request — prevents 10 min Function timeout on large galleries.
    // Client calls repeatedly until hasMore is false.
    const parsedLimit = Number.parseInt(request.query.get("limit") ?? "30", 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 100)
      : 30;
    const scope = groupId ? `groups/${groupId}` : `personal/${payload.userId}`;
    const cursorContext = `thumbnails:${scope}`;
    const cursor = decodeBackfillCursor(request.query.get("cursor") ?? "", cursorContext);
    if (!cursor) {
      return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Invalid cursor" }) };
    }

    const prefix = `${scope}/`;

    const containerClient = getBlobServiceClient().getContainerClient(containerName);
    let processed = 0, generated = 0, skipped = 0, failed = 0;
    let lastProcessedName = "";
    let hasMore = false;
    let nextCursor = "";

      const listing = containerClient.listBlobsFlat({ prefix, includeMetadata: true });
      const pageStartToken = cursor.token || undefined;
      const afterName = cursor.after;
      pages: for await (const page of listing.byPage({
        continuationToken: pageStartToken,
        maxPageSize: BACKFILL_PAGE_SIZE,
      })) {
        for (const blob of page.segment.blobItems) {
        // A cursor that stopped inside a page resumes that same bounded page,
        // then skips only the entries already inspected there.
        if (afterName && blob.name <= afterName) continue;
        if (processed >= limit) {
          hasMore = true;
          nextCursor = encodeBackfillCursor({
            token: pageStartToken ?? "",
            after: lastProcessedName,
            context: cursorContext,
          });
          break pages;
        }
        // Skip soft-deleted and internal blobs
        if (getMeta(blob.metadata, "deletedAt")) continue;
        const segs = blob.name.split("/");
        const filename = segs[segs.length - 1];
        if (filename.startsWith("_th_")) continue;

        // Image originals can be decoded by sharp. Video originals are never
        // downloaded here; backfill may only reconnect an existing _th_ blob
        // produced by the upload/playback thumbnail endpoint.
        const mime = blob.properties.contentType ?? "";
        const isVideo = mime.startsWith("video/");
        if (!THUMBNAIL_MIME.has(mime) && !isVideo) { skipped++; continue; }

        // All animated images in THUMBNAIL_MIME get a first-frame static WebP thumbnail:
        // - Motion photos (animated JPEG): sharp processes JPEG portion, ignores video track.
        // - GIFs: sharp extracts frame 0 → fast gallery placeholder while full GIF loads.
        // - Animated WebPs: same first-frame extraction.

        const {
          thumbnailName: thumbName,
          previewName,
        } = expectedPhotoDerivativeNames(blob.name);
        const storedThumbName = decodeMeta(getMeta(blob.metadata, "thumbnailName"));
        const storedPreviewName = decodeMeta(getMeta(blob.metadata, "previewName"));

        // Bound each request by inspected originals, including healthy ones.
        processed++;
        lastProcessedName = blob.name;

        let thumbExists: boolean;
        let previewExists: boolean;
        try {
          [thumbExists, previewExists] = await Promise.all([
            containerClient.getBlockBlobClient(thumbName).exists(),
            isVideo
              ? Promise.resolve(false)
              : containerClient.getBlockBlobClient(previewName).exists(),
          ]);
        } catch (error) {
          failed++;
          context.warn(`Derivative check failed for ${blob.name}:`, error);
          continue;
        }

        const needsThumb = storedThumbName !== thumbName || !thumbExists;
        const needsPreview = !isVideo && (storedPreviewName !== previewName || !previewExists);
        // Skip blobs that already have both thumbnail and preview
        if (!needsThumb && !needsPreview) { skipped++; continue; }
        if (isVideo && !thumbExists) {
          skipped++;
          continue;
        }

        try {
          const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
          const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
          let sourceBuffer: Buffer | null = null;
          const getSourceBuffer = async (): Promise<Buffer> => {
            if (!sourceBuffer) sourceBuffer = await blockBlobClient.downloadToBuffer();
            return sourceBuffer;
          };

          if (needsThumb) {
            if (!thumbExists) {
              const thumbBuf = await sharp(await getSourceBuffer())
                .resize({ width: 400, withoutEnlargement: true })
                .webp({ quality: 75 })
                .toBuffer();
              const thumbClient = containerClient.getBlockBlobClient(thumbName);
              await thumbClient.uploadData(thumbBuf, {
                blobHTTPHeaders: {
                  blobContentType: "image/webp",
                  blobCacheControl: "private, max-age=3600, immutable",
                },
                metadata: { isThumb: "1" },
              });
              thumbExists = true;
            }
            context.log(`Thumbnail generated: ${thumbName}`);
          }

          if (needsPreview) {
            if (!previewExists) {
              // 2048 px preview — used by the viewer instead of the full original
              const previewBuf = await sharp(await getSourceBuffer())
                .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
                .webp({ quality: 82 })
                .toBuffer();
              const previewClient = containerClient.getBlockBlobClient(previewName);
              await previewClient.uploadData(previewBuf, {
                blobHTTPHeaders: {
                  blobContentType: "image/webp",
                  blobCacheControl: "private, max-age=3600, immutable",
                },
                metadata: { isThumb: "1" },
              });
              previewExists = true;
            }
            context.log(`Preview generated: ${previewName}`);
          }

          // Merge derivative names into the latest metadata under ETag
          // protection. The initial list can be minutes old by this point.
          let metadataUpdated = false;
          let deletedDuringBackfill = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            const props = await blockBlobClient.getProperties();
            const latestMeta: Record<string, string> = { ...(props.metadata ?? {}) };
            if (getMeta(latestMeta, "deletedAt")) {
              deletedDuringBackfill = true;
              break;
            }
            if (needsThumb) setMeta(latestMeta, "thumbnailName", b64(thumbName));
            if (needsPreview) setMeta(latestMeta, "previewName", b64(previewName));
            try {
              if (!props.etag) throw new Error("Missing photo ETag");
              await blockBlobClient.setMetadata(latestMeta, {
                conditions: { ifMatch: props.etag },
              });
              metadataUpdated = true;
              break;
            } catch (e) {
              if (isPreconditionFailed(e) && attempt < 3) continue;
              throw e;
            }
          }
          if (deletedDuringBackfill) {
            skipped++;
            continue;
          }
          if (!metadataUpdated) throw new Error("Thumbnail metadata update conflict");
          generated++;
        } catch (e) {
          failed++;
          context.warn(`Thumbnail/preview failed for ${blob.name}:`, e);
        }
       }

       // Never scan more than one raw Azure page per invocation. Empty, video-only,
       // and derivative-heavy libraries must yield back to the Function runtime too.
       if (page.continuationToken) {
         hasMore = true;
         nextCursor = encodeBackfillCursor({
           token: page.continuationToken,
           after: "",
           context: cursorContext,
         });
       }
       break;
      }

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          processed,
          generated,
          skipped,
          failed,
          hasMore,
          ...(hasMore && nextCursor ? { cursor: nextCursor } : {}),
        }),
      };
    } catch (error) {
      context.error("backfillThumbnails error:", error);
      return { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "回填失败", detail: error instanceof Error ? error.message : String(error) }) };
    }
  },
});
