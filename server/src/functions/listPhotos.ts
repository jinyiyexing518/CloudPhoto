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

app.http("listPhotos", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "photos",
  handler: async (
    _request: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    try {
      const blobServiceClient = getBlobServiceClient();
      const containerClient =
        blobServiceClient.getContainerClient(containerName);
      await containerClient.createIfNotExists();

      const photos: Array<{
        name: string;
        url: string;
        size: number | undefined;
        lastModified: Date | undefined;
        contentType: string | undefined;
      }> = [];

      for await (const blob of containerClient.listBlobsFlat()) {
        photos.push({
          name: blob.name,
          url: generateSasUrl(blob.name),
          size: blob.properties.contentLength,
          lastModified: blob.properties.lastModified,
          contentType: blob.properties.contentType,
        });
      }

      photos.sort((a, b) => {
        const timeA = a.lastModified ? new Date(a.lastModified).getTime() : 0;
        const timeB = b.lastModified ? new Date(b.lastModified).getTime() : 0;
        return timeB - timeA;
      });

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(photos),
      };
    } catch (error) {
      context.error("List photos error:", error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Failed to list photos" }),
      };
    }
  },
});
