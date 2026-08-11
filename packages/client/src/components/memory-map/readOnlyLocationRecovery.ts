import type { Photo } from "../../services/photoApi";
import { readGpsCoordinates } from "../../utils/gpsCoordinates.ts";

export interface ReadOnlyRecoveredLocation {
  name: string;
  gpsLat: string;
  gpsLon: string;
  sourceBlobEtag: string;
}

export function applyReadOnlyLocationRecovery(
  photos: readonly Photo[],
  recoveredLocations: readonly ReadOnlyRecoveredLocation[],
): Photo[] {
  const photosByName = new Map(photos.map((photo) => [photo.name, photo]));
  const accepted = new Map<string, ReadOnlyRecoveredLocation>();
  for (const location of recoveredLocations) {
    const photo = photosByName.get(location.name);
    if (
      photo?.gpsMetadataPresent !== false
      || !photo.blobEtag
      || location.sourceBlobEtag !== photo.blobEtag
      || !readGpsCoordinates(location.gpsLat, location.gpsLon)
    ) {
      continue;
    }
    accepted.set(location.name, location);
  }
  if (accepted.size === 0) return [...photos];
  return photos.map((photo) => {
    const location = accepted.get(photo.name);
    return location
      ? {
          ...photo,
          gpsLat: location.gpsLat,
          gpsLon: location.gpsLon,
          gpsMetadataPresent: true,
        }
      : photo;
  });
}
