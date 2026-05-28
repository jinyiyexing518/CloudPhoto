import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getBlobServiceClient, containerName } from "../../utils/blobStorage";
import { extractTokenFromHeader } from "../../utils/jwtUtils";

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const statusCode = (error as { statusCode?: number }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function isPreconditionFailed(error: unknown): boolean {
  return getStatusCode(error) === 412;
}

app.http("updatePhotoMetadata", {
  methods: ["PATCH"],
  authLevel: "anonymous",
  route: "photos/metadata",
  handler: async (
    request: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };
    try {
      const blobName = request.query.get("name");
      if (!blobName) return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "name required" }) };
      const body = (await request.json()) as {
        subject?: string;
        originalName?: string;
        favorite?: boolean;
        updatedBy?: string;
      };

      const blobServiceClient = getBlobServiceClient();
      const containerClient =
        blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
      const maxAttempts = 3;
      let updated = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const props = await blockBlobClient.getProperties();
        const existing: Record<string, string> = { ...(props.metadata ?? {}) };
        const now = new Date().toISOString();
        if (body.subject !== undefined) existing.subject = b64(body.subject);
        if (body.originalName !== undefined) existing.originalName = b64(body.originalName);
        if (body.favorite !== undefined) existing.favorite = body.favorite ? "1" : "0";
        if (body.updatedBy) existing.lastModifiedBy = b64(body.updatedBy);
        existing.lastModifiedAt = now;

        try {
          await blockBlobClient.setMetadata(existing, {
            conditions: props.etag ? { ifMatch: props.etag } : undefined,
          });
          updated = true;
          break;
        } catch (e) {
          if (isPreconditionFailed(e) && attempt < maxAttempts) continue;
          if (isPreconditionFailed(e)) {
            return {
              status: 409,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ error: "Photo was modified concurrently, please retry" }),
            };
          }
          throw e;
        }
      }

      if (!updated) {
        return {
          status: 409,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Photo update conflict, please retry" }),
        };
      }

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
