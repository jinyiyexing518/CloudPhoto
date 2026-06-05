import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { gzipSync } from "zlib";
import {
  getBlobServiceClient,
  containerName,
  getUserDelegationKey,
  generateSasUrlWithKey,
} from "../../utils/blob/blobStorage";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import { isGroupMember } from "../../utils/cosmos/cosmosClient";

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

function getMeta(metadata: Record<string, string> | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  return metadata[key] ?? metadata[key.toLowerCase()];
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
        thumbnailUrl: string | undefined;
        previewUrl: string | undefined;
        size: number | undefined;
        lastModified: Date | undefined;
        contentType: string | undefined;
        createdAt: string | undefined;
        createdBy: string | undefined;
        favorite: boolean;
        lastModifiedAt: string | undefined;
        lastModifiedBy: string | undefined;
        voiceMemoName: string | undefined;
        voiceMemoUrl: string | undefined;
        gpsLat: string | undefined;
        gpsLon: string | undefined;
        takenAt: string | undefined;
        isAnimated: boolean;
      }> = [];

      // Fetch one delegation key for the whole listing — avoids a round-trip per blob
      const delegationKey = await getUserDelegationKey();

      for await (const blob of containerClient.listBlobsFlat({ prefix, includeMetadata: true })) {
        // Path format: personal/{userId}/{folder}/{filename}  or  groups/{groupId}/{folder}/{filename}
        const segs = blob.name.split("/");
        if (segs.length < 4) continue;
        // Skip soft-deleted blobs — they live in the trash
        if (getMeta(blob.metadata, "deletedAt")) continue;
        // folder = every segment between ownerId and the filename (last segment)
        // supports arbitrarily nested sub-folders; backwards-compat with 4-segment paths
        const folderSegs = segs.slice(2, segs.length - 1);
        const folderRaw = folderSegs.join("/");
        // Skip voice memo storage folder — these are internal blobs, not gallery items
        if (folderRaw === "_voice") continue;
        // Skip internal thumbnail blobs (filename starts with _th_)
        const blobFilename = segs[segs.length - 1];
        if (blobFilename.startsWith("_th_")) continue;
        const blobGroupId = segs[0] === "groups" ? segs[1] : undefined;
        const folder = folderRaw === "_" ? "" : folderRaw;
        const voiceMemoName = getMeta(blob.metadata, "voiceMemoName");

        photos.push({
          name: blob.name,
          originalName: decodeMeta(getMeta(blob.metadata, "originalName")),
          subject: decodeMeta(getMeta(blob.metadata, "subject")),
          folder,
          groupId: blobGroupId,
          url: generateSasUrlWithKey(blob.name, delegationKey),
          thumbnailUrl: decodeMeta(getMeta(blob.metadata, "thumbnailName"))
            ? generateSasUrlWithKey(decodeMeta(getMeta(blob.metadata, "thumbnailName"))!, delegationKey)
            : undefined,
          previewUrl: decodeMeta(getMeta(blob.metadata, "previewName"))
            ? generateSasUrlWithKey(decodeMeta(getMeta(blob.metadata, "previewName"))!, delegationKey)
            : undefined,
          size: blob.properties.contentLength,
          lastModified: blob.properties.lastModified,
          contentType: blob.properties.contentType,
          createdAt: getMeta(blob.metadata, "createdAt"),
          createdBy: decodeMeta(getMeta(blob.metadata, "createdBy")),
          favorite: getMeta(blob.metadata, "favorite") === "1" || getMeta(blob.metadata, "favorite") === "true",
          lastModifiedAt: getMeta(blob.metadata, "lastModifiedAt"),
          lastModifiedBy: decodeMeta(getMeta(blob.metadata, "lastModifiedBy")),
          voiceMemoName,
          voiceMemoUrl: voiceMemoName ? generateSasUrlWithKey(voiceMemoName, delegationKey) : undefined,
          gpsLat: getMeta(blob.metadata, "gpsLat"),
          gpsLon: getMeta(blob.metadata, "gpsLon"),
          takenAt: getMeta(blob.metadata, "takenAt"),
          isAnimated: getMeta(blob.metadata, "isAnimated") === "1" || blob.properties.contentType === "image/gif",
        });
      }

      photos.sort((a, b) => {
        // Sort by photo taken time first, then upload time, then lastModified
        const timeA = a.takenAt ? new Date(a.takenAt).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : (a.lastModified ? new Date(a.lastModified).getTime() : 0));
        const timeB = b.takenAt ? new Date(b.takenAt).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : (b.lastModified ? new Date(b.lastModified).getTime() : 0));
        return timeB - timeA;
      });

      const jsonBody = JSON.stringify(photos);
      const sharedHeaders = {
        "Content-Type": "application/json; charset=utf-8",
        // Allow browser to serve the cached list for 30 s and revalidate in
        // background for up to 60 s.  SAS URLs are valid for 2 h so caching
        // for 30 s is safe and avoids redundant API calls on quick tab switches.
        "Cache-Control": "private, max-age=30, stale-while-revalidate=60",
      };

      // Gzip if the client supports it (saves ~65% on the JSON payload)
      const acceptEncoding = request.headers.get("accept-encoding") ?? "";
      if (acceptEncoding.includes("gzip")) {
        return {
          status: 200,
          body: gzipSync(jsonBody),
          headers: { ...sharedHeaders, "Content-Encoding": "gzip", "Vary": "Accept-Encoding" },
        };
      }

      return {
        status: 200,
        headers: sharedHeaders,
        body: jsonBody,
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
