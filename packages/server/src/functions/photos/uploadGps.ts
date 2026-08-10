export interface ResolvedUploadGps {
  gpsLat: string;
  gpsLon: string;
}

interface ExifGps {
  latitude: number;
  longitude: number;
}

function parseCoordinate(raw: string, min: number, max: number): number | null {
  if (!raw.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
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
    const lat = parseCoordinate(clientLat, -90, 90);
    const lon = parseCoordinate(clientLon, -180, 180);
    return lat === null || lon === null
      ? null
      : { gpsLat: String(lat), gpsLon: String(lon) };
  }

  const exif = await readExifGps();
  if (!exif) return null;
  const lat = parseCoordinate(String(exif.latitude), -90, 90);
  const lon = parseCoordinate(String(exif.longitude), -180, 180);
  return lat === null || lon === null
    ? null
    : { gpsLat: String(lat), gpsLon: String(lon) };
}

export function uploadGpsMetadata(gps: ResolvedUploadGps | null): Record<string, string> {
  return gps ? { gpsLat: gps.gpsLat, gpsLon: gps.gpsLon } : {};
}

export function readGpsMetadata(
  metadata: Record<string, string> | undefined,
): ResolvedUploadGps | null {
  if (!metadata) return null;
  const find = (key: string) => Object.entries(metadata)
    .find(([candidate]) => candidate.toLowerCase() === key.toLowerCase())?.[1] ?? "";
  const gpsLat = find("gpsLat");
  const gpsLon = find("gpsLon");
  const lat = parseCoordinate(gpsLat, -90, 90);
  const lon = parseCoordinate(gpsLon, -180, 180);
  return lat === null || lon === null ? null : { gpsLat: String(lat), gpsLon: String(lon) };
}
