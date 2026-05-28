import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import {
  getBlobServiceClient,
  containerName,
  getUserDelegationKey,
  generateSasUrlWithKey,
} from "../../utils/blobStorage";
import { extractTokenFromHeader } from "../../utils/jwtUtils";
import { isGroupMember } from "../../utils/cosmosClient";

function decodeMeta(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try { return Buffer.from(raw, "base64").toString("utf8") || undefined; }
  catch { return raw || undefined; }
}

function getMeta(metadata: Record<string, string> | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  return metadata[key] ?? metadata[key.toLowerCase()];
}

/**
 * GET /api/photos/trash?groupId=...
 * Returns soft-deleted photos (blobs with deletedAt metadata) for the caller's scope.
 */
app.http("listTrash", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "photos/trash",
  handler: async (
    request: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    const payload = extractTokenFromHeader(request.headers.get("authorization") ?? "");
    if (!payload) return { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };

    const groupId = request.query.get("groupId") ?? "";

    if (groupId && !await isGroupMember(groupId, payload.userId)) {
      return { status: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Not a member of this group" }) };
    }

    try {
      const blobServiceClient = getBlobServiceClient();
      const containerClient = blobServiceClient.getContainerClient(containerName);
      await containerClient.createIfNotExists();

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
        deletedAt: string | undefined;
        deletedBy: string | undefined;
      }> = [];

      const delegationKey = await getUserDelegationKey();

      for await (const blob of containerClient.listBlobsFlat({ prefix, includeMetadata: true })) {
        const segs = blob.name.split("/");
        if (segs.length < 4) continue;
        // Only include soft-deleted blobs
        if (!getMeta(blob.metadata, "deletedAt")) continue;

        const folderSegs = segs.slice(2, segs.length - 1);
        const folderRaw = folderSegs.join("/");
        const blobGroupId = segs[0] === "groups" ? segs[1] : undefined;
        const folder = folderRaw === "_" ? "" : folderRaw;

        photos.push({
          name: blob.name,
          originalName: decodeMeta(getMeta(blob.metadata, "originalName")),
          subject: decodeMeta(getMeta(blob.metadata, "subject")),
          folder,
          groupId: blobGroupId,
          url: generateSasUrlWithKey(blob.name, delegationKey),
          size: blob.properties.contentLength,
          lastModified: blob.properties.lastModified,
          contentType: blob.properties.contentType,
          createdAt: getMeta(blob.metadata, "createdAt"),
          createdBy: decodeMeta(getMeta(blob.metadata, "createdBy")),
          deletedAt: getMeta(blob.metadata, "deletedAt"),
          deletedBy: getMeta(blob.metadata, "deletedBy"),
        });
      }

      photos.sort((a, b) => {
        const ta = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
        const tb = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
        return tb - ta; // Most recently deleted first
      });

      return { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(photos) };
    } catch (error) {
      context.error("List trash error:", error);
      return { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Failed to list trash" }) };
    }
  },
});
