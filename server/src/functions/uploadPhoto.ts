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
} from "../utils/blobStorage";

app.http("uploadPhoto", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "photos/upload",
  handler: async (
    request: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    try {
      const filename =
        request.query.get("filename") ?? `photo-${Date.now()}.jpg`;
      const contentType =
        request.headers.get("content-type") ?? "image/jpeg";

      const sanitizedName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const blobName = `${Date.now()}-${sanitizedName}`;

      const blobServiceClient = getBlobServiceClient();
      const containerClient =
        blobServiceClient.getContainerClient(containerName);
      await containerClient.createIfNotExists();

      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      const arrayBuffer = await request.arrayBuffer();

      await blockBlobClient.uploadData(Buffer.from(arrayBuffer), {
        blobHTTPHeaders: { blobContentType: contentType },
      });

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: blobName,
          url: generateSasUrl(blobName),
          size: arrayBuffer.byteLength,
          contentType,
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
