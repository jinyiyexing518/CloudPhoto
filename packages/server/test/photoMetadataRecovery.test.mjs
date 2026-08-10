import assert from "node:assert/strict";
import test from "node:test";
import recovery from "../dist/src/functions/photos/photoMetadataRecovery.js";

const {
  GPS_SCAN_VERSION,
  createByteBudget,
  estimateMetadataScanBytes,
  recoveryResultFromError,
  scanPhotoMetadataCandidate,
} = recovery;

function jpegWithGps(latitude = 31.2304, longitude = 121.4737) {
  const tiff = Buffer.alloc(128);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8825, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);

  tiff.writeUInt16LE(4, 26);
  const entry = (offset, tag, type, count, value) => {
    tiff.writeUInt16LE(tag, offset);
    tiff.writeUInt16LE(type, offset + 2);
    tiff.writeUInt32LE(count, offset + 4);
    if (typeof value === "number") tiff.writeUInt32LE(value, offset + 8);
    else value.copy(tiff, offset + 8);
  };
  entry(28, 1, 2, 2, Buffer.from("N\0\0\0"));
  entry(40, 2, 5, 3, 80);
  entry(52, 3, 2, 2, Buffer.from("E\0\0\0"));
  entry(64, 4, 5, 3, 104);
  tiff.writeUInt32LE(0, 76);

  const writeDms = (offset, decimal) => {
    const degrees = Math.floor(decimal);
    const minutesFloat = (decimal - degrees) * 60;
    const minutes = Math.floor(minutesFloat);
    const secondsNumerator = Math.round((minutesFloat - minutes) * 60 * 10_000);
    for (const [index, numerator, denominator] of [
      [0, degrees, 1],
      [1, minutes, 1],
      [2, secondsNumerator, 10_000],
    ]) {
      tiff.writeUInt32LE(numerator, offset + index * 8);
      tiff.writeUInt32LE(denominator, offset + index * 8 + 4);
    }
  };
  writeDms(80, latitude);
  writeDms(104, longitude);

  const payload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
    length,
    payload,
    Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0xff, 0xd9]),
  ]);
}

function candidate(overrides = {}) {
  const bytes = overrides.bytes ?? jpegWithGps();
  const writes = [];
  let reads = 0;
  let syncs = 0;
  return {
    bytes,
    writes,
    get reads() { return reads; },
    get syncs() { return syncs; },
    input: {
      name: "personal/u/photo.jpg",
      contentType: "image/jpeg",
      contentLength: bytes.length,
      etag: "v1",
      metadata: { gpsLat: "NaN", gpsLon: "NaN" },
      budget: createByteBudget(4 * 1024 * 1024),
      async readRange(offset, count) {
        reads += 1;
        return bytes.subarray(offset, Math.min(offset + count, bytes.length));
      },
      async writeMetadata(metadata, etag) {
        writes.push({ metadata, etag });
      },
      async syncLocation() {
        syncs += 1;
      },
      ...overrides,
    },
  };
}

test("recovers literal NaN GPS from a bounded JPEG EXIF prefix", async () => {
  const item = candidate();
  const result = await scanPhotoMetadataCandidate(item.input);

  assert.equal(result.candidates, 1);
  assert.equal(result.recovered, 1);
  assert.equal(result.bytesRead, item.bytes.length);
  assert.equal(item.reads, 1);
  assert.equal(item.syncs, 1);
  assert.equal(item.writes.length, 1);
  assert.equal(item.writes[0].etag, "v1");
  assert.equal(item.writes[0].metadata.gpsLat, "31.2304");
  assert.equal(item.writes[0].metadata.gpsLon, "121.4737");
  assert.equal(item.writes[0].metadata.gpsScanVersion, GPS_SCAN_VERSION);
});

test("cleans both invalid GPS keys only after a complete no-EXIF scan", async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0xff, 0xd9]);
  const item = candidate({ bytes });
  const result = await scanPhotoMetadataCandidate(item.input);

  assert.equal(result.cleanedInvalid, 1);
  assert.equal(result.trulyMissing, 1);
  assert.equal("gpsLat" in item.writes[0].metadata, false);
  assert.equal("gpsLon" in item.writes[0].metadata, false);
  assert.equal(item.writes[0].metadata.gpsScanVersion, GPS_SCAN_VERSION);
  assert.equal(item.syncs, 1);
});

