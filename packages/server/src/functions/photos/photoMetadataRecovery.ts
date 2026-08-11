import exifr from "exifr";
import {
  deleteGpsMetadata,
  formatCoordinate,
  getMetadataValue,
  hasGpsMetadataKeys,
  parseFiniteCoordinate,
  readGpsMetadata,
  setGpsMetadata,
  setMetadataValue,
} from "../../utils/photos/gpsCoordinates";
import { readPhotoGps } from "./uploadGps";

export const GPS_SCAN_VERSION = "3";
export const METADATA_SCAN_VERSION = "1";

const IMAGE_SCAN_LIMITS: Record<string, { initialBytes: number; maxBytes: number }> = {
  "image/jpeg": { initialBytes: 128 * 1024, maxBytes: 2 * 1024 * 1024 },
  "image/jpg": { initialBytes: 128 * 1024, maxBytes: 2 * 1024 * 1024 },
  "image/png": { initialBytes: 256 * 1024, maxBytes: 2 * 1024 * 1024 },
  "image/gif": { initialBytes: 256 * 1024, maxBytes: 2 * 1024 * 1024 },
  "image/webp": { initialBytes: 256 * 1024, maxBytes: 2 * 1024 * 1024 },
  "image/bmp": { initialBytes: 256 * 1024, maxBytes: 2 * 1024 * 1024 },
  "image/heic": { initialBytes: 1024 * 1024, maxBytes: 8 * 1024 * 1024 },
  "image/heif": { initialBytes: 1024 * 1024, maxBytes: 8 * 1024 * 1024 },
  "image/tiff": { initialBytes: 1024 * 1024, maxBytes: 8 * 1024 * 1024 },
};

export interface ByteBudget {
  readonly limit: number;
  used: number;
}

export interface PhotoMetadataRecoveryResult {
  candidates: number;
  estimatedBytes: number;
  bytesRead: number;
  recovered: number;
  cleanedInvalid: number;
  trulyMissing: number;
  skippedBudget: number;
  indexReconciled: number;
  failed: number;
  metadataUpdated: number;
  retryCurrent: number;
}

export interface PhotoMetadataRecoveryInput {
  name: string;
  contentType: string;
  contentLength: number;
  etag: string;
  metadata: Record<string, string>;
  budget: ByteBudget;
  dryRun?: boolean;
  signal?: AbortSignal;
  readRange: (offset: number, count: number, signal?: AbortSignal) => Promise<Buffer>;
  writeMetadata: (
    metadata: Record<string, string>,
    etag: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  syncLocation: (signal?: AbortSignal) => Promise<void>;
}

export class PhotoMetadataRecoveryError extends Error {
  readonly result: PhotoMetadataRecoveryResult;
  readonly originalError: unknown;

  constructor(error: unknown, result: PhotoMetadataRecoveryResult) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "PhotoMetadataRecoveryError";
    this.result = { ...result };
    this.originalError = error;
  }
}

export function recoveryResultFromError(
  error: unknown,
): PhotoMetadataRecoveryResult | null {
  return error instanceof PhotoMetadataRecoveryError ? error.result : null;
}

interface ExtractedMetadata {
  gps?: { gpsLat: string; gpsLon: string };
  takenAt?: string;
}

interface EmbeddedPhotoGps {
  latitude: number;
  longitude: number;
}

interface EmbeddedPhotoGpsInput {
  name: string;
  contentType: string;
  contentLength: number;
  budget: ByteBudget;
  signal?: AbortSignal;
  readRange: (offset: number, count: number, signal?: AbortSignal) => Promise<Buffer>;
}

export class EmbeddedPhotoGpsBudgetError extends Error {
  constructor() {
    super("Embedded photo GPS scan exceeded the read-only byte budget");
    this.name = "EmbeddedPhotoGpsBudgetError";
  }
}

export function createByteBudget(limit: number): ByteBudget {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid metadata byte budget");
  return { limit, used: 0 };
}

export function isRecoverableImageMime(contentType: string): boolean {
  return Object.prototype.hasOwnProperty.call(IMAGE_SCAN_LIMITS, contentType.toLowerCase());
}

export function estimateMetadataScanBytes(contentType: string, contentLength: number): number {
  const limits = IMAGE_SCAN_LIMITS[contentType.toLowerCase()];
  if (!limits || !Number.isFinite(contentLength) || contentLength <= 0) return 0;
  return Math.min(Math.trunc(contentLength), limits.maxBytes);
}

