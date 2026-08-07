import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getBlobServiceClient, containerName } from "../../utils/blob/blobStorage";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import { isGroupMember } from "../../utils/cosmos/cosmosClient";
import type { BlobItem } from "@azure/storage-blob";
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
    const cursor = request.query.get("cursor") ?? "";

    const scope = groupId ? `groups/${groupId}` : `personal/${payload.userId}`;
    const prefix = `${scope}/`;

    const containerClient = getBlobServiceClient().getContainerClient(containerName);
    let processed = 0, generated = 0, skipped = 0, failed = 0, remaining = 0;
    let lastProcessedName = "";

      // The same listing already includes derivative blobs. Keep their names so
      // stale metadata can be detected without issuing two HEAD requests per photo.
      const blobs: BlobItem[] = [];
      const blobNames = new Set<string>();
      for await (const blob of containerClient.listBlobsFlat({ prefix, includeMetadata: true })) {
        blobs.push(blob);
        blobNames.add(blob.name);
      }

      for (const blob of blobs) {
        // Azure flat listings are lexicographically ordered. A cursor lets one
        // backfill run progress past a permanently broken item instead of
        // retrying the same first page forever and starving later photos.
        if (cursor && blob.name <= cursor) continue;
        // Skip soft-deleted and internal blobs
        if (getMeta(blob.metadata, "deletedAt")) continue;
        const segs = blob.name.split("/");
        const filename = segs[segs.length - 1];
        if (filename.startsWith("_th_")) continue;

        // Only process images that support thumbnail generation
        const mime = blob.properties.contentType ?? "";
        if (!THUMBNAIL_MIME.has(mime)) { skipped++; continue; }

        // All animated images in THUMBNAIL_MIME get a first-frame static WebP thumbnail:
        // - Motion photos (animated JPEG): sharp processes JPEG portion, ignores video track.
        // - GIFs: sharp extracts frame 0 → fast gallery placeholder while full GIF loads.
        // - Animated WebPs: same first-frame extraction.

        const lastSlash = blob.name.lastIndexOf("/");
        const dir = blob.name.substring(0, lastSlash + 1);
        const thumbName = `${dir}_th_${filename}.webp`;
        const previewName = `${dir}_th_${filename}-prev.webp`;
        const storedThumbName = decodeMeta(getMeta(blob.metadata, "thumbnailName"));
        const storedPreviewName = decodeMeta(getMeta(blob.metadata, "previewName"));
        const needsThumb = storedThumbName !== thumbName || !blobNames.has(thumbName);
        const needsPreview = storedPreviewName !== previewName || !blobNames.has(previewName);
        // Skip blobs that already have both thumbnail and preview
        if (!needsThumb && !needsPreview) { skipped++; continue; }

        // Stop at the first remaining candidate; the cursor resumes after the
        // last attempted item without rescanning/counting later blobs twice.
        if (processed >= limit) { remaining = 1; break; }
        processed++;
        lastProcessedName = blob.name;
        try {
          const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
          const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
          let sourceBuffer: Buffer | null = null;
          const getSourceBuffer = async (): Promise<Buffer> => {
            if (!sourceBuffer) sourceBuffer = await blockBlobClient.downloadToBuffer();
            return sourceBuffer;
          };

          if (needsThumb) {
            if (!blobNames.has(thumbName)) {
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
              blobNames.add(thumbName);
            }
            context.log(`Thumbnail generated: ${thumbName}`);
          }

          if (needsPreview) {
            if (!blobNames.has(previewName)) {
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
              blobNames.add(previewName);
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

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          processed,
          generated,
          skipped,
          failed,
          hasMore: remaining > 0,
          ...(remaining > 0 && lastProcessedName ? { cursor: lastProcessedName } : {}),
        }),
      };
    } catch (error) {
      context.error("backfillThumbnails error:", error);
      return { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "回填失败", detail: error instanceof Error ? error.message : String(error) }) };
    }
  },
});
