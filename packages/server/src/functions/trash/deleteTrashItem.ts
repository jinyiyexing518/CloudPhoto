import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getBlobServiceClient, containerName } from "../../utils/blobStorage";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { isGroupMember } from "../../utils/cosmosClient";

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const statusCode = (error as { statusCode?: number }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function isPreconditionFailed(error: unknown): boolean {
  return getStatusCode(error) === 412;
}

/**
 * DELETE /api/photos/trash?name=...
 * Permanently deletes a blob that was previously soft-deleted.
 * Irreversible — blob and its Blob Storage data are removed.
 */
app.http("deleteTrashItem", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "photos/trash",
  handler: async (
    request: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };

    const blobName = request.query.get("name");
    if (!blobName) return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "name required" }) };

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
      let removed = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const props = await blockBlobClient.getProperties();
        const metadata = props.metadata ?? {};
        const deletedAt = metadata.deletedAt ?? metadata.deletedat;
        if (!deletedAt) {
          return {
            status: 409,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "Photo is not in trash or was already restored" }),
          };
        }

        try {
          const deleted = await blockBlobClient.deleteIfExists({
            conditions: props.etag ? { ifMatch: props.etag } : undefined,
          });
          removed = deleted.succeeded;
          if (!deleted.succeeded) {
            return {
              status: 404,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ error: "Photo not found" }),
            };
          }
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

      if (!removed) {
        return {
          status: 409,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Photo delete conflict, please retry" }),
        };
      }

      return { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Permanently deleted" }) };
    } catch (error) {
      context.error("Permanent delete error:", error);
      return { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Failed to delete" }) };
    }
  },
});
