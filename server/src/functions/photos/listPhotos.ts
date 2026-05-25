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
} from "../../utils/blobStorage";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { isGroupMember } from "../../utils/cosmosClient";

// Azure Blob metadata is ASCII-only; free-text fields are stored as base64
function decodeMeta(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    return decoded || undefined;
  } catch {
    return raw || undefined;
  }
}

app.http("listPhotos", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "photos",
  handler: async (
    request: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };

    const groupId = request.query.get("groupId") ?? "";

    // For group photos, verify membership
    if (groupId && !await isGroupMember(groupId, payload.userId)) {
      return { status: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Not a member of this group" }) };
    }

    try {
      const blobServiceClient = getBlobServiceClient();
      const containerClient =
        blobServiceClient.getContainerClient(containerName);
      await containerClient.createIfNotExists();

      // Prefix-based listing — no full-container scan needed
      const prefix = groupId
        ? `groups/${groupId}/`
        : payload.role === "admin"
          ? "personal/"
          : `personal/${payload.userId}/`;

      const photos: Array<{
        name: string;
        originalName: string | undefined;
        subject: string | undefined;
        folder: string | undefined;
        groupId: string | undefined;
        url: string;
        size: number | undefined;
        lastModified: Date | undefined;
        contentType: string | undefined;
        createdAt: string | undefined;
        createdBy: string | undefined;
        lastModifiedAt: string | undefined;
        lastModifiedBy: string | undefined;
      }> = [];

      for await (const blob of containerClient.listBlobsFlat({ prefix, includeMetadata: true })) {
        // Path format: personal/{userId}/{folder}/{filename}  or  groups/{groupId}/{folder}/{filename}
        const segs = blob.name.split("/");
        if (segs.length < 4) continue;
        const folderRaw = segs[2];
        const blobGroupId = segs[0] === "groups" ? segs[1] : undefined;
        const folder = folderRaw === "_" ? "" : folderRaw;

        photos.push({
          name: blob.name,
          originalName: decodeMeta(blob.metadata?.originalName),
          subject: decodeMeta(blob.metadata?.subject),
          folder,
          groupId: blobGroupId,
          url: generateSasUrl(blob.name),
          size: blob.properties.contentLength,
          lastModified: blob.properties.lastModified,
          contentType: blob.properties.contentType,
          createdAt: blob.metadata?.createdAt,
          createdBy: decodeMeta(blob.metadata?.createdBy),
          lastModifiedAt: blob.metadata?.lastModifiedAt,
          lastModifiedBy: decodeMeta(blob.metadata?.lastModifiedBy),
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
