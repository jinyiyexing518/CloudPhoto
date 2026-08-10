import assert from "node:assert/strict";
import test from "node:test";
import {
  hasValidGps,
  parseFiniteCoordinate,
  readGpsCoordinates,
} from "./gpsCoordinates.ts";

test("client GPS parsing matches the finite atomic range contract", () => {
  assert.deepEqual(readGpsCoordinates(" 0 ", "-180"), { lat: 0, lon: -180 });
  assert.equal(readGpsCoordinates("NaN", "NaN"), null);
  assert.equal(readGpsCoordinates("10", undefined), null);
  assert.equal(readGpsCoordinates("91", "0"), null);
  assert.equal(readGpsCoordinates("0", "181"), null);
  assert.equal(parseFiniteCoordinate("Infinity", -90, 90), null);
  assert.equal(hasValidGps("-90", "180"), true);
});