function emptyResult(): PhotoMetadataRecoveryResult {
  return {
    candidates: 0,
    estimatedBytes: 0,
    bytesRead: 0,
    recovered: 0,
    cleanedInvalid: 0,
    trulyMissing: 0,
    skippedBudget: 0,
    indexReconciled: 0,
    failed: 0,
    metadataUpdated: 0,
    retryCurrent: 0,
  };
}

function jpegMetadataIsComplete(buffer: Buffer): boolean {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return false;
  let offset = 2;
  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xff) return false;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return false;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) return true;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return false;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return false;
    offset += segmentLength;
  }
  return false;
}

function metadataScanIsComplete(
  contentType: string,
  buffer: Buffer,
  contentLength: number,
): boolean {
  const mime = contentType.toLowerCase();
  if (mime === "image/jpeg" || mime === "image/jpg") return jpegMetadataIsComplete(buffer);
  return buffer.length >= contentLength;
}

function formatExifDate(value: unknown): string | undefined {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return undefined;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
}

async function extractMetadata(buffer: Buffer): Promise<ExtractedMetadata> {
  const result: ExtractedMetadata = {};
  try {
    const gps = await readPhotoGps(buffer);
    const lat = parseFiniteCoordinate(String(gps?.latitude ?? ""), -90, 90);
    const lon = parseFiniteCoordinate(String(gps?.longitude ?? ""), -180, 180);
    if (lat !== null && lon !== null) {
      result.gps = { gpsLat: formatCoordinate(lat), gpsLon: formatCoordinate(lon) };
    }
  } catch {
    // A truncated prefix is expanded below; a complete no-EXIF scan is handled explicitly.
  }
  try {
    const parsed = await exifr.parse(buffer, ["DateTimeOriginal", "CreateDate", "DateTime"]);
    result.takenAt = formatExifDate(
      parsed?.DateTimeOriginal ?? parsed?.CreateDate ?? parsed?.DateTime,
    );
  } catch {
    // See GPS handling above.
  }
  return result;
}

export async function readEmbeddedPhotoGps(
  input: EmbeddedPhotoGpsInput,
): Promise<EmbeddedPhotoGps | null> {
  const contentType = input.contentType.toLowerCase();
  const limits = IMAGE_SCAN_LIMITS[contentType];
  if (!limits || input.contentLength <= 0) return null;

  let targetBytes = Math.min(input.contentLength, limits.initialBytes);
  let buffer = Buffer.alloc(0);
  while (targetBytes > buffer.length) {
    input.signal?.throwIfAborted();
    const requestBytes = targetBytes - buffer.length;
    if (requestBytes > input.budget.limit - input.budget.used) {
      throw new EmbeddedPhotoGpsBudgetError();
    }
    input.budget.used += requestBytes;
    let chunk: Buffer;
    try {
      chunk = await input.readRange(buffer.length, requestBytes, input.signal);
    } catch (error) {
      input.budget.used -= requestBytes;
      throw error;
    }
    if (chunk.length > requestBytes) {
      throw new Error(`Range read exceeded its bound: ${input.name}`);
    }
    input.budget.used -= requestBytes - chunk.length;
    buffer = Buffer.concat([buffer, chunk]);
    const gps = await readPhotoGps(buffer);
    if (gps) return gps;
    if (
      chunk.length < requestBytes
      || metadataScanIsComplete(contentType, buffer, input.contentLength)
      || buffer.length >= input.contentLength
      || targetBytes >= Math.min(input.contentLength, limits.maxBytes)
    ) {
      return null;
    }
    targetBytes = Math.min(input.contentLength, limits.maxBytes, targetBytes * 2);
  }
  return null;
}

async function reconcile(
  input: PhotoMetadataRecoveryInput,
  result: PhotoMetadataRecoveryResult,
): Promise<void> {
  await input.syncLocation(input.signal);
  result.indexReconciled += 1;
}

