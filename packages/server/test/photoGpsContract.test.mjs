import assert from "node:assert/strict";
import test from "node:test";
import uploadGps from "../dist/src/functions/photos/uploadGps.js";

const {
  buildUploadGpsQuery,
  resolveUploadGps,
  uploadGpsMetadata,
  readGpsMetadata,
} = uploadGps;

test("preserves client GPS including zero through query, Blob metadata, response, and listing", async () => {
  const query = buildUploadGpsQuery({ latitude: 0, longitude: -73.9857 });
  assert.equal(query.get("gpsLat"), "0");
  assert.equal(query.get("gpsLon"), "-73.9857");

  const resolved = await resolveUploadGps("0", "-73.9857", async () => {
    throw new Error("client coordinates must not fall back to EXIF");
  });
  const metadata = uploadGpsMetadata(resolved);
  assert.deepEqual(metadata, { gpsLat: "0", gpsLon: "-73.9857" });
  assert.deepEqual(readGpsMetadata(metadata), resolved);
});

test("falls back to server EXIF GPS only when the complete client pair is absent", async () => {
  let calls = 0;
  const fallback = async () => {
    calls += 1;
    return { latitude: -33.8688, longitude: 151.2093 };
  };
  assert.deepEqual(
    await resolveUploadGps("", "", fallback),
    { gpsLat: "-33.8688", gpsLon: "151.2093" },
  );
  assert.equal(calls, 1);
  assert.deepEqual(await resolveUploadGps("12", "", fallback), {
    gpsLat: "-33.8688",
    gpsLon: "151.2093",
  });
  assert.equal(calls, 2);
});

test("rejects invalid client coordinates rather than persisting partial GPS", async () => {
  assert.equal(await resolveUploadGps("91", "0", async () => null), null);
  assert.equal(await resolveUploadGps("0", "-181", async () => null), null);
});
