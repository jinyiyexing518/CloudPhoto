import assert from "node:assert/strict";
import test from "node:test";
import gpsCoordinates from "../dist/src/utils/photos/gpsCoordinates.js";

const {
  parseFiniteCoordinate,
  readGpsMetadata,
} = gpsCoordinates;

test("parses only finite in-range coordinates after trimming", () => {
  assert.equal(parseFiniteCoordinate(" 0 ", -90, 90), 0);
  assert.equal(parseFiniteCoordinate("-90", -90, 90), -90);
  assert.equal(parseFiniteCoordinate("180", -180, 180), 180);

  for (const value of ["", " ", "NaN", "Infinity", "-Infinity", "91", "-90.1"]) {
    assert.equal(parseFiniteCoordinate(value, -90, 90), null, value);
  }
  for (const value of ["181", "-180.1"]) {
    assert.equal(parseFiniteCoordinate(value, -180, 180), null, value);
  }
});

test("treats GPS metadata as one atomic pair", () => {
  assert.deepEqual(
    readGpsMetadata({ GPSLAT: " 31.2304 ", gpslon: "121.4737" }),
    { gpsLat: "31.2304", gpsLon: "121.4737" },
  );
  assert.equal(readGpsMetadata({ gpsLat: "NaN", gpsLon: "NaN" }), null);
  assert.equal(readGpsMetadata({ gpsLat: "10" }), null);
  assert.equal(readGpsMetadata({ gpsLon: "20" }), null);
  assert.equal(readGpsMetadata({ gpsLat: "91", gpsLon: "20" }), null);
});
