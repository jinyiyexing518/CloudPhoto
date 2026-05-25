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

      for await (const blob of containerClient.listBlobsFlat({ includeMetadata: true })) {
        const blobGroupId = blob.metadata?.groupId ?? "";
        // Filter: personal (groupId="") shows blobs with no/empty groupId;
        // group shows blobs matching the groupId
        if (blobGroupId !== groupId) continue;

        // Private photos: only owner can see (admin sees all)
        if (!blobGroupId && payload.role !== "admin") {
          const blobCreatedById = blob.metadata?.createdById;
          if (blobCreatedById && blobCreatedById !== payload.userId) continue;
        }

        photos.push({
          name: blob.name,
          originalName: (() => {
            const raw = blob.metadata?.originalName;
            if (!raw) return undefined;
            try {
              const decoded = Buffer.from(raw, "base64").toString("utf8");
              return decoded || undefined;
            } catch {
              return undefined;
            }
          })(),
          subject: blob.metadata?.subject,
          folder: blob.metadata?.folder,
          groupId: blobGroupId || undefined,
          url: generateSasUrl(blob.name),
          size: blob.properties.contentLength,
          lastModified: blob.properties.lastModified,
          contentType: blob.properties.contentType,
          createdAt: blob.metadata?.createdAt,
          createdBy: blob.metadata?.createdBy,
          lastModifiedAt: blob.metadata?.lastModifiedAt,
          lastModifiedBy: blob.metadata?.lastModifiedBy,
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
