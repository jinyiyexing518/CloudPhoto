export interface GpsCoordinates {
  lat: number;
  lon: number;
}

export type GpsCoordinateClassification =
  | { kind: "both-finite"; coordinates: GpsCoordinates }
  | { kind: "latitude-only"; latitude: number }
  | { kind: "longitude-only"; longitude: number }
  | { kind: "neither-or-invalid" };

export function parseFiniteCoordinate(
  raw: string | null | undefined,
  min: number,
  max: number,
): number | null {
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

export function classifyGpsCoordinates(
  rawLat: string | null | undefined,
  rawLon: string | null | undefined,
): GpsCoordinateClassification {
  const hasLat = rawLat != null && rawLat.trim() !== "";
  const hasLon = rawLon != null && rawLon.trim() !== "";
  const lat = parseFiniteCoordinate(rawLat, -90, 90);
  const lon = parseFiniteCoordinate(rawLon, -180, 180);
  if (lat !== null && lon !== null) {
    return { kind: "both-finite", coordinates: { lat, lon } };
  }
  if (lat !== null && !hasLon) return { kind: "latitude-only", latitude: lat };
  if (lon !== null && !hasLat) return { kind: "longitude-only", longitude: lon };
  return { kind: "neither-or-invalid" };
}

export function readGpsCoordinates(
  rawLat: string | null | undefined,
  rawLon: string | null | undefined,
): GpsCoordinates | null {
  const classification = classifyGpsCoordinates(rawLat, rawLon);
  return classification.kind === "both-finite" ? classification.coordinates : null;
}

export function hasValidGps(
  rawLat: string | null | undefined,
  rawLon: string | null | undefined,
): boolean {
  return readGpsCoordinates(rawLat, rawLon) !== null;
}
