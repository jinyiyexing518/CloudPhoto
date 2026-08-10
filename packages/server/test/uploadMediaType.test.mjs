import assert from "node:assert/strict";
import test from "node:test";
import uploadMediaType from "../dist/src/functions/photos/uploadMediaType.js";

const { resolveUploadMediaType } = uploadMediaType;

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00]);
const heic = Buffer.from([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x68, 0x65, 0x69, 0x63,
  0x00, 0x00, 0x00, 0x00,
  0x6d, 0x69, 0x66, 0x31,
  0x68, 0x65, 0x69, 0x63,
]);

test("legacy uploads infer JPEG and HEIC from extension or bounded signatures", () => {
  assert.equal(resolveUploadMediaType("", "camera.jpg"), "image/jpeg");
  assert.equal(resolveUploadMediaType("application/octet-stream", "camera.bin", jpeg), "image/jpeg");
  assert.equal(resolveUploadMediaType("binary/octet-stream", "camera.heic", heic), "image/heic");
  assert.equal(resolveUploadMediaType("image/jfif", "camera.jfif", jpeg), "image/jpeg");
  assert.equal(resolveUploadMediaType("application/octet-stream", "camera.bin"), null);
});

test("a known media MIME remains authoritative", () => {
  assert.equal(resolveUploadMediaType("image/png", "camera.jpg", jpeg), "image/png");
  assert.equal(resolveUploadMediaType("video/quicktime", "clip.mov"), "video/quicktime");
});
