import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import hydration from "../dist/src/functions/photos/photoListLocationHydration.js";

const {
  hydrateListedPhotoLocations,
  listAuthorizedPhotoLocationRows,
} = hydration;

function location(name, overrides = {}) {
  return {
    id: name,
    scope: "personal/user",
    name,
    lat: 31.2304,
    lon: 121.4737,
    uploadedAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

test("bulk location queries stay within the exact authorized request scope", async () => {
  const queries = [];
  const container = {
    items: {
      query(specification) {
        queries.push(specification);
        return { async fetchAll() { return { resources: [] }; } };
      },
    },
  };

  await listAuthorizedPhotoLocationRows(container, {
    groupId: "",
    userId: "user",
    role: "user",
  });
  await listAuthorizedPhotoLocationRows(container, {
    groupId: "group",
    userId: "user",
    role: "user",
  });
  await listAuthorizedPhotoLocationRows(container, {
    groupId: "",
    userId: "admin",
    role: "admin",
  });

  assert.equal(queries.length, 3, "each list request must issue one bulk query");
  assert.deepEqual(queries[0].parameters, [
    { name: "@scope", value: "personal/user" },
  ]);
  assert.deepEqual(queries[1].parameters, [
    { name: "@scope", value: "groups/group" },
  ]);
  assert.match(queries[2].query, /STARTSWITH\(c\.scope, 'personal\/'\)/);
  for (const query of queries) {
    assert.match(query.query, /c\.sourceBlobEtag/);
  }
});

test("list hydration restores only valid current-scope rows with fresh provenance", () => {
  const photos = [
    { name: "legacy.jpg" },
    { name: "matching.jpg" },
    { name: "mismatch.jpg" },
    { name: "missing-current-etag.jpg" },
    { name: "blob-gps.jpg", gpsLat: "10", gpsLon: "20" },
    { name: "partial-blob.jpg" },
    { name: "partial-row.jpg" },
    { name: "nan-row.jpg" },
    { name: "infinite-row.jpg" },
    { name: "range-row.jpg" },
    { name: "duplicate-row.jpg" },
  ];
  const source = (photo, overrides = {}) => ({
    photo,
    scope: "personal/user",
    blobEtag: `"${photo.name}-etag"`,
    hasGpsMetadata: false,
    ...overrides,
  });
  const sources = [
    source(photos[0]),
    source(photos[1]),
    source(photos[2]),
    source(photos[3], { blobEtag: undefined }),
    source(photos[4], { hasGpsMetadata: true }),
    source(photos[5], { hasGpsMetadata: true }),
    ...photos.slice(6).map((photo) => source(photo)),
  ];
  const rows = [
    location("legacy.jpg"),
    location("matching.jpg", { sourceBlobEtag: '"matching.jpg-etag"' }),
    location("mismatch.jpg", { sourceBlobEtag: '"old-etag"' }),
    location("missing-current-etag.jpg", { sourceBlobEtag: '"indexed-etag"' }),
    location("blob-gps.jpg", { lat: 50, lon: 60 }),
    location("partial-blob.jpg", { lat: 50, lon: 60 }),
    location("partial-row.jpg", { lon: undefined }),
    location("nan-row.jpg", { lat: Number.NaN }),
    location("infinite-row.jpg", { lon: Number.POSITIVE_INFINITY }),
    location("range-row.jpg", { lat: 91 }),
    location("duplicate-row.jpg", { lat: 1, lon: 2 }),
    location("duplicate-row.jpg", { id: "duplicate-row-2.jpg", lat: 3, lon: 4 }),
    location("orphan.jpg"),
    location("legacy.jpg", { scope: "personal/other" }),
  ];

  const diagnostics = hydrateListedPhotoLocations(sources, rows);

  assert.deepEqual(
    photos.map(({ name, gpsLat, gpsLon }) => ({ name, gpsLat, gpsLon })),
    [
      { name: "legacy.jpg", gpsLat: "31.2304", gpsLon: "121.4737" },
      { name: "matching.jpg", gpsLat: "31.2304", gpsLon: "121.4737" },
      { name: "mismatch.jpg", gpsLat: undefined, gpsLon: undefined },
      { name: "missing-current-etag.jpg", gpsLat: undefined, gpsLon: undefined },
      { name: "blob-gps.jpg", gpsLat: "10", gpsLon: "20" },
      { name: "partial-blob.jpg", gpsLat: undefined, gpsLon: undefined },
      { name: "partial-row.jpg", gpsLat: undefined, gpsLon: undefined },
      { name: "nan-row.jpg", gpsLat: undefined, gpsLon: undefined },
      { name: "infinite-row.jpg", gpsLat: undefined, gpsLon: undefined },
      { name: "range-row.jpg", gpsLat: undefined, gpsLon: undefined },
      { name: "duplicate-row.jpg", gpsLat: undefined, gpsLon: undefined },
    ],
  );
  assert.deepEqual(diagnostics, {
    hydrated: 2,
    orphanedOrOutOfScope: 2,
    invalidCoordinates: 4,
    staleSource: 2,
    blobMetadataAuthoritative: 2,
    ambiguousRows: 2,
  });
});

test("listPhotos hydrates its response from one scoped location inventory", async () => {
  const listSource = await readFile(
    new URL("../src/functions/photos/listPhotos.ts", import.meta.url),
    "utf8",
  );
  assert.match(listSource, /gpsMetadataPresent = hasGpsMetadataKeys\(blob\.metadata\)/);
  assert.match(listSource, /gpsMetadataPresent,/);
  assert.match(listSource, /hasGpsMetadata: gpsMetadataPresent/);
  assert.match(listSource, /blobEtag: blob\.properties\.etag/);
  assert.match(listSource, /await listAuthorizedPhotoLocationRows\(/);
  assert.match(listSource, /hydrateListedPhotoLocations\(locationSources, locationRows\)/);
  assert.match(listSource, /photoLocations list hydration failed \(non-fatal\)/);
  assert.match(
    listSource,
    /locationSources\.some\(\(source\) => !source\.hasGpsMetadata\)/,
    "the supplemental query must be skipped when every Blob already has GPS metadata",
  );
  assert.ok(
    listSource.indexOf("for await (const blob") < listSource.indexOf("await listAuthorizedPhotoLocationRows("),
    "the location inventory must be loaded once after the authorized Blob list",
  );
  assert.ok(
    listSource.indexOf("hydrateListedPhotoLocations(locationSources, locationRows)")
      < listSource.indexOf("JSON.stringify(photos)"),
    "the hydrated GPS pair must be present in the list response",
  );
  const locationsSource = await readFile(
    new URL("../src/functions/photos/getPhotoLocations.ts", import.meta.url),
    "utf8",
  );
  assert.equal(
    (locationsSource.match(/c\.sourceBlobEtag/g) ?? []).length,
    3,
    "every authorized location query must return source provenance for client validation",
  );
});
