import assert from "node:assert/strict";
import test from "node:test";
import exifr from "exifr";
import uploadGps from "../dist/src/functions/photos/uploadGps.js";
import {
  createExtendedXmpGpsJpeg,
  createGpsHeic,
  createGpsJpeg,
  createXmpGpsJpeg,
} from "./fixtures/exifGpsFixtures.mjs";

const {
  buildUploadGpsQuery,
  parseXmpGps,
  readPhotoGps,
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

test("invalid, partial, and non-finite client coordinates fall back to server EXIF", async () => {
  let calls = 0;
  const fallback = async () => {
    calls += 1;
    return { latitude: 35.6762, longitude: 139.6503 };
  };
  for (const pair of [
    ["91", "0"],
    ["0", "-181"],
    ["NaN", "1"],
    ["1", "NaN"],
    ["Infinity", "1"],
    ["1", "-Infinity"],
    ["12", ""],
    ["", "34"],
  ]) {
    assert.deepEqual(await resolveUploadGps(pair[0], pair[1], fallback), {
      gpsLat: "35.6762",
      gpsLon: "139.6503",
    });
  }
  assert.equal(calls, 8);
});

test("server fallback recovers standard XMP-only GPS that exifr.gps omits", async () => {
  const jpeg = createXmpGpsJpeg();
  assert.equal(await exifr.gps(jpeg), undefined);
  assert.deepEqual(await readPhotoGps(jpeg), {
    latitude: 31.2304,
    longitude: 121.4737,
  });
});

test("server fallback reads numeric hemisphere GPS from Adobe Extended XMP", async () => {
  const jpeg = createExtendedXmpGpsJpeg();
  const singleSegment = await exifr.parse(jpeg, {
    xmp: true,
    tiff: false,
    icc: false,
    iptc: false,
    jfif: false,
    mergeOutput: true,
  });
  assert.equal(parseXmpGps(singleSegment), null);
  assert.deepEqual(await readPhotoGps(jpeg), {
    latitude: -31.2304,
    longitude: -121.4737,
  });
});

test("server upload GPS reader preserves TIFF JPEG and HEIC fast paths", async () => {
  for (const media of [createGpsJpeg(), createGpsHeic()]) {
    const gps = await readPhotoGps(media);
    assert.ok(gps);
    assert.ok(Math.abs(gps.latitude - 31.2304) < 1e-8);
    assert.ok(Math.abs(gps.longitude - 121.4737) < 1e-8);
  }
});

test("XMP GPS conversion rejects partial, mismatched, and out-of-range coordinates", () => {
  assert.deepEqual(parseXmpGps({
    exif: {
      GPSLatitude: "33,52.128S",
      GPSLongitude: "151,12.558E",
    },
  }), {
    latitude: -33.8688,
    longitude: 151.2093,
  });
  assert.deepEqual(parseXmpGps({
    GPSLatitude: 31.2304,
    GPSLatitudeRef: "S",
    GPSLongitude: 121.4737,
    GPSLongitudeRef: "W",
  }), {
    latitude: -31.2304,
    longitude: -121.4737,
  });
  assert.equal(parseXmpGps({ GPSLatitude: "31,13.824N" }), null);
  assert.equal(parseXmpGps({
    GPSLatitude: "31,13.824E",
    GPSLongitude: "121,28.422E",
  }), null);
  assert.equal(parseXmpGps({
    GPSLatitude: "31,,N",
    GPSLongitude: "121,28.422E",
  }), null);
  assert.equal(parseXmpGps({
    GPSLatitude: "31,13.824N",
    GPSLatitudeRef: "S",
    GPSLongitude: "121,28.422E",
  }), null);
  assert.equal(parseXmpGps({
    GPSLatitude: "91,0N",
    GPSLongitude: "121,28.422E",
  }), null);
});
