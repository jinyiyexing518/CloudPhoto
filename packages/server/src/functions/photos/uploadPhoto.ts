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
import { isGroupMember } from "../../utils/cosmos/cosmosClient";
import { syncPhotoLocationFromBlob } from "../../utils/cosmos/photoLocationSync";
import type { BlockBlobClient } from "@azure/storage-blob";
import { expectedPhotoDerivativeNames } from "./photoDerivatives";
import {
  getUploadAdmissionWeight,
  resolveUploadLengthReservation,
  uploadAdmission,
  validateBufferedUploadLength,
} from "./uploadAdmission";
import {
  readGpsMetadata,
  resolveUploadGps,
  uploadGpsMetadata,
} from "./uploadGps";
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

/** MIME types for which we generate a 400 px WebP thumbnail (first-frame for animated). */
const THUMBNAIL_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);

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

function uploadTooLargeResponse(
  isVideoUpload: boolean,
  isAudioUpload: boolean,
): HttpResponseInit {
  const limit = isVideoUpload ? "200 MB" : "20 MB";
  return {
    status: 413,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      error: `文件过大，${isVideoUpload ? "视频" : isAudioUpload ? "音频" : "图片"}最大支持 ${limit}`,
    }),
  };
}

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

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { statusCode?: unknown; code?: unknown }).statusCode
    ?? (error as { code?: unknown }).code;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

