import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getBlobServiceClient, containerName } from "../../utils/blobStorage";
import { extractTokenFromHeader } from "../../utils/jwtUtils";

app.http("downloadPhoto", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "photos/download",
  handler: async (
    request: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(
      request.headers.get("authorization") ?? ""
    );
    if (!payload) {
      return {
        status: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }

    const blobName = request.query.get("name");
    if (!blobName) {
      return {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "name required" }),
      };
    }

    try {
      const blobServiceClient = getBlobServiceClient();
      const containerClient =
        blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobName);

      const props = await blobClient.getProperties();
      const downloadResponse = await blobClient.download();

      const originalName = props.metadata?.originalName
        ? Buffer.from(props.metadata.originalName, "base64").toString("utf8")
        : blobName.split("/").pop() ?? "photo";

      const contentType = props.contentType ?? "application/octet-stream";

      // Buffer the stream (images are typically < 20 MB)
      const chunks: Buffer[] = [];
      for await (const chunk of downloadResponse.readableStreamBody!) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as ArrayBuffer));
      }
      const body = Buffer.concat(chunks);

      return {
        status: 200,
        body,
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(originalName)}`,
          "Cache-Control": "private, max-age=3600",
        },
      };
    } catch (error) {
      context.error("Download error:", error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Download failed" }),
      };
    }
  },
});
