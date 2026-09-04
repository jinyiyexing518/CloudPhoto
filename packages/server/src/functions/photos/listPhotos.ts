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
import type { BlobItem } from "@azure/storage-blob";
import { extractTokenFromHeader } from "../../utils/auth/jwtUtils";
import { isVoiceMemoPathWithinPhotoScope } from "../../utils/auth/photoAccess";
import {
  getPhotoCatalogContainer,
  getPhotoLocationsContainer,
  isGroupMember,
} from "../../utils/cosmos/cosmosClient";
import {
  CatalogNotReadyError,
  InvalidPhotoCatalogCursorError,
  MAX_PHOTO_PAGE_SIZE,
  PhotoCatalogMutationInProgressError,
  PhotoCatalogRebuildInProgressError,
  PhotoCatalogRow,
  StalePhotoCatalogRebuildError,
  StalePhotoCatalogCursorError,
  abandonPhotoCatalogRebuild,
  beginPhotoCatalogRebuild,
  buildPhotoCatalogRow,
  deletePhotoCatalogSnapshot,
  listCompletePhotoCatalog,
  listPhotoCatalogPage,
  photoCatalogBlobCopyIsStable,
  replacePhotoCatalogSnapshot,
  renewPhotoCatalogRebuild,
} from "../../utils/cosmos/photoCatalog";
import {
  PhotoDerivativeNames,
  resolveListedPhotoDerivatives,
} from "./photoDerivatives";
import {
  hasGpsMetadataKeys,
  readGpsMetadata,
} from "../../utils/photos/gpsCoordinates";
import {
  hydrateListedPhotoLocations,
  listAuthorizedPhotoLocationRows,
  type HydratablePhoto,
  type ListedPhotoLocationSource,
} from "./photoListLocationHydration";

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

interface ListedPhoto extends HydratablePhoto {
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
  blobEtag: string | undefined;
  gpsMetadataPresent: boolean;
  takenAt: string | undefined;
  isAnimated: boolean;
}

function catalogRowToPhoto(
  row: PhotoCatalogRow,
  delegationKey: Awaited<ReturnType<typeof getUserDelegationKey>>,
) {
  return {
    name: row.name,
    originalName: row.originalName,
    subject: row.subject,
    folder: row.folder,
    groupId: row.groupId,
    url: generateSasUrlWithKey(row.name, delegationKey),
    thumbnailUrl: row.thumbnailName
      ? generateSasUrlWithKey(row.thumbnailName, delegationKey)
      : undefined,
    previewUrl: row.previewName
      ? generateSasUrlWithKey(row.previewName, delegationKey)
      : undefined,
    size: row.size,
    lastModified: row.lastModified,
    contentType: row.contentType,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    favorite: row.favorite,
    lastModifiedAt: row.lastModifiedAt,
    lastModifiedBy: row.lastModifiedBy,
    voiceMemoName: row.voiceMemoName,
    voiceMemoUrl: row.voiceMemoName
      ? generateSasUrlWithKey(row.voiceMemoName, delegationKey)
      : undefined,
    blobEtag: row.sourceBlobEtag,
    gpsMetadataPresent: row.gpsMetadataPresent,
    gpsLat: row.gpsLat,
    gpsLon: row.gpsLon,
    takenAt: row.takenAt,
    isAnimated: row.isAnimated,
  };
}

