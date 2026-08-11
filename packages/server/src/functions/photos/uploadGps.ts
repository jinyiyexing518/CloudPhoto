import exifr from "exifr";
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

function readObjectValue(
  value: unknown,
  key: string,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const matchedKey = Object.keys(record).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return matchedKey ? record[matchedKey] : undefined;
}

function parseXmpCoordinate(
  value: unknown,
  ref: unknown,
  axis: "latitude" | "longitude",
): number | null {
  const min = axis === "latitude" ? -90 : -180;
  const max = axis === "latitude" ? 90 : 180;
  if (typeof value !== "number" && typeof value !== "string") return null;

  const normalized = typeof value === "number"
    ? String(value)
    : value
      .trim()
      .replace(/[°º]/g, ",")
      .replace(/[′']/g, ",")
      .replace(/[″"]/g, "")
      .replace(/\s+/g, "");
  const inlineRef = normalized.match(/[NSEW]$/i)?.[0]?.toUpperCase();
  const externalRef = typeof ref === "string" ? ref.trim().toUpperCase() : "";
  if (inlineRef && externalRef && inlineRef !== externalRef) return null;
  const direction = inlineRef || externalRef;
  if (
    (axis === "latitude" && direction && direction !== "N" && direction !== "S")
    || (axis === "longitude" && direction && direction !== "E" && direction !== "W")
  ) {
    return null;
  }

  const componentText = normalized
    .replace(/[NSEW]$/i, "")
    .split(",");
  if (componentText.some((component) => component === "")) return null;
  const components = componentText.map(Number);
  if (
    components.length < 1
    || components.length > 3
    || components.some((component) => !Number.isFinite(component))
  ) {
    return null;
  }

  let coordinate: number;
  if (components.length === 1) {
    coordinate = components[0];
  } else {
    const [degrees, minutes, seconds = 0] = components;
    if (minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return null;
    coordinate = Math.abs(degrees) + minutes / 60 + seconds / 3600;
    if (degrees < 0) coordinate *= -1;
  }
  if (direction === "S" || direction === "W") coordinate = -Math.abs(coordinate);
  if (direction === "N" || direction === "E") coordinate = Math.abs(coordinate);
  return parseFiniteCoordinate(String(coordinate), min, max);
}

export function parseXmpGps(value: unknown): ExifGps | null {
  const exif = readObjectValue(value, "exif");
  const latitudeValue = readObjectValue(value, "GPSLatitude")
    ?? readObjectValue(exif, "GPSLatitude");
  const longitudeValue = readObjectValue(value, "GPSLongitude")
    ?? readObjectValue(exif, "GPSLongitude");
  const latitude = parseXmpCoordinate(
    latitudeValue,
    readObjectValue(value, "GPSLatitudeRef") ?? readObjectValue(exif, "GPSLatitudeRef"),
    "latitude",
  );
  const longitude = parseXmpCoordinate(
    longitudeValue,
    readObjectValue(value, "GPSLongitudeRef") ?? readObjectValue(exif, "GPSLongitudeRef"),
    "longitude",
  );
  return latitude === null || longitude === null
    ? null
    : { latitude, longitude };
}

export async function readPhotoGps(input: Buffer): Promise<ExifGps | null> {
  try {
    const gps = await exifr.gps(input);
    if (gps) {
      const latitude = parseFiniteCoordinate(String(gps.latitude), -90, 90);
      const longitude = parseFiniteCoordinate(String(gps.longitude), -180, 180);
      if (latitude !== null && longitude !== null) {
        return { latitude, longitude };
      }
    }
  } catch {
    // Continue to the XMP path when the optimized TIFF GPS reader cannot parse the file.
  }

  try {
    const xmp = await exifr.parse(input, {
      xmp: true,
      tiff: false,
      icc: false,
      iptc: false,
      jfif: false,
      mergeOutput: true,
      multiSegment: true,
    });
    return parseXmpGps(xmp);
  } catch {
    return null;
  }
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
    if (lat !== null && lon !== null) {
      return { gpsLat: String(lat), gpsLon: String(lon) };
    }
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
