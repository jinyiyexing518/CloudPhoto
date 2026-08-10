import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  detectUploadMediaType,
  isImageUploadType,
  mergeUploadedPhoto,
  normalizeExifGps,
} from "./uploadLocation.ts";

function fileLike(name, type, bytes) {
  const blob = new Blob([Uint8Array.from(bytes)]);
  return {
    name,
    type,
    slice: (...args) => blob.slice(...args),
  };
}

test("image detection survives missing, generic, and nonstandard browser MIME values", async () => {
  const jpeg = [0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00];
  const heic = [
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x68, 0x65, 0x69, 0x63,
    0x00, 0x00, 0x00, 0x00,
    0x6d, 0x69, 0x66, 0x31,
    0x68, 0x65, 0x69, 0x63,
  ];

  assert.equal(await detectUploadMediaType(fileLike("camera.jpg", "", jpeg)), "image/jpeg");
  assert.equal(
    await detectUploadMediaType(fileLike("camera.bin", "application/octet-stream", jpeg)),
    "image/jpeg",
  );
  assert.equal(
    await detectUploadMediaType(fileLike("camera.heic", "application/octet-stream", heic)),
    "image/heic",
  );
  assert.equal(await detectUploadMediaType(fileLike("camera.jfif", "image/jfif", jpeg)), "image/jpeg");
  assert.equal(await detectUploadMediaType(fileLike("voice.mp4", "audio/mp4", [])), null);
  assert.equal(isImageUploadType("image/heic"), true);
});

test("client EXIF coordinates are accepted only as a complete finite in-range pair", () => {
  assert.deepEqual(
    normalizeExifGps({ latitude: 0, longitude: -180 }),
    { gpsLat: "0", gpsLon: "-180" },
  );
  for (const value of [
    null,
    { latitude: 1 },
    { longitude: 2 },
    { latitude: Number.NaN, longitude: 2 },
    { latitude: 91, longitude: 2 },
    { latitude: 1, longitude: -181 },
  ]) {
    assert.equal(normalizeExifGps(value), null);
  }
});

test("a same-name upload response replaces stale GPS, dates, media URLs, and derivatives", () => {
  const previous = [{
    name: "personal/u/_/photo.jpg",
    url: "old-original",
    thumbnailUrl: "old-thumbnail",
    previewUrl: "old-preview",
    gpsLat: undefined,
    gpsLon: undefined,
    takenAt: "2020-01-01T00:00:00",
    size: 1,
    lastModified: "2020-01-01T00:00:00Z",
    contentType: "image/jpeg",
  }];
  const uploaded = {
    ...previous[0],
    url: "new-original",
    thumbnailUrl: "new-thumbnail",
    previewUrl: "new-preview",
    gpsLat: "31.2304",
    gpsLon: "121.4737",
    takenAt: "2026-08-11T01:02:03",
  };

  assert.deepEqual(mergeUploadedPhoto(previous, uploaded), [uploaded]);
  assert.deepEqual(
    mergeUploadedPhoto(previous, {
      name: previous[0].name,
      url: "new-original-without-optional-metadata",
      size: 2,
      lastModified: "2026-08-11T01:02:03Z",
      contentType: "image/jpeg",
    }),
    [{
      name: previous[0].name,
      url: "new-original-without-optional-metadata",
      size: 2,
      lastModified: "2026-08-11T01:02:03Z",
      contentType: "image/jpeg",
    }],
  );
});

test("the legacy upload flow uses detected media, merges responses, and refreshes the location index", async () => {
  const [app, uploadApi, memoryMap] = await Promise.all([
    readFile(new URL("./AuthenticatedApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("./services/uploadApi.ts", import.meta.url), "utf8"),
    readFile(new URL("./components/memory-map/MemoryMap.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(app, /detectUploadMediaType\(uploadFile\)/);
  assert.match(app, /normalizeExifGps\(await exifrLib\.gps\(uploadFile\)\)/);
  assert.match(app, /mergeUploadedPhoto\(previous, uploadedPhoto\)/);
  assert.match(app, /setLocationIndexRevision\(\(revision\) => revision \+ 1\)/);
  assert.match(uploadApi, /detectUploadMediaType\(file\)/);
  assert.match(memoryMap, /\[groupId, locationIndexRevision, showToast\]/);
});
