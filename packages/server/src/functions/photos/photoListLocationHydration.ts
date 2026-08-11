import type { PhotoLocationDoc } from "../../utils/cosmos/cosmosClient";
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
    query<T>(query: PhotoLocationQuery): {
      fetchAll(): Promise<{ resources: T[] }>;
    };
  };
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
  "SELECT c.id, c.scope, c.name, c.lat, c.lon, c.originalName, c.contentType, c.uploadedAt, c.sourceBlobEtag FROM c";

export async function listAuthorizedPhotoLocationRows(
  container: PhotoLocationQueryContainer,
  access: PhotoLocationAccess,
): Promise<PhotoLocationDoc[]> {
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
  const { resources } = await container.items.query<PhotoLocationDoc>(query).fetchAll();
  return resources;
}

export function hydrateListedPhotoLocations<TPhoto extends HydratablePhoto>(
  sources: readonly ListedPhotoLocationSource<TPhoto>[],
  rows: readonly PhotoLocationDoc[],
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
  for (const row of rows) {
    const source = sourcesByName.get(row.name);
    if (source && row.scope === source.scope) {
      matchingRowsByName.set(row.name, (matchingRowsByName.get(row.name) ?? 0) + 1);
    }
  }

  for (const row of rows) {
    const source = sourcesByName.get(row.name);
    if (!source || row.scope !== source.scope) {
      diagnostics.orphanedOrOutOfScope += 1;
      continue;
    }
    if ((matchingRowsByName.get(row.name) ?? 0) > 1) {
      diagnostics.ambiguousRows += 1;
      continue;
    }
    if (source.hasGpsMetadata) {
      diagnostics.blobMetadataAuthoritative += 1;
      continue;
    }
    if (
      row.sourceBlobEtag !== undefined
      && (!source.blobEtag || row.sourceBlobEtag !== source.blobEtag)
    ) {
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
