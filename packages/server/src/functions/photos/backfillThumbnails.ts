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
    const limit = Math.min(parseInt(request.query.get("limit") ?? "30", 10), 100);

    const scope = groupId ? `groups/${groupId}` : `personal/${payload.userId}`;
    const prefix = `${scope}/`;

    const containerClient = getBlobServiceClient().getContainerClient(containerName);
    let processed = 0, generated = 0, skipped = 0, failed = 0, remaining = 0;

      for await (const blob of containerClient.listBlobsFlat({ prefix, includeMetadata: true })) {
        // Skip soft-deleted and internal blobs
        if (getMeta(blob.metadata, "deletedAt")) continue;
        const segs = blob.name.split("/");
        const filename = segs[segs.length - 1];
        if (filename.startsWith("_th_")) continue;

        // Only process images that support thumbnail generation
        const mime = blob.properties.contentType ?? "";
        if (!THUMBNAIL_MIME.has(mime)) { skipped++; continue; }

        // Skip animated images except motion photos (animated JPEG).
        // Motion photos: sharp processes the JPEG portion fine, producing a valid thumbnail.
        // GIFs and animated WebPs need the full file to play so are left as-is.
        const isMotionPhotoBlob = getMeta(blob.metadata, "isAnimated") === "1"
          && (mime === "image/jpeg" || mime === "image/jpg");
        if (getMeta(blob.metadata, "isAnimated") === "1" && !isMotionPhotoBlob) { skipped++; continue; }

        const needsThumb = !getMeta(blob.metadata, "thumbnailName");
        const needsPreview = !getMeta(blob.metadata, "previewName");
        // Skip blobs that already have both thumbnail and preview
        if (!needsThumb && !needsPreview) { skipped++; continue; }

        // Respect per-request limit — count remaining but don't download/process them
        if (processed >= limit) { remaining++; continue; }
        processed++;
        try {
          // Derive blob names: same folder, _th_ prefix, .webp suffix
          const lastSlash = blob.name.lastIndexOf("/");
          const dir = blob.name.substring(0, lastSlash + 1);
          const thumbName = `${dir}_th_${filename}.webp`;
          const previewName = `${dir}_th_${filename}-prev.webp`;

          const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
          const buf = await blockBlobClient.downloadToBuffer();
          const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
          const updatedMeta = { ...blob.metadata };

          if (needsThumb) {
            const thumbBuf = await sharp(buf)
              .resize({ width: 400, withoutEnlargement: true })
              .webp({ quality: 75 })
              .toBuffer();
            const thumbClient = containerClient.getBlockBlobClient(thumbName);
            await thumbClient.uploadData(thumbBuf, {
              blobHTTPHeaders: { blobContentType: "image/webp" },
              metadata: { isThumb: "1" },
            });
            updatedMeta.thumbnailName = b64(thumbName);
            context.log(`Thumbnail generated: ${thumbName}`);
          }

          if (needsPreview) {
            // 2048 px preview — used by the viewer instead of the full original
            const previewBuf = await sharp(buf)
              .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
              .webp({ quality: 82 })
              .toBuffer();
            const previewClient = containerClient.getBlockBlobClient(previewName);
            await previewClient.uploadData(previewBuf, {
              blobHTTPHeaders: { blobContentType: "image/webp" },
              metadata: { isThumb: "1" },
            });
            updatedMeta.previewName = b64(previewName);
            context.log(`Preview generated: ${previewName}`);
          }

          await blockBlobClient.setMetadata(updatedMeta);
          generated++;
        } catch (e) {
          failed++;
          context.warn(`Thumbnail/preview failed for ${blob.name}:`, e);
        }
      }

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processed, generated, skipped, failed, hasMore: remaining > 0 }),
      };
    } catch (error) {
      context.error("backfillThumbnails error:", error);
      return { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "回填失败", detail: error instanceof Error ? error.message : String(error) }) };
    }
  },
});
