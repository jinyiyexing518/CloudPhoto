import {
  classifyGpsCoordinates,
  readGpsCoordinates,
  type GpsCoordinates,
} from "../../utils/gpsCoordinates.ts";

interface PhotoWithLocation {
  name: string;
  gpsLat?: string;
  gpsLon?: string;
  originalName?: string;
  contentType?: string;
}

interface IndexedPhotoLocation {
  name: string;
  lat: number;
  lon: number;
  originalName?: string;
  contentType?: string;
}

const GPS_COORDINATE_EPSILON = 1e-7;

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
  };
  const photoMap = new Map(photos.map((photo) => [photo.name, photo]));
  const validPhotoGps = new Map<string, GpsCoordinates>();

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
    const photo = photoMap.get(location.name);
    if (!photo) {
      diagnostics.orphanedCosmos += 1;
      continue;
    }
    const photoGps = validPhotoGps.get(location.name);
    if (!photoGps) {
      diagnostics.staleCosmosIntersections += 1;
      continue;
    }
    const indexedGps = readGpsCoordinates(String(location.lat), String(location.lon));
    if (!indexedGps) {
      diagnostics.invalidCosmos += 1;
      continue;
    }
    if (
      Math.abs(indexedGps.lat - photoGps.lat) > GPS_COORDINATE_EPSILON
      || Math.abs(indexedGps.lon - photoGps.lon) > GPS_COORDINATE_EPSILON
    ) {
      diagnostics.staleCosmosIntersections += 1;
      continue;
    }
    if (locatedNames.has(location.name)) continue;
    diagnostics.cosmosIntersections += 1;
    locatedNames.add(location.name);
    geoPhotos.push({
      name: location.name,
      ...indexedGps,
      originalName: location.originalName ?? photo.originalName,
      contentType: location.contentType ?? photo.contentType,
      photo,
    });
  }

  for (const photo of photos) {
    if (locatedNames.has(photo.name)) continue;
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
    noGpsPhotos: photos.filter((photo) => !validPhotoGps.has(photo.name)),
    diagnostics,
  };
}
