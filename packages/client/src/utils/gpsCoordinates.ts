export interface GpsCoordinates {
  lat: number;
  lon: number;
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

export function readGpsCoordinates(
  rawLat: string | null | undefined,
  rawLon: string | null | undefined,
): GpsCoordinates | null {
  const lat = parseFiniteCoordinate(rawLat, -90, 90);
  const lon = parseFiniteCoordinate(rawLon, -180, 180);
  return lat === null || lon === null ? null : { lat, lon };
}

export function hasValidGps(
  rawLat: string | null | undefined,
  rawLon: string | null | undefined,
): boolean {
  return readGpsCoordinates(rawLat, rawLon) !== null;
}
