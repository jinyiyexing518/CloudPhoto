const MIME_ALIASES = new Map([
  ["image/jpg", "image/jpeg"],
  ["image/jfif", "image/jpeg"],
  ["image/pjpeg", "image/jpeg"],
  ["image/heic-sequence", "image/heic"],
  ["image/heif-sequence", "image/heif"],
]);

const KNOWN_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/bmp",
  "image/tiff",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
  "video/mpeg",
  "video/3gpp",
  "video/3gpp2",
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/wav",
  "audio/mpeg",
  "audio/aac",
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

export function isGenericUploadMimeType(contentType: string): boolean {
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  return normalized === ""
    || normalized === "application/octet-stream"
    || normalized === "binary/octet-stream";
}

function typeFromExtension(filename: string): string | null {
  const extension = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return extension ? (EXTENSION_MIME.get(extension) ?? null) : null;
}

function ascii(bytes: Buffer, start: number, length: number): string {
  return bytes.subarray(start, start + length).toString("ascii");
}

function typeFromSignature(bytes: Buffer): string | null {
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

export function resolveUploadMediaType(
  contentType: string,
  filename: string,
  bytes?: Buffer,
): string | null {
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  const declared = MIME_ALIASES.get(normalized) ?? normalized;
  if (KNOWN_MIME.has(declared)) return declared;
  return (bytes ? typeFromSignature(bytes) : null) ?? typeFromExtension(filename);
}

export default {
  isGenericUploadMimeType,
  resolveUploadMediaType,
};
