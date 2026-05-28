import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getBlobServiceClient, containerName } from "../../utils/blobStorage";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { isGroupMember } from "../../utils/cosmosClient";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const statusCode = (error as { statusCode?: number }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function isPreconditionFailed(error: unknown): boolean {
  return getStatusCode(error) === 412;
}

/**
 * DELETE /api/photos?name=...
 * Soft-deletes a photo by stamping deletedAt / deletedBy into blob metadata.
 * The blob is NOT removed from storage — use DELETE /api/photos/trash to hard-delete.
 */
app.http("deletePhoto", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "photos",
  handler: async (
    request: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };

    const blobName = request.query.get("name");
    if (!blobName) {
      return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Photo name is required" }) };
    }

    // Ownership check
    const segs = blobName.split("/");
    if (segs[0] === "personal") {
      if (segs[1] !== payload.userId && payload.role !== "admin") {
        return { status: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Forbidden" }) };
      }
    } else if (segs[0] === "groups") {
      if (!await isGroupMember(segs[1], payload.userId)) {
        return { status: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Not a member of this group" }) };
      }
    }

    try {
      const blobServiceClient = getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      const maxAttempts = 3;
      let deleted = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const props = await blockBlobClient.getProperties();
        const existing: Record<string, string> = { ...(props.metadata ?? {}) };
        if (!existing.createdAt) {
          existing.createdAt = props.createdOn?.toISOString()
            ?? props.lastModified?.toISOString()
            ?? new Date().toISOString();
        }
        existing.deletedAt = new Date().toISOString();
        existing.deletedBy = payload.userId;
        existing.deletedByName = b64(payload.displayName || payload.username || payload.userId);

        try {
          await blockBlobClient.setMetadata(existing, {
            conditions: props.etag ? { ifMatch: props.etag } : undefined,
          });
          deleted = true;
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

      if (!deleted) {
        return {
          status: 409,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Photo delete conflict, please retry" }),
        };
      }

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Photo moved to trash" }),
      };
    } catch (error) {
      context.error("Soft-delete error:", error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Failed to delete photo" }),
      };
    }
  },
});
