import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getBlobServiceClient, containerName, generateDownloadSasUrl } from "../../utils/blob/blobStorage";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";

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
      const containerClient = getBlobServiceClient().getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobName);

      // Fetch only properties (not the file content) to get the original filename
      const props = await blobClient.getProperties();
      const originalName = props.metadata?.originalName
        ? Buffer.from(props.metadata.originalName, "base64").toString("utf8")
        : blobName.split("/").pop() ?? "photo";

      // Generate a short-lived SAS URL that instructs the browser to download
      // the file as an attachment (Content-Disposition: attachment; filename=...).
      // Returning only the URL — not the file body — means the server uses almost
      // no memory and responds in ~100ms instead of streaming 100MB+.
      const url = await generateDownloadSasUrl(blobName, originalName, 1);

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, filename: originalName }),
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
