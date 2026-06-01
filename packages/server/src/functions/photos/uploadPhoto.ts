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

const ALLOWED_UPLOAD_MIME = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/gif",
  "image/webp", "image/heic", "image/heif", "image/bmp", "image/tiff",
]);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

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
      if (!ALLOWED_UPLOAD_MIME.has(contentType.split(";")[0].trim())) {
        return { status: 415, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "只支持图片文件 (JPEG, PNG, GIF, WebP, HEIC 等)" }) };
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
      if (arrayBuffer.byteLength > MAX_UPLOAD_BYTES) {
        return { status: 413, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "文件过大，最大支持 20 MB" }) };
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