function photoCatalogUnavailable(
  code: "photo-catalog-mutating" | "photo-catalog-rebuilding",
  error: string,
): HttpResponseInit {
  return {
    status: 409,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Retry-After": "2",
    },
    body: JSON.stringify({ error, code }),
  };
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
    const pagedRequest = request.query.has("limit") || request.query.has("cursor");

    // For group photos, verify membership
    if (groupId && !await isGroupMember(groupId, payload.userId)) {
      return { status: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Not a member of this group" }) };
    }

    try {
      const catalogScope = groupId
        ? `groups/${groupId}`
        : payload.role === "admin"
          ? null
          : `personal/${payload.userId}`;

      if (pagedRequest) {
        if (!catalogScope) {
          return {
            status: 409,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
            body: JSON.stringify({
              error: "Photo catalog is not available for cross-partition admin listing",
              code: "photo-catalog-not-ready",
            }),
          };
        }
        const rawLimit = request.query.get("limit") ?? "24";
        if (!/^\d+$/.test(rawLimit)) {
          return {
            status: 400,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ error: "limit must be an integer" }),
          };
        }
        const limit = Number(rawLimit);
        if (limit < 1 || limit > MAX_PHOTO_PAGE_SIZE) {
          return {
            status: 400,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              error: `limit must be between 1 and ${MAX_PHOTO_PAGE_SIZE}`,
            }),
          };
        }

        try {
          const page = await listPhotoCatalogPage(
            await getPhotoCatalogContainer(),
            {
              scope: catalogScope,
              limit,
              cursor: request.query.get("cursor") ?? undefined,
            },
          );
          const delegationKey = await getUserDelegationKey();
          return {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            },
            body: JSON.stringify({
              ...page,
              items: page.items.map((row) => catalogRowToPhoto(row, delegationKey)),
            }),
          };
        } catch (error) {
          if (error instanceof PhotoCatalogMutationInProgressError) {
            return photoCatalogUnavailable(
              "photo-catalog-mutating",
              "Photo library is being updated",
            );
          }
          if (error instanceof PhotoCatalogRebuildInProgressError) {
            return photoCatalogUnavailable(
              "photo-catalog-rebuilding",
              "Photo catalog is being rebuilt",
            );
          }
          if (error instanceof CatalogNotReadyError) {
            return {
              status: 409,
              headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
              body: JSON.stringify({
                error: "Photo catalog is not ready",
                code: "photo-catalog-not-ready",
              }),
            };
          }
          if (error instanceof StalePhotoCatalogCursorError) {
            return {
              status: 409,
              headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
              body: JSON.stringify({
                error: "Photo catalog changed while paging",
                code: "stale-photo-cursor",
              }),
            };
          }
          if (error instanceof InvalidPhotoCatalogCursorError) {
            return {
              status: 400,
              headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
              body: JSON.stringify({
                error: "Invalid photo cursor",
                code: "invalid-photo-cursor",
              }),
            };
          }
          throw error;
        }
      }

      const catalogContainer = catalogScope
        ? await getPhotoCatalogContainer()
        : null;
      if (catalogContainer && catalogScope) {
        try {
          const catalogRows = await listCompletePhotoCatalog(
            catalogContainer,
            catalogScope,
          );
          const delegationKey = await getUserDelegationKey();
          return {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            },
            body: JSON.stringify(
              catalogRows.map((row) => catalogRowToPhoto(row, delegationKey)),
            ),
          };
        } catch (error) {
          if (error instanceof PhotoCatalogMutationInProgressError) {
            return photoCatalogUnavailable(
              "photo-catalog-mutating",
              "Photo library is being updated",
            );
          }
          if (
            error instanceof PhotoCatalogRebuildInProgressError
            || error instanceof StalePhotoCatalogCursorError
          ) {
            return photoCatalogUnavailable(
              "photo-catalog-rebuilding",
              "Photo catalog is being rebuilt",
            );
          }
          if (!(error instanceof CatalogNotReadyError)) throw error;
        }
      }
      let catalogRebuild: Awaited<ReturnType<typeof beginPhotoCatalogRebuild>> | null = null;
      if (catalogContainer && catalogScope) {
        try {
          catalogRebuild = await beginPhotoCatalogRebuild(
            catalogContainer,
            catalogScope,
          );
        } catch (error) {
          if (error instanceof PhotoCatalogMutationInProgressError) {
            return photoCatalogUnavailable(
              "photo-catalog-mutating",
              "Photo library is being updated",
            );
          }
          if (error instanceof PhotoCatalogRebuildInProgressError) {
            return photoCatalogUnavailable(
              "photo-catalog-rebuilding",
              "Photo catalog is being rebuilt",
            );
          }
          throw error;
        }
      }

      let catalogRebuildPublished = false;
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

      const photos: ListedPhoto[] = [];
      const photosByName = new Map<string, ListedPhoto>();
      const locationSources: Array<ListedPhotoLocationSource<ListedPhoto>> = [];
      const listedDerivativeNames = new Set<string>();
      const storedDerivativeNames = new Map<string, Partial<PhotoDerivativeNames>>();
      const listedPhotoBlobs: BlobItem[] = [];
      const resolvedDerivativeNames = new Map<string, Partial<PhotoDerivativeNames>>();

      // Fetch one delegation key for the whole listing — avoids a round-trip per blob
      const delegationKey = await getUserDelegationKey();

      for await (const blob of containerClient.listBlobsFlat({
        prefix,
        includeMetadata: true,
        includeCopy: true,
      })) {
        if (catalogRebuild) {
          if (!catalogContainer) {
            throw new Error("Photo catalog rebuild is missing its Cosmos container");
          }
          await renewPhotoCatalogRebuild(catalogRebuild, catalogContainer);
        }
        if (!photoCatalogBlobCopyIsStable(blob)) continue;
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
        const storedVoiceMemoName = getMeta(blob.metadata, "voiceMemoName");
        const voiceMemoName = storedVoiceMemoName
          && isVoiceMemoPathWithinPhotoScope(blob.name, storedVoiceMemoName)
          ? storedVoiceMemoName
          : undefined;
        const storedThumbnailName = decodeMeta(getMeta(blob.metadata, "thumbnailName"));
        const storedPreviewName = decodeMeta(getMeta(blob.metadata, "previewName"));
        storedDerivativeNames.set(blob.name, {
          ...(storedThumbnailName ? { thumbnailName: storedThumbnailName } : {}),
          ...(storedPreviewName ? { previewName: storedPreviewName } : {}),
        });
        listedPhotoBlobs.push(blob);

        const gps = readGpsMetadata(blob.metadata);
        const gpsMetadataPresent = hasGpsMetadataKeys(blob.metadata);
        const photo: ListedPhoto = {
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
          blobEtag: blob.properties.etag,
          gpsMetadataPresent,
          gpsLat: gps?.gpsLat,
          gpsLon: gps?.gpsLon,
          takenAt: getMeta(blob.metadata, "takenAt"),
          isAnimated: getMeta(blob.metadata, "isAnimated") === "1" || blob.properties.contentType === "image/gif",
        };
        photos.push(photo);
        photosByName.set(photo.name, photo);
        locationSources.push({
          photo,
          scope: `${segs[0]}/${segs[1]}`,
          blobEtag: photo.blobEtag,
          hasGpsMetadata: gpsMetadataPresent,
        });
      }

      if (locationSources.some((source) => !source.hasGpsMetadata)) {
        try {
          const locationRows = await listAuthorizedPhotoLocationRows(
            await getPhotoLocationsContainer(),
            { groupId, userId: payload.userId, role: payload.role },
          );
          hydrateListedPhotoLocations(locationSources, locationRows);
        } catch (error) {
          context.warn("photoLocations list hydration failed (non-fatal):", error);
        }
      }

      for (const photo of photos) {
        const listed = resolveListedPhotoDerivatives(
          photo.name,
          listedDerivativeNames,
          storedDerivativeNames.get(photo.name),
        );
        resolvedDerivativeNames.set(photo.name, listed);
        photo.thumbnailUrl = listed.thumbnailName
          ? generateSasUrlWithKey(listed.thumbnailName, delegationKey)
          : undefined;
        photo.previewUrl = listed.previewName
          ? generateSasUrlWithKey(listed.previewName, delegationKey)
          : undefined;
      }

      const catalogRows = catalogScope && catalogRebuild
        ? listedPhotoBlobs.map((blob) => {
            const photo = photosByName.get(blob.name);
            return buildPhotoCatalogRow(
              blob,
              catalogScope,
              catalogRebuild.id,
              resolvedDerivativeNames.get(blob.name),
              new Date(),
              photo
                ? {
                    gpsLat: photo.gpsLat,
                    gpsLon: photo.gpsLon,
                    gpsMetadataPresent: photo.gpsMetadataPresent,
                  }
                : undefined,
            );
          })
        : undefined;
      const catalogSortKeys = catalogRows
        ? new Map(catalogRows.map((row) => [row.name, row.sortKey]))
        : undefined;
      photos.sort((a, b) => {
        const sortKeyA = catalogSortKeys?.get(a.name);
        const sortKeyB = catalogSortKeys?.get(b.name);
        if (sortKeyA && sortKeyB) {
          return sortKeyA === sortKeyB ? 0 : sortKeyA > sortKeyB ? -1 : 1;
        }
        // Admin cross-partition listings retain the legacy time order.
        const timeA = a.takenAt ? new Date(a.takenAt).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : (a.lastModified ? new Date(a.lastModified).getTime() : 0));
        const timeB = b.takenAt ? new Date(b.takenAt).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : (b.lastModified ? new Date(b.lastModified).getTime() : 0));
        return timeB - timeA || b.name.localeCompare(a.name);
      });

      if (catalogContainer && catalogScope && catalogRows && catalogRebuild) {
        try {
          await replacePhotoCatalogSnapshot(
            catalogContainer,
            catalogScope,
            catalogRows,
            new Date(),
            catalogRebuild,
          );
          catalogRebuildPublished = true;
          if (catalogRebuild.previousSnapshotId) {
            try {
              await deletePhotoCatalogSnapshot(
                catalogContainer,
                catalogScope,
                catalogRebuild.previousSnapshotId,
              );
            } catch (error) {
              context.warn("Previous photo catalog snapshot cleanup failed:", error);
            }
          }
        } catch (error) {
          if (error instanceof PhotoCatalogMutationInProgressError) {
            return photoCatalogUnavailable(
              "photo-catalog-mutating",
              "Photo library changed during catalog rebuild",
            );
          }
          if (
            error instanceof PhotoCatalogRebuildInProgressError
            || error instanceof StalePhotoCatalogRebuildError
          ) {
            return photoCatalogUnavailable(
              "photo-catalog-rebuilding",
              "Photo catalog rebuild was superseded",
            );
          }
          context.error("Photo catalog materialization failed closed:", error);
          return photoCatalogUnavailable(
            "photo-catalog-rebuilding",
            "Photo catalog could not be published safely",
          );
        }
      }

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
      } finally {
        if (catalogContainer && catalogRebuild && !catalogRebuildPublished) {
          try {
            await abandonPhotoCatalogRebuild(catalogContainer, catalogRebuild);
          } catch (error) {
            context.warn("Photo catalog rebuild cleanup failed:", error);
          }
        }
      }
    } catch (error) {
      if (error instanceof PhotoCatalogMutationInProgressError) {
        return photoCatalogUnavailable(
          "photo-catalog-mutating",
          "Photo library changed during catalog rebuild",
        );
      }
      if (
        error instanceof CatalogNotReadyError
        || error instanceof PhotoCatalogRebuildInProgressError
        || error instanceof StalePhotoCatalogRebuildError
      ) {
        return photoCatalogUnavailable(
          "photo-catalog-rebuilding",
          "Photo catalog rebuild could not continue safely",
        );
      }
      context.error("List photos error:", error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Failed to list photos" }),
      };
    }
  },
});
