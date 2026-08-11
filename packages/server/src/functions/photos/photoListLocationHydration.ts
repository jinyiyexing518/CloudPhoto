import {
  formatCoordinate,
  parseFiniteCoordinate,
} from "../../utils/photos/gpsCoordinates";

interface PhotoLocationQuery {
  query: string;
  parameters?: Array<{ name: string; value: string }>;
}

interface PhotoLocationQueryContainer {
  items: {
    query<T>(query: PhotoLocationQuery, options?: { abortSignal?: AbortSignal }): {
      fetchAll(): Promise<{ resources: T[] }>;
    };
  };
}

interface IndexedPhotoLocationRow {
  id?: unknown;
  scope?: unknown;
  name?: unknown;
  photoName?: unknown;
  lat?: unknown;
  lon?: unknown;
  originalName?: unknown;
  contentType?: unknown;
  uploadedAt?: unknown;
  sourceBlobEtag?: unknown;
}

export interface PhotoLocationAccess {
  groupId: string;
  userId: string;
  role: string;
}

export interface HydratablePhoto {
  name: string;
  gpsLat?: string;
  gpsLon?: string;
}

export interface ListedPhotoLocationSource<TPhoto extends HydratablePhoto> {
  photo: TPhoto;
  scope: string;
  blobEtag?: string;
  hasGpsMetadata: boolean;
}

export interface PhotoLocationHydrationDiagnostics {
  hydrated: number;
  orphanedOrOutOfScope: number;
  invalidCoordinates: number;
  staleSource: number;
  blobMetadataAuthoritative: number;
  ambiguousRows: number;
}

const LOCATION_SELECT =
  "SELECT c.id, c.scope, c.name, c.photoName, c.lat, c.lon, c.originalName, c.contentType, c.uploadedAt, c.sourceBlobEtag FROM c";

export const PHOTO_LOCATION_QUERY_TIMEOUT_MS = 1_500;

function locationIdentifier(row: IndexedPhotoLocationRow): string | null {
  const hasName = row.name !== undefined;
  const hasPhotoName = row.photoName !== undefined;
  const name = typeof row.name === "string" && row.name.length > 0 ? row.name : null;
  const photoName = typeof row.photoName === "string" && row.photoName.length > 0
    ? row.photoName
    : null;
  if ((hasName && !name) || (hasPhotoName && !photoName)) return null;
  if (name && photoName && name !== photoName) return null;
  return name ?? photoName;
}

function locationIdentifierCandidates(row: IndexedPhotoLocationRow): string[] {
  return [...new Set(
    [row.name, row.photoName]
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  )];
}

export async function listAuthorizedPhotoLocationRows(
  container: PhotoLocationQueryContainer,
  access: PhotoLocationAccess,
  timeoutMs = PHOTO_LOCATION_QUERY_TIMEOUT_MS,
): Promise<IndexedPhotoLocationRow[]> {
  const query = access.groupId
    ? {
        query: `${LOCATION_SELECT} WHERE c.scope = @scope`,
        parameters: [{ name: "@scope", value: `groups/${access.groupId}` }],
      }
    : access.role === "admin"
      ? {
          query: `${LOCATION_SELECT} WHERE STARTSWITH(c.scope, 'personal/')`,
        }
      : {
          query: `${LOCATION_SELECT} WHERE c.scope = @scope`,
          parameters: [{ name: "@scope", value: `personal/${access.userId}` }],
        };
  const abortController = new AbortController();
  const queryPromise = container.items.query<IndexedPhotoLocationRow>(
    query,
    { abortSignal: abortController.signal },
  ).fetchAll();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const { resources } = await Promise.race([
      queryPromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          abortController.abort();
          reject(new Error("photoLocations list hydration timed out"));
        }, timeoutMs);
      }),
    ]);
    return resources;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function hydrateListedPhotoLocations<TPhoto extends HydratablePhoto>(
  sources: readonly ListedPhotoLocationSource<TPhoto>[],
  rows: readonly IndexedPhotoLocationRow[],
): PhotoLocationHydrationDiagnostics {
  const diagnostics: PhotoLocationHydrationDiagnostics = {
    hydrated: 0,
    orphanedOrOutOfScope: 0,
    invalidCoordinates: 0,
    staleSource: 0,
    blobMetadataAuthoritative: 0,
    ambiguousRows: 0,
  };
  const sourcesByName = new Map(sources.map((source) => [source.photo.name, source]));
  const matchingRowsByName = new Map<string, number>();
  const namesWithVersionedRows = new Set<string>();
  for (const row of rows) {
    const identifier = locationIdentifier(row);
    const source = identifier ? sourcesByName.get(identifier) : undefined;
    if (identifier && source && row.scope === source.scope) {
      matchingRowsByName.set(identifier, (matchingRowsByName.get(identifier) ?? 0) + 1);
    }
    if (row.sourceBlobEtag !== undefined) {
      for (const candidate of locationIdentifierCandidates(row)) {
        const candidateSource = sourcesByName.get(candidate);
        if (candidateSource && row.scope === candidateSource.scope) {
          namesWithVersionedRows.add(candidate);
        }
      }
    }
  }

  for (const row of rows) {
    const identifier = locationIdentifier(row);
    const source = identifier ? sourcesByName.get(identifier) : undefined;
    if (!identifier || !source || row.scope !== source.scope) {
      diagnostics.orphanedOrOutOfScope += 1;
      continue;
    }
    if ((matchingRowsByName.get(identifier) ?? 0) > 1) {
      diagnostics.ambiguousRows += 1;
      continue;
    }
    if (source.hasGpsMetadata) {
      diagnostics.blobMetadataAuthoritative += 1;
      continue;
    }
    if (namesWithVersionedRows.has(identifier) && (
      typeof row.sourceBlobEtag !== "string"
      || !source.blobEtag
      || row.sourceBlobEtag !== source.blobEtag
    )) {
      diagnostics.staleSource += 1;
      continue;
    }
    const lat = parseFiniteCoordinate(
      typeof row.lat === "number" ? String(row.lat) : undefined,
      -90,
      90,
    );
    const lon = parseFiniteCoordinate(
      typeof row.lon === "number" ? String(row.lon) : undefined,
      -180,
      180,
    );
    if (lat === null || lon === null) {
      diagnostics.invalidCoordinates += 1;
      continue;
    }
    source.photo.gpsLat = formatCoordinate(lat);
    source.photo.gpsLon = formatCoordinate(lon);
    diagnostics.hydrated += 1;
  }

  return diagnostics;
}
