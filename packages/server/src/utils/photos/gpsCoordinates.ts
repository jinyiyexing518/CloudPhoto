export interface GpsMetadata {
  gpsLat: string;
  gpsLon: string;
}

export function getMetadataValue(
  metadata: Record<string, string> | undefined,
  key: string,
): string | undefined {
  if (!metadata) return undefined;
  return Object.entries(metadata)
    .find(([candidate]) => candidate.toLowerCase() === key.toLowerCase())?.[1];
}

export function parseFiniteCoordinate(
  raw: string | null | undefined,
  min: number,
  max: number,
): number | null {
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

export function formatCoordinate(value: number): string {
  return String(Number(value.toFixed(8)));
}

export function readGpsMetadata(
  metadata: Record<string, string> | undefined,
): GpsMetadata | null {
  const lat = parseFiniteCoordinate(getMetadataValue(metadata, "gpsLat"), -90, 90);
  const lon = parseFiniteCoordinate(getMetadataValue(metadata, "gpsLon"), -180, 180);
  return lat === null || lon === null
    ? null
    : { gpsLat: formatCoordinate(lat), gpsLon: formatCoordinate(lon) };
}

export function hasGpsMetadataKeys(
  metadata: Record<string, string> | undefined,
): boolean {
  if (!metadata) return false;
  return Object.keys(metadata).some((key) => {
    const normalized = key.toLowerCase();
    return normalized === "gpslat" || normalized === "gpslon";
  });
}

export function setMetadataValue(
  metadata: Record<string, string>,
  key: string,
  value: string,
): void {
  deleteMetadataValue(metadata, key);
  metadata[key] = value;
}

export function deleteMetadataValue(
  metadata: Record<string, string>,
  key: string,
): void {
  for (const existingKey of Object.keys(metadata)) {
    if (existingKey.toLowerCase() === key.toLowerCase()) delete metadata[existingKey];
  }
}

export function setGpsMetadata(
  metadata: Record<string, string>,
  gps: GpsMetadata,
): void {
  setMetadataValue(metadata, "gpsLat", gps.gpsLat);
  setMetadataValue(metadata, "gpsLon", gps.gpsLon);
}

export function deleteGpsMetadata(metadata: Record<string, string>): void {
  deleteMetadataValue(metadata, "gpsLat");
  deleteMetadataValue(metadata, "gpsLon");
}
