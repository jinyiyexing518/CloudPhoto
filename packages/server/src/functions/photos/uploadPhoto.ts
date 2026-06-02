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
} from "../../utils/blobStorage";
import { extractTokenFromHeader } from "../../utils/jwtUtils";

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
      const blobName = `${scope}/${safeFolderPath}/${Date.now()}-${safeName}`;
      const now = new Date().toISOString();

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
      await blockBlobClient.uploadData(Buffer.from(arrayBuffer), {
        blobHTTPHeaders: { blobContentType: contentType },
        metadata: {
          originalName: b64(filename),
          subject: b64(subject),
          createdBy: b64(uploadedBy),
          createdById: payload.userId,
          createdAt: now,
          lastModifiedBy: b64(uploadedBy),
          lastModifiedAt: now,
        },
      });

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
          size: arrayBuffer.byteLength,
          contentType,
          createdBy: uploadedBy,
          createdAt: now,
          lastModifiedBy: uploadedBy,
          lastModifiedAt: now,
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
