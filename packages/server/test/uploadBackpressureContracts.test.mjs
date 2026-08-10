import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/functions/photos/uploadPhoto.ts", import.meta.url),
  "utf8",
);

test("validates declared length and acquires admission before arrayBuffer", () => {
  const lengthCheck = source.indexOf("resolveUploadLengthReservation");
  const admission = source.indexOf("uploadAdmission.tryAcquire");
  const buffering = source.indexOf("request.arrayBuffer()");
  assert.ok(lengthCheck >= 0);
  assert.ok(admission > lengthCheck);
  assert.ok(buffering > admission);
});

test("holds admission through processing and always releases it", () => {
  assert.match(source, /finally\s*\{\s*admission\.lease\.release\(\)/s);
  assert.match(source, /"Retry-After": String\(admission\.retryAfterSeconds\)/);
  assert.match(source, /"Access-Control-Expose-Headers": "Retry-After"/);
});
