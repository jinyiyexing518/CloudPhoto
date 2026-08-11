import assert from "node:assert/strict";
import test from "node:test";
import { partitionPhotoLocations } from "./memoryMapLocationPartitions.ts";

test("a current historical photo uses its valid legacy Cosmos location when Blob GPS metadata is absent", () => {
  const oldPhoto = { name: "old.jpg", gpsMetadataPresent: false };
  const result = partitionPhotoLocations(
    [oldPhoto],
    [{ name: "old.jpg", lat: 31.2304, lon: 121.4737 }],
  );

  assert.deepEqual(
    result.geoPhotos.map(({ name, lat, lon }) => ({ name, lat, lon })),
    [{ name: "old.jpg", lat: 31.2304, lon: 121.4737 }],
  );
  assert.deepEqual(result.noGpsPhotos, []);
});

test("a current historical photo accepts the legacy photoName identifier", () => {
  const oldPhoto = { name: "old.jpg", gpsMetadataPresent: false };
  const result = partitionPhotoLocations(
    [oldPhoto],
    [{ photoName: "old.jpg", lat: 31.2304, lon: 121.4737 }],
  );

  assert.deepEqual(
    result.geoPhotos.map(({ name, lat, lon }) => ({ name, lat, lon })),
    [{ name: "old.jpg", lat: 31.2304, lon: 121.4737 }],
    "legacy photoName rows must locate the current photo",
  );
  assert.deepEqual(result.noGpsPhotos, []);
});

test("conflicting aliases and malformed version fences cannot authorize fallback", () => {
  const photos = [
    { name: "conflict.jpg", gpsMetadataPresent: false },
    { name: "fenced.jpg", blobEtag: '"current"', gpsMetadataPresent: false },
    { name: "malformed.jpg", blobEtag: '"current"', gpsMetadataPresent: false },
  ];
  const result = partitionPhotoLocations(photos, [
    {
      name: "conflict.jpg",
      photoName: "orphan.jpg",
      lat: 31.2304,
      lon: 121.4737,
    },
    {
      name: "fenced.jpg",
      photoName: "orphan.jpg",
      lat: 31.2304,
      lon: 121.4737,
      sourceBlobEtag: '"stale"',
    },
    {
      photoName: "fenced.jpg",
      lat: 31.2304,
      lon: 121.4737,
    },
    {
      name: 42,
      photoName: "malformed.jpg",
      lat: 31.2304,
      lon: 121.4737,
      sourceBlobEtag: '"current"',
    },
    {
      photoName: "malformed.jpg",
      lat: 31.2304,
      lon: 121.4737,
    },
  ]);

  assert.deepEqual(result.geoPhotos, []);
  assert.deepEqual(result.noGpsPhotos.map(({ name }) => name), [
    "conflict.jpg",
    "fenced.jpg",
    "malformed.jpg",
  ]);
});

test("name and photoName rows for one photo remain duplicate-ambiguous", () => {
  const result = partitionPhotoLocations(
    [{ name: "duplicate.jpg", gpsMetadataPresent: false }],
    [
      { name: "duplicate.jpg", lat: 1, lon: 2 },
      { photoName: "duplicate.jpg", lat: 1, lon: 2 },
    ],
  );

  assert.deepEqual(result.geoPhotos, []);
  assert.deepEqual(result.noGpsPhotos.map(({ name }) => name), ["duplicate.jpg"]);
  assert.equal(result.diagnostics.ambiguousCosmos, 2);
});

test("admin-wide location rows cannot cross personal scopes through a legacy alias", () => {
  const photo = {
    name: "personal/owner-b/_/photo.jpg",
    gpsMetadataPresent: false,
  };
  const result = partitionPhotoLocations([photo], [{
    scope: "personal/owner-a",
    photoName: photo.name,
    lat: 31.2304,
    lon: 121.4737,
  }]);

  assert.deepEqual(result.geoPhotos, []);
  assert.deepEqual(result.noGpsPhotos, [photo]);
  assert.equal(result.diagnostics.orphanedCosmos, 1);
});

test("invalid Blob GPS metadata cannot be revived from an unversioned Cosmos row", () => {
  const result = partitionPhotoLocations(
    [{ name: "invalid.jpg", gpsMetadataPresent: true }],
    [{ name: "invalid.jpg", lat: 31.2304, lon: 121.4737 }],
  );

  assert.deepEqual(result.geoPhotos, []);
  assert.deepEqual(result.noGpsPhotos.map(({ name }) => name), ["invalid.jpg"]);
  assert.equal(result.diagnostics.staleCosmosIntersections, 1);
});

test("an ETag-bound Cosmos row cannot bypass the current Blob version", () => {
  const result = partitionPhotoLocations(
    [{ name: "replaced.jpg", blobEtag: '"blob-v2"' }],
    [{
      name: "replaced.jpg",
      lat: 31.2304,
      lon: 121.4737,
      sourceBlobEtag: '"blob-v1"',
    }],
  );

  assert.deepEqual(result.geoPhotos, []);
  assert.deepEqual(result.noGpsPhotos.map(({ name }) => name), ["replaced.jpg"]);
  assert.equal(result.diagnostics.staleCosmosIntersections, 1);
});

test("ambiguous same-photo Cosmos rows fail closed", () => {
  const result = partitionPhotoLocations(
    [{ name: "duplicate.jpg" }],
    [
      { name: "duplicate.jpg", lat: 1, lon: 2 },
      { name: "duplicate.jpg", lat: 3, lon: 4 },
    ],
  );

  assert.deepEqual(result.geoPhotos, []);
  assert.deepEqual(result.noGpsPhotos.map(({ name }) => name), ["duplicate.jpg"]);
  assert.equal(result.diagnostics.ambiguousCosmos, 2);
});

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
    ambiguousCosmos: 0,
  });
});