async function buildUploadResponse(
  blockBlobClient: BlockBlobClient,
  blobName: string,
  folder: string,
  groupId: string,
  scope: string,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const props = await blockBlobClient.getProperties();
  const metadata = props.metadata;
  const gps = readGpsMetadata(metadata);
  let locationIndexPending = false;
  try {
    await syncPhotoLocationFromBlob(blockBlobClient, blobName, scope);
  } catch (error) {
    locationIndexPending = Boolean(gps);
    context.warn("photoLocations reconciliation pending:", error);
  }
  const thumbnailName = decodeMeta(getMeta(metadata, "thumbnailName"));
  const previewName = decodeMeta(getMeta(metadata, "previewName"));
  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: blobName,
      originalName: decodeMeta(getMeta(metadata, "originalName")),
      subject: decodeMeta(getMeta(metadata, "subject")),
      folder: folder === "_" ? "" : folder,
      groupId: groupId || undefined,
      url: await generateSasUrl(blobName),
      ...(thumbnailName && { thumbnailUrl: await generateSasUrl(thumbnailName) }),
      ...(previewName && { previewUrl: await generateSasUrl(previewName) }),
      size: props.contentLength ?? 0,
      lastModified: props.lastModified?.toISOString()
        ?? getMeta(metadata, "lastModifiedAt")
        ?? getMeta(metadata, "createdAt")
        ?? new Date().toISOString(),
      contentType: props.contentType ?? "application/octet-stream",
      createdBy: decodeMeta(getMeta(metadata, "createdBy")),
      createdAt: getMeta(metadata, "createdAt"),
      lastModifiedBy: decodeMeta(getMeta(metadata, "lastModifiedBy")),
      lastModifiedAt: getMeta(metadata, "lastModifiedAt"),
      ...(getMeta(metadata, "isAnimated") === "1" && { isAnimated: true }),
      ...(gps ?? {}),
      ...(getMeta(metadata, "takenAt") && { takenAt: getMeta(metadata, "takenAt") }),
      ...(locationIndexPending && {
        locationIndexPending: true,
        warning: "照片 GPS 已保存，位置索引将在历史照片维护时重试",
      }),
    }),
  };
}

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
      const isVideoUpload = ALLOWED_VIDEO_MIME.has(mimeType);
      const isAudioUpload = ALLOWED_AUDIO_MIME.has(mimeType);
      const maxBytes = isVideoUpload ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      const lengthReservation = resolveUploadLengthReservation(
       request.headers.get("content-length"),
       maxBytes,
      );
      if (lengthReservation.kind === "too-large") {
       return uploadTooLargeResponse(isVideoUpload, isAudioUpload);
      }
      if (lengthReservation.kind === "invalid") {
       return {
         status: lengthReservation.reason === "missing" ? 411 : 400,
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({
           error: lengthReservation.reason === "missing"
             ? "Content-Length is required"
             : "Invalid Content-Length",
         }),
       };
      }
      const uploadedBy = request.query.get("uploadedBy") ?? "unknown";
      const subject = request.query.get("subject") ?? "";
      const folder = request.query.get("folder") ?? "";
      const groupId = request.query.get("groupId") ?? "";
      const gpsLat = request.query.get("gpsLat") ?? "";
      const gpsLon = request.query.get("gpsLon") ?? "";
      const rawUploadId = request.query.get("uploadId") ?? "";
      if (rawUploadId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawUploadId)) {
        return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Invalid uploadId" }) };
      }
      if (groupId && !await isGroupMember(groupId, payload.userId)) {
        return { status: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Not a member of this group" }) };
      }

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
      const objectId = rawUploadId || String(Date.now());
      const blobName = `${scope}/${safeFolderPath}/${objectId}-${safeName}`;
      const now = new Date().toISOString();

      // Pre-compute thumbnail blob name so it can be stored in original's metadata.
      // Thumbnails live at the same folder level but with a _th_ prefix + .webp suffix.
      // listPhotos skips blobs whose filename starts with _th_.
      const willGenerateThumb =
        !ALLOWED_VIDEO_MIME.has(mimeType) &&
        !ALLOWED_AUDIO_MIME.has(mimeType) &&
        THUMBNAIL_MIME.has(mimeType);
      // isAnimated is computed later; re-check after buf is available
      const {
        thumbnailName: thumbnailBlobName,
        previewName: previewBlobName,
      } = expectedPhotoDerivativeNames(blobName);

      const blobServiceClient = getBlobServiceClient();
      const containerClient =
        blobServiceClient.getContainerClient(containerName);
      await containerClient.createIfNotExists();

      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      if (rawUploadId && await blockBlobClient.exists()) {
        return buildUploadResponse(blockBlobClient, blobName, safeFolderPath, groupId, scope, context);
      }
      const admission = uploadAdmission.tryAcquire(
        payload.userId,
        getUploadAdmissionWeight(isVideoUpload, lengthReservation.reservationBytes),
        lengthReservation.reservationBytes,
      );
      if (!admission.accepted) {
        return {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(admission.retryAfterSeconds),
            "Access-Control-Expose-Headers": "Retry-After",
          },
          body: JSON.stringify({ error: "上传繁忙，请稍后重试" }),
        };
      }
      try {
        const arrayBuffer = await request.arrayBuffer();
        if (!validateBufferedUploadLength(
          arrayBuffer.byteLength,
          maxBytes,
          lengthReservation.declaredBytes ?? undefined,
        )) {
          if (
            lengthReservation.declaredBytes !== null
            && arrayBuffer.byteLength !== lengthReservation.declaredBytes
          ) {
            return {
              status: 400,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ error: "Content-Length does not match the request body" }),
            };
          }
          return uploadTooLargeResponse(isVideoUpload, isAudioUpload);
        }

        // Azure Blob metadata only allows ASCII — base64-encode all free-text fields
        const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
        const buf = Buffer.from(arrayBuffer);
        const isAnimated = !isVideoUpload && !isAudioUpload && detectAnimated(buf, mimeType);

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
      }
      const resolvedGps = await resolveUploadGps(gpsLat, gpsLon, async () => {
        if (isVideoUpload || isAudioUpload) return null;
        try {
          return await exifr.gps(buf);
        } catch {
          return null;
        }
      });
      // Animated check must happen before upload so we can conditionally skip thumbnail.
      // Motion photos (animated JPEG): sharp processes the JPEG portion, ignoring the video track.
      // GIFs: sharp extracts the first frame → static WebP thumbnail used as gallery placeholder.
      // Animated WebPs: same first-frame extraction.
      // All produce a valid static thumbnail shown while the full animated file loads.
      const skipThumb = !willGenerateThumb;

      const originalMetadata = {
        originalName: b64(filename),
        subject: b64(subject),
        createdBy: b64(uploadedBy),
        createdById: payload.userId,
        createdAt: now,
        lastModifiedBy: b64(uploadedBy),
        lastModifiedAt: now,
        ...uploadGpsMetadata(resolvedGps),
        ...(takenAt && { takenAt }),
        ...(isAnimated && { isAnimated: "1" }),
        ...(rawUploadId && { uploadId: rawUploadId }),
      };
      try {
        await blockBlobClient.uploadData(buf, {
          blobHTTPHeaders: {
            blobContentType: contentType,
            blobCacheControl: "private, max-age=3600, immutable",
          },
          metadata: originalMetadata,
          ...(rawUploadId ? { conditions: { ifNoneMatch: "*" } } : {}),
        });
      } catch (error) {
        if (rawUploadId && statusCode(error) === 412) {
          return buildUploadResponse(blockBlobClient, blobName, safeFolderPath, groupId, scope, context);
        }
        throw error;
      }

      // Generate 400 px WebP thumbnail — best-effort, failure is non-fatal
      let thumbnailGenerated = false;
      let previewGenerated = false;
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
              blobHTTPHeaders: {
                blobContentType: "image/webp",
                blobCacheControl: "private, max-age=3600, immutable",
              },
              metadata: { isThumb: "1" },
            });
            thumbnailGenerated = true;

            // Generate 2048 px preview — viewers use this instead of the full original
            const previewBuf = await sharpFn(buf)
              .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
              .webp({ quality: 82 })
              .toBuffer();
            const previewClient = containerClient.getBlockBlobClient(previewBlobName);
            await previewClient.uploadData(previewBuf, {
              blobHTTPHeaders: {
                blobContentType: "image/webp",
                blobCacheControl: "private, max-age=3600, immutable",
              },
              metadata: { isThumb: "1" },
            });
            previewGenerated = true;
          }
        } catch (e) {
          context.warn("Thumbnail/preview generation failed (non-fatal):", e);
        }
      }
      if (thumbnailGenerated || previewGenerated) {
        try {
          // Publish derivative names only after their blobs exist. Otherwise a
          // failed sharp/upload step leaves every gallery load retrying a 404.
          let published = false;
          for (let attempt = 0; attempt < 3 && !published; attempt++) {
            const latest = await blockBlobClient.getProperties();
            const metadata = { ...(latest.metadata ?? {}) };
            if (Object.keys(metadata).some((key) => key.toLowerCase() === "deletedat")) {
              break;
            }
            const setValue = (key: string, value: string) => {
              const existing = Object.keys(metadata)
                .find((candidate) => candidate.toLowerCase() === key.toLowerCase());
              metadata[existing ?? key] = value;
            };
            if (thumbnailGenerated) setValue("thumbnailName", b64(thumbnailBlobName));
            if (previewGenerated) setValue("previewName", b64(previewBlobName));
            try {
              if (!latest.etag) throw new Error("Missing photo ETag");
              await blockBlobClient.setMetadata(metadata, {
                conditions: { ifMatch: latest.etag },
              });
              published = true;
            } catch (error) {
              const statusCode = typeof error === "object" && error !== null && "statusCode" in error
                ? (error as { statusCode?: number }).statusCode
                : undefined;
              if (statusCode !== 412 || attempt === 2) throw error;
            }
          }
          if (!published) {
            thumbnailGenerated = false;
            previewGenerated = false;
          }
        } catch (e) {
          thumbnailGenerated = false;
          previewGenerated = false;
          context.warn("Derivative metadata update failed (backfill can repair it):", e);
        }
      }

        return buildUploadResponse(blockBlobClient, blobName, safeFolderPath, groupId, scope, context);
      } finally {
        admission.lease.release();
      }
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
