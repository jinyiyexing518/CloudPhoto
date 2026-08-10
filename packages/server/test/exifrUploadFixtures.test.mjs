import assert from "node:assert/strict";
import { File } from "node:buffer";
import test from "node:test";
import exifr from "exifr";
import {
  createGpsHeic,
  createGpsJpeg,
} from "./fixtures/exifGpsFixtures.mjs";

class TestFileReader {
  result = null;
  error = null;
  onerror = null;
  onloadend = null;

  readAsArrayBuffer(blob) {
    void blob.arrayBuffer().then(
      (result) => {
        this.result = result;
        this.onloadend?.();
      },
      (error) => {
        this.error = error;
        this.onerror?.();
        this.onloadend?.();
      },
    );
  }
}

globalThis.FileReader = TestFileReader;

function assertExpectedGps(gps) {
  assert.ok(gps);
  assert.ok(Math.abs(gps.latitude - 31.2304) < 0.000001);
  assert.ok(Math.abs(gps.longitude - 121.4737) < 0.000001);
}

test("exifr reads the generated JPEG GPS fixture from a browser File", async () => {
  const file = new File([createGpsJpeg()], "camera.jpg", { type: "" });
  assertExpectedGps(await exifr.gps(file));
});

test("exifr reads the generated iPhone-style HEIC GPS item from a generic browser File", async () => {
  const file = new File(
    [createGpsHeic()],
    "camera.heic",
    { type: "application/octet-stream" },
  );
  assertExpectedGps(await exifr.gps(file));
});

test("the server exifr path reads the same generated HEIC bytes from a Buffer", async () => {
  assertExpectedGps(await exifr.gps(createGpsHeic()));
});
