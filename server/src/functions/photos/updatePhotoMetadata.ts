import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getBlobServiceClient, containerName } from "../../utils/blobStorage";

app.http("updatePhotoMetadata", {
  methods: ["PATCH"],
  authLevel: "anonymous",
  route: "photos/metadata",
  handler: async (
    request: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    try {
      const blobName = request.query.get("name");
      if (!blobName) return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "name required" }) };
      const body = (await request.json()) as {
        subject?: string;
        updatedBy?: string;
      };

      const blobServiceClient = getBlobServiceClient();
      const containerClient =
        blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      const props = await blockBlobClient.getProperties();
      const existing: Record<string, string> = { ...(props.metadata ?? {}) };

      const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
      const now = new Date().toISOString();
      if (body.subject !== undefined) existing.subject = b64(body.subject);
      if (body.updatedBy) existing.lastModifiedBy = b64(body.updatedBy);
      existing.lastModifiedAt = now;

      await blockBlobClient.setMetadata(existing);

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ success: true }),
      };
    } catch (error) {
      context.error("Update metadata error:", error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Update failed" }),
      };
    }
  },
});
