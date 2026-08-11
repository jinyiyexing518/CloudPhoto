interface PhotoGpsState {
  name: string;
  gpsLat?: string;
  gpsLon?: string;
  gpsMetadataPresent?: boolean;
}

export function applyAuthoritativeGpsUpdate<TPhoto extends PhotoGpsState>(
  photos: readonly TPhoto[],
  name: string,
  gpsLat: string,
  gpsLon: string,
): TPhoto[] {
  return photos.map((photo) => (
    photo.name === name
      ? { ...photo, gpsLat, gpsLon, gpsMetadataPresent: true }
      : photo
  ));
}
