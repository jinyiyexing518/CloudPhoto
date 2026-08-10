import {
  parseFiniteCoordinate,
  readGpsMetadata,
} from "../../utils/photos/gpsCoordinates";

export interface ResolvedUploadGps {
  gpsLat: string;
  gpsLon: string;
}

interface ExifGps {
  latitude: number;
  longitude: number;
}

export function buildUploadGpsQuery(gps: ExifGps | null): URLSearchParams {
  const query = new URLSearchParams();
  if (!gps) return query;
  query.set("gpsLat", String(gps.latitude));
  query.set("gpsLon", String(gps.longitude));
  return query;
}

export async function resolveUploadGps(
  clientLat: string,
  clientLon: string,
  readExifGps: () => Promise<ExifGps | null | undefined>,
): Promise<ResolvedUploadGps | null> {
  const hasClientLat = clientLat.trim() !== "";
  const hasClientLon = clientLon.trim() !== "";
  if (hasClientLat && hasClientLon) {
    const lat = parseFiniteCoordinate(clientLat, -90, 90);
    const lon = parseFiniteCoordinate(clientLon, -180, 180);
    return lat === null || lon === null
      ? null
      : { gpsLat: String(lat), gpsLon: String(lon) };
  }

  const exif = await readExifGps();
  if (!exif) return null;
  const lat = parseFiniteCoordinate(String(exif.latitude), -90, 90);
  const lon = parseFiniteCoordinate(String(exif.longitude), -180, 180);
  return lat === null || lon === null
    ? null
    : { gpsLat: String(lat), gpsLon: String(lon) };
}

export function uploadGpsMetadata(gps: ResolvedUploadGps | null): Record<string, string> {
  return gps ? { gpsLat: gps.gpsLat, gpsLon: gps.gpsLon } : {};
}

export { readGpsMetadata };
