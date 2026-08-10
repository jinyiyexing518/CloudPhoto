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
} from "../../utils/blob/blobStorage";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import { isGroupMember } from "../../utils/cosmos/cosmosClient";
import {
  PhotoDerivativeNames,
  resolveListedPhotoDerivatives,
} from "./photoDerivatives";

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
      const listedDerivativeNames = new Set<string>();
      const storedDerivativeNames = new Map<string, Partial<PhotoDerivativeNames>>();

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
        if (blobFilename.startsWith("_th_")) {
          listedDerivativeNames.add(blob.name);
          continue;
        }
        const blobGroupId = segs[0] === "groups" ? segs[1] : undefined;
        const folder = folderRaw === "_" ? "" : folderRaw;
        const voiceMemoName = getMeta(blob.metadata, "voiceMemoName");
        const storedThumbnailName = decodeMeta(getMeta(blob.metadata, "thumbnailName"));
        const storedPreviewName = decodeMeta(getMeta(blob.metadata, "previewName"));
        storedDerivativeNames.set(blob.name, {
          ...(storedThumbnailName ? { thumbnailName: storedThumbnailName } : {}),
          ...(storedPreviewName ? { previewName: storedPreviewName } : {}),
        });

        photos.push({
          name: blob.name,
          originalName: decodeMeta(getMeta(blob.metadata, "originalName")),
          subject: decodeMeta(getMeta(blob.metadata, "subject")),
          folder,
          groupId: blobGroupId,
          url: generateSasUrlWithKey(blob.name, delegationKey),
          thumbnailUrl: undefined,
          previewUrl: undefined,
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

      for (const photo of photos) {
        const listed = resolveListedPhotoDerivatives(
          photo.name,
          listedDerivativeNames,
          storedDerivativeNames.get(photo.name),
        );
        photo.thumbnailUrl = listed.thumbnailName
          ? generateSasUrlWithKey(listed.thumbnailName, delegationKey)
          : undefined;
        photo.previewUrl = listed.previewName
          ? generateSasUrlWithKey(listed.previewName, delegationKey)
          : undefined;
      }

      photos.sort((a, b) => {
        // Sort by photo taken time first, then upload time, then lastModified
        const timeA = a.takenAt ? new Date(a.takenAt).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : (a.lastModified ? new Date(a.lastModified).getTime() : 0));
        const timeB = b.takenAt ? new Date(b.takenAt).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : (b.lastModified ? new Date(b.lastModified).getTime() : 0));
        return timeB - timeA;
      });

      const jsonBody = JSON.stringify(photos);
      // Cache-Control: allow the browser to serve the cached list for 30 s and
      // revalidate in the background for up to 60 s.  SAS URLs are valid for 2 h
      // so caching for 30 s is safe and avoids redundant calls on quick tab switches.
      // Note: gzip encoding is deliberately omitted — Azure Functions on Windows may
      // corrupt binary Buffer bodies by re-encoding them as UTF-8 text.
      return {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          // no-store: the client has its own SWR cache (_photoListCache) so we
          // don't want the browser to cache the list independently.  A browser-
          // cached empty response (from a cold-start glitch) would silently hide
          // all photos until the 30 s max-age expired.
          "Cache-Control": "no-store",
        },
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