test("invalid, out-of-range, and partial pairs are all recovery candidates", async () => {
  for (const metadata of [
    { gpsLat: "NaN", gpsLon: "NaN" },
    { gpsLat: "91", gpsLon: "0" },
    { gpsLat: "10" },
    { gpsLon: "20" },
  ]) {
    const item = candidate({ metadata });
    const result = await scanPhotoMetadataCandidate(item.input);
    assert.equal(result.candidates, 1, JSON.stringify(metadata));
    assert.equal(result.recovered, 1, JSON.stringify(metadata));
  }
});

test("valid GPS is never downloaded but still reconciles the location index", async () => {
  const item = candidate({
    metadata: { gpsLat: "31", gpsLon: "121", metadataScanVersion: "1" },
  });
  const result = await scanPhotoMetadataCandidate(item.input);

  assert.equal(result.candidates, 0);
  assert.equal(result.bytesRead, 0);
  assert.equal(item.reads, 0);
  assert.equal(item.writes.length, 0);
  assert.equal(item.syncs, 1);
  assert.equal(result.indexReconciled, 1);
});

test("dry-run estimates candidates without body reads, writes, or index mutations", async () => {
  const item = candidate({ dryRun: true });
  const result = await scanPhotoMetadataCandidate(item.input);

  assert.equal(result.candidates, 1);
  assert.equal(result.estimatedBytes, estimateMetadataScanBytes("image/jpeg", item.bytes.length));
  assert.equal(result.bytesRead, 0);
  assert.equal(item.reads, 0);
  assert.equal(item.writes.length, 0);
  assert.equal(item.syncs, 0);
});

test("page budget skips an expandable HEIC scan without marking it complete, then permits retry", async () => {
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  const first = candidate({
    bytes,
    contentType: "image/heic",
    contentLength: bytes.length,
    budget: createByteBudget(512 * 1024),
  });
  const skipped = await scanPhotoMetadataCandidate(first.input);
  assert.equal(skipped.skippedBudget, 1);
  assert.equal(skipped.retryCurrent, 1);
  assert.equal(first.reads, 0);
  assert.equal(first.writes.length, 0);
  assert.equal(first.syncs, 0);

  const retry = candidate({
    bytes,
    contentType: "image/heic",
    contentLength: bytes.length,
    budget: createByteBudget(4 * 1024 * 1024),
  });
  await scanPhotoMetadataCandidate(retry.input);
  assert.ok(retry.reads > 0);
  assert.equal(retry.writes.length, 1);
});

test("ETag races never retry stale EXIF metadata onto a replaced Blob", async () => {
  let writes = 0;
  const item = candidate({
    async writeMetadata() {
      writes += 1;
      throw Object.assign(new Error("condition not met"), { statusCode: 412 });
    },
  });

  let failure;
  await assert.rejects(
    scanPhotoMetadataCandidate(item.input).catch((error) => {
      failure = error;
      throw error;
    }),
    /condition not met/,
  );
  assert.equal(writes, 1);
  assert.equal(item.syncs, 0);
  const partial = recoveryResultFromError(failure);
  assert.equal(partial.candidates, 1);
  assert.equal(partial.bytesRead, item.bytes.length);
  assert.equal(partial.recovered, 0);
});

test("valid GPS bypasses body reads even when legacy takenAt markers are absent", async () => {
  const item = candidate({ metadata: { gpsLat: "31", gpsLon: "121" } });
  const result = await scanPhotoMetadataCandidate(item.input);

  assert.equal(result.candidates, 0);
  assert.equal(item.reads, 0);
  assert.equal(item.writes.length, 0);
  assert.equal(item.syncs, 1);
});

test("a short range read is incomplete and cannot clean or mark GPS", async () => {
  const item = candidate({
    contentLength: 1024,
    async readRange() {
      return Buffer.from([0xff, 0xd8]);
    },
  });
  const result = await scanPhotoMetadataCandidate(item.input);

  assert.equal(result.skippedBudget, 1);
  assert.equal(result.retryCurrent, 0);
  assert.equal(result.trulyMissing, 0);
  assert.equal(item.writes.length, 0);
  assert.equal(item.syncs, 0);
});

test("deleted photos and non-images are skipped without reads or index work", async () => {
  for (const overrides of [
    { metadata: { deletedAt: "now", gpsLat: "NaN", gpsLon: "NaN" } },
    { contentType: "video/mp4" },
  ]) {
    const item = candidate(overrides);
    const result = await scanPhotoMetadataCandidate(item.input);
    assert.equal(result.candidates, 0);
    assert.equal(item.reads, 0);
    assert.equal(item.writes.length, 0);
    assert.equal(item.syncs, 0);
  }
});
