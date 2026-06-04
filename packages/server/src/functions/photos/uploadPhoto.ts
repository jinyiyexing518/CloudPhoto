import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import {
  getBlobServiceClient,
  containerName,
  generateSasUrl,
} from "../../utils/blob/blobStorage";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import { getPhotoLocationsContainer, PhotoLocationDoc } from "../../utils/cosmos/cosmosClient";
import exifr from "exifr";
// sharp is loaded lazily via require() so a missing/incompatible native binary
// does not crash the entire function app on startup (would break login, etc.).
import type sharpT from "sharp";
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

/** MIME types for which we generate a 400 px WebP thumbnail. */
const THUMBNAIL_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/gif",
  "image/webp", "image/heic", "image/heif", "image/bmp", "image/tiff",
]);
const ALLOWED_VIDEO_MIME = new Set([
  "video/mp4", "video/quicktime", "video/webm",
  "video/x-msvideo", "video/mpeg", "video/3gpp", "video/3gpp2",
]);
const ALLOWED_AUDIO_MIME = new Set([
  "audio/webm", "audio/ogg", "audio/mp4", "audio/wav", "audio/mpeg", "audio/aac",
]);
const ALLOWED_UPLOAD_MIME = new Set([...ALLOWED_IMAGE_MIME, ...ALLOWED_VIDEO_MIME, ...ALLOWED_AUDIO_MIME]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;   // 20 MB
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;  // 200 MB

/**
 * Detect animated/motion photos that are not standard GIF.
 * - Animated WebP: RIFF container with VP8X chunk + animation flag
 * - APNG: PNG with acTL (animation control) chunk
 * - Android/Google Motion Photo: JPEG with XMP MotionPhoto markers
 */
function detectAnimated(buf: Buffer, mime: string): boolean {
  if (mime === "image/webp") {
    // VP8X chunk at offset 12, flags byte at offset 20, bit 1 = animation
    return (
      buf.length >= 21 &&
      buf.toString("ascii", 0, 4) === "RIFF" &&
      buf.toString("ascii", 8, 12) === "WEBP" &&
      buf.toString("ascii", 12, 16) === "VP8X" &&
      (buf[20] & 0x02) !== 0
    );
  }
  if (mime === "image/png") {
    // APNG has 'acTL' chunk somewhere before IDAT
    const scan = buf.subarray(0, Math.min(buf.length, 8192));
    for (let i = 8; i < scan.length - 8; i++) {
      if (scan[i] === 0x61 && scan[i+1] === 0x63 && scan[i+2] === 0x54 && scan[i+3] === 0x4c) return true; // 'acTL'
      if (scan[i] === 0x49 && scan[i+1] === 0x44 && scan[i+2] === 0x41 && scan[i+3] === 0x54) break;       // 'IDAT'
    }
    return false;
  }
  if (mime === "image/jpeg" || mime === "image/jpg") {
    // Motion/Live Photo formats: Google, Samsung, vivo, Huawei, Xiaomi, OPPO/OnePlus, Apple
    const header = buf.subarray(0, Math.min(buf.length, 65536)).toString("latin1");
    return (
      header.includes("MotionPhoto")     ||  // Google Pixel, Samsung, vivo, OPPO, Xiaomi
      header.includes("MicroVideo")      ||  // older Google Pixel
      header.includes("GCamera")         ||  // Google Camera
      header.includes("HwMotionPhoto")   ||  // Huawei
      header.includes("VivoLivePhoto")   ||  // vivo Live Photo (some models)
      header.includes("apple_fi")        ||  // Apple Live Photo (JPEG export)
      header.includes("Photos:Live")         // Apple Live Photo (iOS 14+)
    );
  }
  return false;
}

app.http("uploadPhoto", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "photos/upload",
  handler: async (
    request: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };
    try {
      const filename =
        request.query.get("filename") ?? `photo-${Date.now()}.jpg`;
      const contentType =
        request.headers.get("content-type") ?? "image/jpeg";
      const mimeType = contentType.split(";")[0].trim();
      if (!ALLOWED_UPLOAD_MIME.has(mimeType)) {
        return { status: 415, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "只支持图片和视频文件 (JPEG, PNG, WebP, MP4, MOV 等)" }) };
      }
      const uploadedBy = request.query.get("uploadedBy") ?? "unknown";
      const subject = request.query.get("subject") ?? "";
      const folder = request.query.get("folder") ?? "";
      const groupId = request.query.get("groupId") ?? "";
      const gpsLat = request.query.get("gpsLat") ?? "";
      const gpsLon = request.query.get("gpsLon") ?? "";

      const safeName = filename.replace(/[\/\\\0]/g, "_");
      // Path-based with sub-folder support: personal/{userId}/{folderPath}/{ts}-{name}
      // folderPath may contain "/" for nested sub-folders; each segment is sanitised individually
      const safeFolderPath = folder
        ? folder
            .split("/")
            .map((seg) => seg.replace(/[\\\0<>"|?*:]/g, "_").trim())
            .filter(Boolean)
            .join("/")
        : "_";
      const scope = groupId ? `groups/${groupId}` : `personal/${payload.userId}`;
      const ts = Date.now();
      const blobName = `${scope}/${safeFolderPath}/${ts}-${safeName}`;
      const now = new Date().toISOString();

      // Pre-compute thumbnail blob name so it can be stored in original's metadata.
      // Thumbnails live at the same folder level but with a _th_ prefix + .webp suffix.
      // listPhotos skips blobs whose filename starts with _th_.
      const willGenerateThumb =
        !ALLOWED_VIDEO_MIME.has(mimeType) &&
        !ALLOWED_AUDIO_MIME.has(mimeType) &&
        THUMBNAIL_MIME.has(mimeType);
      // isAnimated is computed later; re-check after buf is available
      const thumbnailBlobName = `${scope}/${safeFolderPath}/_th_${ts}-${safeName}.webp`;

      const blobServiceClient = getBlobServiceClient();
      const containerClient =
        blobServiceClient.getContainerClient(containerName);
      await containerClient.createIfNotExists();

      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      const arrayBuffer = await request.arrayBuffer();
      const isVideoUpload = ALLOWED_VIDEO_MIME.has(mimeType);
      const isAudioUpload = ALLOWED_AUDIO_MIME.has(mimeType);
      const maxBytes = isVideoUpload ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      if (arrayBuffer.byteLength > maxBytes) {
        const limit = isVideoUpload ? "200 MB" : "20 MB";
        return { status: 413, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: `文件过大，${isVideoUpload ? "视频" : isAudioUpload ? "音频" : "图片"}最大支持 ${limit}` }) };
      }

      // Azure Blob metadata only allows ASCII — base64-encode all free-text fields
      const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
      const buf = Buffer.from(arrayBuffer);
      const isAnimated = !isVideoUpload && !isAudioUpload && detectAnimated(buf, mimeType);

      // Server-side GPS extraction: try to read EXIF if client didn't provide coordinates
      let resolvedLat = gpsLat;
      let resolvedLon = gpsLon;
      // Use client-supplied takenAt as the base; EXIF will override it below for images
      let takenAt: string | undefined = (request.query.get("takenAt") ?? "") || undefined;
      if (!isVideoUpload && !isAudioUpload) {
        try {
          const exifData = await exifr.parse(buf, ["DateTimeOriginal", "CreateDate", "DateTime"]);
          const dt: unknown = exifData?.DateTimeOriginal ?? exifData?.CreateDate ?? exifData?.DateTime;
          if (dt instanceof Date && !isNaN(dt.getTime())) {
            // exifr treats EXIF datetime as UTC internally. Store as naive datetime
            // (no Z suffix) so the client interprets it in local time, not UTC.
            const pad = (n: number) => String(n).padStart(2, "0");
            takenAt = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
          }
        } catch { /* best-effort */ }
        if (!resolvedLat) {
          try {
            const gps = await exifr.gps(buf);
            if (gps?.latitude != null && gps?.longitude != null
                && isFinite(gps.latitude) && isFinite(gps.longitude)) {
              resolvedLat = String(gps.latitude);
              resolvedLon = String(gps.longitude);
            }
          } catch { /* best-effort */ }
        }
      }
      // Animated check must happen before upload so we can conditionally skip thumbnail
      const skipThumb = !willGenerateThumb || isAnimated;

      await blockBlobClient.uploadData(buf, {
        blobHTTPHeaders: { blobContentType: contentType },
        metadata: {
          originalName: b64(filename),
          subject: b64(subject),
          createdBy: b64(uploadedBy),
          createdById: payload.userId,
          createdAt: now,
          lastModifiedBy: b64(uploadedBy),
          lastModifiedAt: now,
          ...(resolvedLat && { gpsLat: resolvedLat }),
          ...(resolvedLon && { gpsLon: resolvedLon }),
          ...(takenAt && { takenAt }),
          ...(isAnimated && { isAnimated: "1" }),
          // Store thumbnail name so listPhotos can build a SAS URL without scanning
          ...(!skipThumb && { thumbnailName: thumbnailBlobName }),
        },
      });

      // Generate 400 px WebP thumbnail — best-effort, failure is non-fatal
      let thumbnailGenerated = false;
      if (!skipThumb) {
        try {
          const sharpFn = getSharp();
          if (sharpFn) {
            const thumbBuf = await sharpFn(buf)
              .resize({ width: 400, withoutEnlargement: true })
              .webp({ quality: 75 })
              .toBuffer();
            const thumbClient = containerClient.getBlockBlobClient(thumbnailBlobName);
            await thumbClient.uploadData(thumbBuf, {
              blobHTTPHeaders: { blobContentType: "image/webp" },
              metadata: { isThumb: "1" },
            });
            thumbnailGenerated = true;
          }
        } catch (e) {
          context.warn("Thumbnail generation failed (non-fatal):", e);
        }
      }

      // Cache GPS coordinates in Cosmos for fast map queries
      const latNum = parseFloat(resolvedLat ?? "");
      const lonNum = parseFloat(resolvedLon ?? "");
      if (resolvedLat && resolvedLon && isFinite(latNum) && isFinite(lonNum)) {
        try {
          const locsContainer = await getPhotoLocationsContainer();
          const doc: PhotoLocationDoc = {
            id: encodeURIComponent(blobName),
            scope,
            name: blobName,
            lat: latNum,
            lon: lonNum,
            originalName: filename,
            contentType: mimeType,
            uploadedAt: now,
          };
          await locsContainer.items.upsert(doc);
        } catch (e) {
          context.warn("photoLocations upsert failed (non-fatal):", e);
        }
      }

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: blobName,
          originalName: filename,
          subject,
          folder: safeFolderPath === "_" ? "" : safeFolderPath,
          groupId: groupId || undefined,
          url: await generateSasUrl(blobName),
          ...(thumbnailGenerated && { thumbnailUrl: await generateSasUrl(thumbnailBlobName) }),
          size: arrayBuffer.byteLength,
          contentType,
          createdBy: uploadedBy,
          createdAt: now,
          lastModifiedBy: uploadedBy,
          lastModifiedAt: now,
          ...(isAnimated && { isAnimated: true }),
          // Return resolved GPS/takenAt so the client can immediately show them
          // without waiting for the next full photo list refresh.
          ...(resolvedLat && { gpsLat: resolvedLat }),
          ...(resolvedLon && { gpsLon: resolvedLon }),
          ...(takenAt && { takenAt }),
        }),
      };
    } catch (error) {
      context.error("Upload error:", error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Upload failed" }),
      };
    }
  },
});
