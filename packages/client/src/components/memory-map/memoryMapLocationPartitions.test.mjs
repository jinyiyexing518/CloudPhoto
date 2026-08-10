import assert from "node:assert/strict";
import test from "node:test";
import { partitionPhotoLocations } from "./memoryMapLocationPartitions.ts";

test("photo location partitions are exclusive, exhaustive, and reject stale Cosmos rows", () => {
  const photos = [
    { name: "valid-indexed", gpsLat: "10", gpsLon: "20" },
    { name: "valid-updated", gpsLat: "50", gpsLon: "60" },
    { name: "valid-fallback", gpsLat: "30", gpsLon: "40" },
    { name: "lat-only", gpsLat: "10" },
    { name: "lon-only", gpsLon: "20" },
    { name: "missing" },
    { name: "nan", gpsLat: "NaN", gpsLon: "20" },
    { name: "out-of-range", gpsLat: "91", gpsLon: "20" },
  ];
  const locations = [
    { name: "valid-indexed", lat: 10, lon: 20 },
    { name: "valid-updated", lat: 49, lon: 59 },
    { name: "lat-only", lat: 12, lon: 22 },
    { name: "orphan", lat: 13, lon: 23 },
    { name: "valid-fallback", lat: Number.NaN, lon: 24 },
  ];

  const result = partitionPhotoLocations(photos, locations);
  assert.deepEqual(result.geoPhotos.map((photo) => photo.name), [
    "valid-indexed",
    "valid-updated",
    "valid-fallback",
  ]);
  assert.deepEqual(
    result.geoPhotos.find((photo) => photo.name === "valid-updated"),
    {
      name: "valid-updated",
      lat: 50,
      lon: 60,
      originalName: undefined,
      contentType: undefined,
      photo: photos[1],
    },
  );
  assert.deepEqual(result.noGpsPhotos.map((photo) => photo.name), [
    "lat-only",
    "lon-only",
    "missing",
    "nan",
    "out-of-range",
  ]);
  assert.equal(
    result.geoPhotos.length + result.noGpsPhotos.length,
    photos.length,
  );
  assert.deepEqual(
    result.geoPhotos.filter((pin) => result.noGpsPhotos.some((photo) => photo.name === pin.name)),
    [],
  );
  assert.deepEqual(result.diagnostics, {
    bothFinite: 3,
    latitudeOnly: 1,
    longitudeOnly: 1,
    neitherOrInvalid: 3,
    cosmosIntersections: 1,
    staleCosmosIntersections: 2,
    orphanedCosmos: 1,
    invalidCosmos: 1,
  });
});
