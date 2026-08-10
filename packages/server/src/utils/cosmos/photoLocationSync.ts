import type { Container } from "@azure/cosmos";
import type { BlockBlobClient } from "@azure/storage-blob";
import { getPhotoLocationsContainer, PhotoLocationDoc } from "./cosmosClient";

function getMeta(metadata: Record<string, string> | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  return metadata[key] ?? metadata[key.toLowerCase()];
}

function decodeMeta(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return Buffer.from(raw, "base64").toString("utf8") || undefined;
  } catch {
    return raw;
  }
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { statusCode?: unknown; code?: unknown }).statusCode
    ?? (error as { code?: unknown }).code;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

async function deleteLocation(
  container: Container,
  id: string,
  scope: string,
  etag?: string,
): Promise<boolean> {
  try {
    await container.item(id, scope).delete(etag ? {
      accessCondition: { type: "IfMatch", condition: etag },
    } : undefined);
    return true;
  } catch (error) {
    if (statusCode(error) === 404) return true;
    if (statusCode(error) === 412) return false;
    throw error;
  }
}

async function readLocationEtag(container: Container, id: string, scope: string): Promise<string | null> {
  try {
    return (await container.item(id, scope).read()).etag;
  } catch (error) {
    if (statusCode(error) === 404) return null;
    throw error;
  }
}

async function readBlobProperties(blockBlobClient: BlockBlobClient) {
  try {
    return await blockBlobClient.getProperties();
  } catch (error) {
    if (statusCode(error) === 404) return null;
    throw error;
  }
}

interface VersionedPhotoLocationDoc extends PhotoLocationDoc {
  sourceBlobEtag: string;
  _etag?: string;
}

export type LocationPublishResult =
  | { status: "published"; etag: string }
  | { status: "source-changed" };

/**
 * Writes one Blob snapshot without overwriting a publication from a concurrent
 * reconciler. The Blob check runs after the Cosmos read, so a later writer
 * either wins first (our If-Match fails) or publishes after this write.
 */
export async function publishPhotoLocationSnapshot(
  container: Container,
  doc: PhotoLocationDoc,
  sourceBlobEtag: string,
  sourceIsCurrent: () => Promise<boolean>,
): Promise<LocationPublishResult> {
  const versionedDoc: VersionedPhotoLocationDoc = {
    ...doc,
    sourceBlobEtag,
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    let current: VersionedPhotoLocationDoc | undefined;
    let currentEtag: string | undefined;
    try {
      const response = await container.item(doc.id, doc.scope).read<VersionedPhotoLocationDoc>();
      current = response.resource;
      currentEtag = response.etag ?? current?._etag;
    } catch (error) {
      if (statusCode(error) !== 404) throw error;
    }

    if (!await sourceIsCurrent()) return { status: "source-changed" };
    if (current && !currentEtag) {
      throw new Error(`Photo location is missing an ETag: ${doc.name}`);
    }

    try {
      const response = current
        ? await container.item(doc.id, doc.scope).replace(versionedDoc, {
            accessCondition: {
              type: "IfMatch",
              condition: currentEtag!,
            },
          })
        : await container.items.create(versionedDoc);
      const etag = response.etag
        ?? (response.resource as VersionedPhotoLocationDoc | undefined)?._etag;
      if (!etag) throw new Error(`Photo location write returned no ETag: ${doc.name}`);
      return { status: "published", etag };
    } catch (error) {
      if ((statusCode(error) === 409 || statusCode(error) === 412) && attempt < 3) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Photo location changed repeatedly during publication: ${doc.name}`);
}

async function removeLocationForMissingBlob(
  container: Container,
  blockBlobClient: BlockBlobClient,
  id: string,
  scope: string,
): Promise<boolean> {
  const locationEtag = await readLocationEtag(container, id, scope);
  if (await readBlobProperties(blockBlobClient)) return false;
  if (locationEtag && !await deleteLocation(container, id, scope, locationEtag)) return false;
  return !await readBlobProperties(blockBlobClient);
}

function parseCoordinate(raw: string | undefined, min: number, max: number): number | null {
  if (!raw?.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/**
 * Publishes the current Blob GPS state instead of a caller's stale mutation.
 * A post-write ETag check closes the ordering gap with concurrent edits/deletes;
 * any later Blob writer is then responsible for its own Cosmos reconciliation.
 */
export async function syncPhotoLocationFromBlob(
  blockBlobClient: BlockBlobClient,
  blobName: string,
  scope: string,
): Promise<void> {
  const container = await getPhotoLocationsContainer();
  const id = encodeURIComponent(blobName);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const props = await readBlobProperties(blockBlobClient);
    if (!props) {
      if (await removeLocationForMissingBlob(container, blockBlobClient, id, scope)) return;
      continue;
    }
    const metadata = props.metadata;
    const sourceEtag = props.etag;
    if (!sourceEtag) {
      throw new Error(`Blob properties returned no ETag: ${blobName}`);
    }
    const lat = parseCoordinate(getMeta(metadata, "gpsLat"), -90, 90);
    const lon = parseCoordinate(getMeta(metadata, "gpsLon"), -180, 180);
    const hasLocation = (
      !getMeta(metadata, "deletedAt")
      && lat !== null
      && lon !== null
    );

    let publishedEtag: string | null = null;
    if (hasLocation) {
      const doc: PhotoLocationDoc = {
        id,
        scope,
        name: blobName,
        lat,
        lon,
        uploadedAt: getMeta(metadata, "createdAt")
          ?? props.createdOn?.toISOString()
          ?? new Date().toISOString(),
        ...(decodeMeta(getMeta(metadata, "originalName")) ? {
          originalName: decodeMeta(getMeta(metadata, "originalName")),
        } : {}),
        ...(props.contentType ? { contentType: props.contentType } : {}),
      };
      const publication = await publishPhotoLocationSnapshot(
        container,
        doc,
        sourceEtag,
        async () => (await readBlobProperties(blockBlobClient))?.etag === sourceEtag,
      );
      if (publication.status === "source-changed") continue;
      publishedEtag = publication.etag;
    } else {
      const locationEtag = await readLocationEtag(container, id, scope);
      if (locationEtag) {
        // Verify the no-location Blob snapshot immediately before the conditional
        // delete. A concurrent GPS writer either changes this ETag or the Cosmos ETag.
        const beforeDelete = await readBlobProperties(blockBlobClient);
        if (!beforeDelete) {
          if (await removeLocationForMissingBlob(container, blockBlobClient, id, scope)) return;
          continue;
        }
        if (beforeDelete.etag !== sourceEtag) continue;
        if (!await deleteLocation(container, id, scope, locationEtag)) continue;
      }
    }

    const verified = await readBlobProperties(blockBlobClient);
    if (!verified) {
      if (await removeLocationForMissingBlob(container, blockBlobClient, id, scope)) return;
      continue;
    }
    if (verified.etag === sourceEtag) return;
    // Remove only this helper's stale publication. A newer concurrent Cosmos
    // writer has a different ETag and is therefore preserved.
    if (publishedEtag) await deleteLocation(container, id, scope, publishedEtag);
  }

  throw new Error(`Photo location changed repeatedly during reconciliation: ${blobName}`);
}
