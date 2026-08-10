import { inflateSync } from "node:zlib";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const channelsByColorType = new Map([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4],
]);
const bitDepthsByColorType = new Map([
  [0, new Set([1, 2, 4, 8, 16])],
  [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8, 16])],
  [6, new Set([8, 16])],
]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function inspectPng(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error("invalid PNG signature or truncated file");
  }

  let offset = 8;
  let header;
  const imageData = [];
  let ended = false;

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new Error("truncated PNG chunk");
    }

    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > bytes.length) {
      throw new Error(`truncated ${type || "unknown"} chunk`);
    }

    const expectedCrc = bytes.readUInt32BE(dataEnd);
    const actualCrc = crc32(bytes.subarray(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) {
      throw new Error(`${type} chunk CRC mismatch`);
    }

    if (!header && type !== "IHDR") {
      throw new Error("IHDR must be the first PNG chunk");
    }
    if (type === "IHDR") {
      if (header || length !== 13) {
        throw new Error("invalid IHDR chunk");
      }
      const width = bytes.readUInt32BE(dataStart);
      const height = bytes.readUInt32BE(dataStart + 4);
      const bitDepth = bytes[dataStart + 8];
      const colorType = bytes[dataStart + 9];
      const compression = bytes[dataStart + 10];
      const filter = bytes[dataStart + 11];
      const interlace = bytes[dataStart + 12];
      if (
        width < 1
        || height < 1
        || width > 4096
        || height > 4096
        || compression !== 0
        || filter !== 0
        || interlace !== 0
        || !bitDepthsByColorType.get(colorType)?.has(bitDepth)
      ) {
        throw new Error("unsupported or invalid IHDR metadata");
      }
      header = { width, height, bitDepth, colorType };
    } else if (type === "IDAT") {
      if (length > 0) imageData.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (length !== 0 || chunkEnd !== bytes.length) {
        throw new Error("invalid IEND chunk");
      }
      ended = true;
    }

    offset = chunkEnd;
    if (ended) break;
  }

  if (!header || imageData.length === 0 || !ended) {
    throw new Error("PNG must contain IHDR, IDAT, and IEND chunks");
  }

  const channels = channelsByColorType.get(header.colorType);
  const rowBytes = Math.ceil(header.width * channels * header.bitDepth / 8);
  const expectedLength = header.height * (rowBytes + 1);
  let pixels;
  try {
    pixels = inflateSync(Buffer.concat(imageData), { maxOutputLength: expectedLength });
  } catch (error) {
    throw new Error(`invalid PNG image data: ${error.message}`);
  }
  if (pixels.length !== expectedLength) {
    throw new Error("PNG image data has an unexpected length");
  }
  for (let row = 0; row < header.height; row += 1) {
    if (pixels[row * (rowBytes + 1)] > 4) {
      throw new Error("PNG image data uses an invalid row filter");
    }
  }

  return { width: header.width, height: header.height };
}
