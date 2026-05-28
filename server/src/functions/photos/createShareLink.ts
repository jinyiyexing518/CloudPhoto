import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { getBlobServiceClient, containerName, generateSasUrl } from "../../utils/blobStorage";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { isGroupMember } from "../../utils/cosmosClient";

app.http("createShareLink", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "photos/share",
  handler: async (
    request: HttpRequest,
    context: InvocationContext,
  ): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
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

    const hoursRaw = Number(request.query.get("hours") ?? "24");
    const hours = Number.isFinite(hoursRaw)
      ? Math.max(1, Math.min(168, Math.floor(hoursRaw)))
      : 24;

    const segs = blobName.split("/");
    if (segs[0] === "personal") {
      if (segs[1] !== payload.userId && payload.role !== "admin") {
        return {
          status: 403,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Forbidden" }),
        };
      }
    } else if (segs[0] === "groups") {
      if (!await isGroupMember(segs[1], payload.userId)) {
        return {
          status: 403,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Not a member of this group" }),
        };
      }
    } else {
      return {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid photo path" }),
      };
    }

    try {
      const blobServiceClient = getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobName);
      const props = await blobClient.getProperties();
      if (props.metadata?.deletedAt) {
        return {
          status: 404,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "Photo not found" }),
        };
      }

      const url = await generateSasUrl(blobName, hours);
      const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, expiresAt }),
      };
    } catch (error) {
      context.error("Create share link error:", error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Failed to create share link" }),
      };
    }
  },
});
