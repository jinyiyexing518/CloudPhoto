import {
  classifyGpsCoordinates,
  readGpsCoordinates,
  type GpsCoordinates,
} from "../../utils/gpsCoordinates.ts";

interface PhotoWithLocation {
  name: string;
  gpsLat?: string;
  gpsLon?: string;
  blobEtag?: string;
  gpsMetadataPresent?: boolean;
  originalName?: string;
  contentType?: string;
}

interface IndexedPhotoLocation {
  scope?: string;
  name?: string;
  photoName?: string;
  lat: number;
  lon: number;
  sourceBlobEtag?: string;
  originalName?: string;
  contentType?: string;
}

const GPS_COORDINATE_EPSILON = 1e-7;

function locationIdentifier(location: IndexedPhotoLocation): string | null {
  const hasName = location.name !== undefined;
  const hasPhotoName = location.photoName !== undefined;
  const name = typeof location.name === "string" && location.name.length > 0
    ? location.name
    : null;
  const photoName = typeof location.photoName === "string" && location.photoName.length > 0
    ? location.photoName
    : null;
  if ((hasName && !name) || (hasPhotoName && !photoName)) return null;
  if (name && photoName && name !== photoName) return null;
  return name ?? photoName;
}

function locationIdentifierCandidates(location: IndexedPhotoLocation): string[] {
  return [...new Set(
    [location.name, location.photoName]
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  )];
}

function locationMatchesPhotoScope(location: IndexedPhotoLocation, photoName: string): boolean {
  const [namespace, owner] = photoName.split("/");
  if ((namespace !== "personal" && namespace !== "groups") || !owner) return true;
  return location.scope === `${namespace}/${owner}`;
}

export interface LocationPin<TPhoto extends PhotoWithLocation> extends GpsCoordinates {
  name: string;
  originalName?: string;
  contentType?: string;
  photo: TPhoto;
}

export interface LocationPartitionDiagnostics {
  bothFinite: number;
  latitudeOnly: number;
  longitudeOnly: number;
  neitherOrInvalid: number;
  cosmosIntersections: number;
  staleCosmosIntersections: number;
  orphanedCosmos: number;
  invalidCosmos: number;
  ambiguousCosmos: number;
}

export function partitionPhotoLocations<TPhoto extends PhotoWithLocation>(
  photos: readonly TPhoto[],
  cosmosLocations: readonly IndexedPhotoLocation[],
): {
  geoPhotos: LocationPin<TPhoto>[];
  noGpsPhotos: TPhoto[];
  diagnostics: LocationPartitionDiagnostics;
} {
  const diagnostics: LocationPartitionDiagnostics = {
    bothFinite: 0,
    latitudeOnly: 0,
    longitudeOnly: 0,
    neitherOrInvalid: 0,
    cosmosIntersections: 0,
    staleCosmosIntersections: 0,
    orphanedCosmos: 0,
    invalidCosmos: 0,
    ambiguousCosmos: 0,
  };
  const photoMap = new Map(photos.map((photo) => [photo.name, photo]));
  const validPhotoGps = new Map<string, GpsCoordinates>();
  const cosmosRowsByName = new Map<string, number>();
  const namesWithVersionedRows = new Set<string>();
  for (const location of cosmosLocations) {
    const identifier = locationIdentifier(location);
    if (identifier && locationMatchesPhotoScope(location, identifier)) {
      cosmosRowsByName.set(identifier, (cosmosRowsByName.get(identifier) ?? 0) + 1);
    }
    if (location.sourceBlobEtag !== undefined) {
      for (const candidate of locationIdentifierCandidates(location)) {
        if (photoMap.has(candidate) && locationMatchesPhotoScope(location, candidate)) {
          namesWithVersionedRows.add(candidate);
        }
      }
    }
  }

  for (const photo of photos) {
    const classification = classifyGpsCoordinates(photo.gpsLat, photo.gpsLon);
    if (classification.kind === "both-finite") {
      diagnostics.bothFinite += 1;
      validPhotoGps.set(photo.name, classification.coordinates);
    } else if (classification.kind === "latitude-only") {
      diagnostics.latitudeOnly += 1;
    } else if (classification.kind === "longitude-only") {
      diagnostics.longitudeOnly += 1;
    } else {
      diagnostics.neitherOrInvalid += 1;
    }
  }

  const geoPhotos: LocationPin<TPhoto>[] = [];
  const locatedNames = new Set<string>();
  for (const location of cosmosLocations) {
    const identifier = locationIdentifier(location);
    const photo = identifier ? photoMap.get(identifier) : undefined;
    if (!identifier || !photo || !locationMatchesPhotoScope(location, identifier)) {
      diagnostics.orphanedCosmos += 1;
      continue;
    }
    if ((cosmosRowsByName.get(identifier) ?? 0) > 1) {
      diagnostics.ambiguousCosmos += 1;
      continue;
    }
    const indexedGps = readGpsCoordinates(String(location.lat), String(location.lon));
    if (!indexedGps) {
      diagnostics.invalidCosmos += 1;
      continue;
    }
    if (namesWithVersionedRows.has(identifier) && (
      typeof location.sourceBlobEtag !== "string"
      || !photo.blobEtag
      || location.sourceBlobEtag !== photo.blobEtag
    )) {
      diagnostics.staleCosmosIntersections += 1;
      continue;
    }
    const photoGps = validPhotoGps.get(identifier);
    if (photoGps) {
      if (
        Math.abs(indexedGps.lat - photoGps.lat) > GPS_COORDINATE_EPSILON
        || Math.abs(indexedGps.lon - photoGps.lon) > GPS_COORDINATE_EPSILON
      ) {
        diagnostics.staleCosmosIntersections += 1;
        continue;
      }
    } else if (photo.gpsMetadataPresent !== false) {
      diagnostics.staleCosmosIntersections += 1;
      continue;
    }
    if (locatedNames.has(identifier)) continue;
    diagnostics.cosmosIntersections += 1;
    locatedNames.add(identifier);
    geoPhotos.push({
      name: identifier,
      ...indexedGps,
      originalName: location.originalName ?? photo.originalName,
      contentType: location.contentType ?? photo.contentType,
      photo,
    });
  }

  for (const photo of photos) {
    if (locatedNames.has(photo.name)) continue;
    if (photo.gpsMetadataPresent === false) continue;
    const gps = validPhotoGps.get(photo.name);
    if (!gps) continue;
    locatedNames.add(photo.name);
    geoPhotos.push({
      name: photo.name,
      ...gps,
      originalName: photo.originalName,
      contentType: photo.contentType,
      photo,
    });
  }

  return {
    geoPhotos,
    noGpsPhotos: photos.filter((photo) => !locatedNames.has(photo.name)),
    diagnostics,
  };
}
