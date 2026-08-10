const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/bmp",
  "image/tiff",
]);

const VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
  "video/mpeg",
  "video/3gpp",
  "video/3gpp2",
]);

const MIME_ALIASES = new Map([
  ["image/jpg", "image/jpeg"],
  ["image/jfif", "image/jpeg"],
  ["image/pjpeg", "image/jpeg"],
  ["image/heic-sequence", "image/heic"],
  ["image/heif-sequence", "image/heif"],
]);

const EXTENSION_MIME = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["jfif", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["heic", "image/heic"],
  ["heif", "image/heif"],
  ["bmp", "image/bmp"],
  ["tif", "image/tiff"],
  ["tiff", "image/tiff"],
  ["mp4", "video/mp4"],
  ["mov", "video/quicktime"],
  ["webm", "video/webm"],
  ["avi", "video/x-msvideo"],
  ["mpeg", "video/mpeg"],
  ["mpg", "video/mpeg"],
  ["3gp", "video/3gpp"],
  ["3g2", "video/3gpp2"],
]);

interface UploadFileLike {
  name: string;
  type: string;
  slice(start?: number, end?: number): Blob;
}

interface ExifGpsLike {
  latitude?: unknown;
  longitude?: unknown;
}

function normalizedDeclaredType(type: string): string | null {
  const normalized = type.split(";")[0].trim().toLowerCase();
  if (!normalized || normalized === "application/octet-stream" || normalized === "binary/octet-stream") {
    return null;
  }
  const canonical = MIME_ALIASES.get(normalized) ?? normalized;
  return IMAGE_MIME_TYPES.has(canonical) || VIDEO_MIME_TYPES.has(canonical)
    ? canonical
    : null;
}

function typeFromExtension(name: string): string | null {
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return extension ? (EXTENSION_MIME.get(extension) ?? null) : null;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function typeFromSignature(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brands = [ascii(bytes, 8, 4)];
    for (let offset = 16; offset + 4 <= Math.min(bytes.length, 64); offset += 4) {
      brands.push(ascii(bytes, offset, 4));
    }
    if (brands.some((brand) => ["heic", "heix", "hevc", "hevx"].includes(brand))) {
      return "image/heic";
    }
    if (brands.some((brand) => ["heif", "mif1", "msf1"].includes(brand))) {
      return "image/heif";
    }
  }
  return null;
}

export async function detectUploadMediaType(file: UploadFileLike): Promise<string | null> {
  const declared = normalizedDeclaredType(file.type);
  if (declared) return declared;

  const header = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const detected = typeFromSignature(header);
  if (detected) return detected;

  const normalized = file.type.split(";")[0].trim().toLowerCase();
  if (normalized.startsWith("audio/")) return null;
  return typeFromExtension(file.name);
}

export function isImageUploadType(type: string | null): boolean {
  return type !== null && IMAGE_MIME_TYPES.has(type);
}

export function isVideoUploadType(type: string | null): boolean {
  return type !== null && VIDEO_MIME_TYPES.has(type);
}

export function normalizeExifGps(value: ExifGpsLike | null | undefined): {
  gpsLat: string;
  gpsLon: string;
} | null {
  if (!value) return null;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (
    !Number.isFinite(latitude)
    || latitude < -90
    || latitude > 90
    || !Number.isFinite(longitude)
    || longitude < -180
    || longitude > 180
  ) {
    return null;
  }
  return { gpsLat: String(latitude), gpsLon: String(longitude) };
}

export function mergeUploadedPhoto<T extends { name: string }>(
  previous: T[],
  uploaded: T,
): T[] {
  let replaced = false;
  const merged = previous.map((photo) => {
    if (photo.name !== uploaded.name) return photo;
    replaced = true;
    return uploaded;
  });
  return replaced ? merged : [...merged, uploaded];
}
