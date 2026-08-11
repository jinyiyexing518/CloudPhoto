import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getBlobServiceClient, containerName } from "../../utils/blob/blobStorage";
import { canAccessPhotoPath } from "../../utils/auth/photoAccess";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import { isGroupMember } from "../../utils/cosmos/cosmosClient";
import { syncPhotoLocationFromBlob } from "../../utils/cosmos/photoLocationSync";

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const statusCode = (error as { statusCode?: number }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function isPreconditionFailed(error: unknown): boolean {
  return getStatusCode(error) === 412;
}

/**
 * POST /api/photos/trash/restore?name=...
 * Restores a soft-deleted photo by clearing its deletedAt metadata.
 */
app.http("restorePhoto", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "photos/trash/restore",
  handler: async (
    request: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };

    const blobName = request.query.get("name");
    if (!blobName) return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "name required" }) };

    if (!await canAccessPhotoPath(blobName, payload, isGroupMember)) {
      return { status: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Forbidden" }) };
    }

    try {
      const blobServiceClient = getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      const maxAttempts = 3;
      let restored = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const props = await blockBlobClient.getProperties();
        const existing: Record<string, string> = { ...(props.metadata ?? {}) };

        // Azure metadata keys are effectively case-insensitive and are often returned in lowercase.
        // Remove deleted markers defensively so restore works with historical/case-varied metadata.
        for (const key of Object.keys(existing)) {
          const lower = key.toLowerCase();
          if (lower === "deletedat" || lower === "deletedby" || lower === "deletedbyname") {
            delete existing[key];
          }
        }

        try {
          await blockBlobClient.setMetadata(existing, {
            conditions: props.etag ? { ifMatch: props.etag } : undefined,
          });
          restored = true;
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

      if (!restored) {
        return {
          status: 409,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Photo restore conflict, please retry" }),
        };
      }

      // Reconcile from the latest Blob snapshot so a stale restore cannot
      // overwrite a newer GPS update in Cosmos.
      try {
        const scope = blobName.split("/").slice(0, 2).join("/");
        await syncPhotoLocationFromBlob(blockBlobClient, blobName, scope);
      } catch { /* best-effort, non-fatal */ }

      return { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Photo restored" }) };
    } catch (error) {
      context.error("Restore error:", error);
      return { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Failed to restore photo" }) };
    }
  },
});
