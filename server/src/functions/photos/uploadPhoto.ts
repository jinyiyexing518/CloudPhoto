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
      const uploadedBy = request.query.get("uploadedBy") ?? "unknown";
      const subject = request.query.get("subject") ?? "";
      const folder = request.query.get("folder") ?? "";
      const groupId = request.query.get("groupId") ?? "";

      // Only strip chars that are truly invalid in Azure blob names or HTTP paths
      const safeName = filename.replace(/[\/\\\0]/g, "_");
      const blobName = `${Date.now()}-${safeName}`;
      const now = new Date().toISOString();

      const blobServiceClient = getBlobServiceClient();
      const containerClient =
        blobServiceClient.getContainerClient(containerName);
      await containerClient.createIfNotExists();

      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      const arrayBuffer = await request.arrayBuffer();

      // Azure Blob metadata only allows ASCII — base64-encode all free-text fields
      const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
      await blockBlobClient.uploadData(Buffer.from(arrayBuffer), {
        blobHTTPHeaders: { blobContentType: contentType },
        metadata: {
          originalName: b64(filename),
          subject: b64(subject),
          folder: b64(folder),
          groupId,
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
          folder,
          groupId: groupId || undefined,
          url: generateSasUrl(blobName),
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