export async function scanPhotoMetadataCandidate(
  input: PhotoMetadataRecoveryInput,
): Promise<PhotoMetadataRecoveryResult> {
  const result = emptyResult();
  input.signal?.throwIfAborted();
  const contentType = input.contentType.toLowerCase();
  if (
    !isRecoverableImageMime(contentType)
    || Boolean(getMetadataValue(input.metadata, "deletedAt"))
  ) {
    return result;
  }

  const existingGps = readGpsMetadata(input.metadata);
  const needsGpsScan = (
    existingGps === null
    && getMetadataValue(input.metadata, "gpsScanVersion") !== GPS_SCAN_VERSION
  );
  const needsTakenAtScan = (
    needsGpsScan
    &&
    !getMetadataValue(input.metadata, "takenAt")
    && getMetadataValue(input.metadata, "metadataScanVersion") !== METADATA_SCAN_VERSION
  );
  const isCandidate = needsGpsScan;
  if (!isCandidate) {
    if (!input.dryRun) await reconcile(input, result);
    return result;
  }

  result.candidates = 1;
  result.estimatedBytes = estimateMetadataScanBytes(contentType, input.contentLength);
  if (input.dryRun) return result;

  try {
    const limits = IMAGE_SCAN_LIMITS[contentType];
    let targetBytes = Math.min(input.contentLength, limits.initialBytes);
    let buffer = Buffer.alloc(0);
    let extracted: ExtractedMetadata = {};
    let complete = input.contentLength === 0;
    let incomplete = false;
    let pageBudgetExhausted = false;

    while (targetBytes > buffer.length) {
      input.signal?.throwIfAborted();
      const requestBytes = targetBytes - buffer.length;
      if (requestBytes > input.budget.limit - input.budget.used) {
        incomplete = true;
        pageBudgetExhausted = true;
        break;
      }
      const chunk = await input.readRange(buffer.length, requestBytes, input.signal);
      if (chunk.length > requestBytes) throw new Error(`Range read exceeded its bound: ${input.name}`);
      input.budget.used += chunk.length;
      result.bytesRead += chunk.length;
      buffer = Buffer.concat([buffer, chunk]);
      extracted = await extractMetadata(buffer);
      complete = metadataScanIsComplete(contentType, buffer, input.contentLength);

      const gpsDone = Boolean(extracted.gps) || complete;
      const takenAtDone = !needsTakenAtScan || Boolean(extracted.takenAt) || complete;
      if (gpsDone && takenAtDone) break;
      if (chunk.length < requestBytes) {
        complete = buffer.length >= input.contentLength;
        incomplete = !complete;
        break;
      }
      if (buffer.length >= input.contentLength) {
        complete = true;
        break;
      }
      if (targetBytes >= Math.min(input.contentLength, limits.maxBytes)) {
        incomplete = !complete;
        break;
      }
      targetBytes = Math.min(input.contentLength, limits.maxBytes, targetBytes * 2);
    }

    if (incomplete) {
      result.skippedBudget += 1;
      if (pageBudgetExhausted) result.retryCurrent = 1;
      return result;
    }

    const latestMetadata = { ...input.metadata };
    let changed = false;
    let recovered = false;
    let cleanedInvalid = false;
    let trulyMissing = false;
    if (needsTakenAtScan && extracted.takenAt) {
      setMetadataValue(latestMetadata, "takenAt", extracted.takenAt);
      changed = true;
    }
    if (needsTakenAtScan && (extracted.takenAt || complete)) {
      setMetadataValue(latestMetadata, "metadataScanVersion", METADATA_SCAN_VERSION);
      changed = true;
    }
    if (extracted.gps) {
      setGpsMetadata(latestMetadata, extracted.gps);
      setMetadataValue(latestMetadata, "gpsScanVersion", GPS_SCAN_VERSION);
      recovered = true;
      changed = true;
    } else if (complete) {
      if (hasGpsMetadataKeys(latestMetadata)) {
        deleteGpsMetadata(latestMetadata);
        cleanedInvalid = true;
      }
      setMetadataValue(latestMetadata, "gpsScanVersion", GPS_SCAN_VERSION);
      trulyMissing = true;
      changed = true;
    }

    if (changed) {
      await input.writeMetadata(latestMetadata, input.etag, input.signal);
      result.metadataUpdated += 1;
      if (recovered) result.recovered += 1;
      if (cleanedInvalid) result.cleanedInvalid += 1;
      if (trulyMissing) result.trulyMissing += 1;
    }
    await reconcile(input, result);
    return result;
  } catch (error) {
    throw new PhotoMetadataRecoveryError(error, result);
  }
}
