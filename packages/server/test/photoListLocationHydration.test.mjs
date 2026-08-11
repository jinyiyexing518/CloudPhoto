import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import hydration from "../dist/src/functions/photos/photoListLocationHydration.js";

const require = createRequire(import.meta.url);

const {
  hydrateListedPhotoLocations,
  listAuthorizedPhotoLocationRows,
  PHOTO_LOCATION_QUERY_TIMEOUT_MS,
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

test("registered /photos hydrates an authorized current Blob from a legacy photoName row", async (t) => {
  const functions = require("@azure/functions");
  const blobStorage = require("../dist/src/utils/blob/blobStorage.js");
  const jwtUtils = require("../dist/src/utils/auth/jwtUtils.js");
  const cosmosClient = require("../dist/src/utils/cosmos/cosmosClient.js");
  const listPhotosPath = require.resolve("../dist/src/functions/photos/listPhotos.js");
  const blobName = "personal/user/_/historical.jpg";

  const original = {
    appHttp: functions.app.http,
    extractTokenFromHeader: jwtUtils.extractTokenFromHeader,
    generateSasUrlWithKey: blobStorage.generateSasUrlWithKey,
    getBlobServiceClient: blobStorage.getBlobServiceClient,
    getUserDelegationKey: blobStorage.getUserDelegationKey,
    getPhotoLocationsContainer: cosmosClient.getPhotoLocationsContainer,
  };
  t.after(() => {
    functions.app.http = original.appHttp;
    jwtUtils.extractTokenFromHeader = original.extractTokenFromHeader;
    blobStorage.generateSasUrlWithKey = original.generateSasUrlWithKey;
    blobStorage.getBlobServiceClient = original.getBlobServiceClient;
    blobStorage.getUserDelegationKey = original.getUserDelegationKey;
    cosmosClient.getPhotoLocationsContainer = original.getPhotoLocationsContainer;
    delete require.cache[listPhotosPath];
  });

  let handler;
  functions.app.http = (name, options) => {
    if (name === "listPhotos" && options.route === "photos") {
      handler = options.handler;
    }
  };
  jwtUtils.extractTokenFromHeader = () => ({ role: "viewer", userId: "user" });
  blobStorage.generateSasUrlWithKey = (name) => `https://media.invalid/${encodeURIComponent(name)}`;
  blobStorage.getUserDelegationKey = async () => ({});
  blobStorage.getBlobServiceClient = () => ({
    getContainerClient: () => ({
      createIfNotExists: async () => {},
      listBlobsFlat: async function* () {
        yield {
          name: blobName,
          metadata: {},
          properties: {
            contentLength: 123,
            contentType: "image/jpeg",
            etag: '"current-etag"',
            lastModified: new Date("2026-08-11T00:00:00.000Z"),
          },
        };
      },
    }),
  });
  cosmosClient.getPhotoLocationsContainer = async () => ({
    items: {
      query: () => ({
        fetchAll: async () => ({
          resources: [{
            id: "historical-row",
            scope: "personal/user",
            photoName: blobName,
            lat: 31.2304,
            lon: 121.4737,
            uploadedAt: "2025-01-01T00:00:00.000Z",
          }],
        }),
      }),
    },
  });

  delete require.cache[listPhotosPath];
  require(listPhotosPath);
  assert.equal(typeof handler, "function", "the registered GET /photos handler must be captured");

  const response = await handler({
    headers: new Headers({ authorization: "******" }),
    query: new URLSearchParams(),
  }, {
    error: () => {},
    warn: () => {},
  });
  const [photo] = JSON.parse(response.body);

  assert.equal(response.status, 200);
  assert.equal(photo.name, blobName);
  assert.equal(photo.gpsMetadataPresent, false);
  assert.deepEqual(
    [photo.gpsLat, photo.gpsLon],
    ["31.2304", "121.4737"],
    "legacy photoName rows must hydrate the current authorized Blob",
  );
});

test("bulk location queries stay within the exact authorized request scope", async () => {
  const queries = [];
  const queryOptions = [];
  const container = {
    items: {
      query(specification, options) {
        queries.push(specification);
        queryOptions.push(options);
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
    assert.match(query.query, /c\.photoName/);
  }
  assert.equal(PHOTO_LOCATION_QUERY_TIMEOUT_MS, 1_500);
  for (const options of queryOptions) {
    assert.ok(options.abortSignal instanceof AbortSignal);
  }
});

test("a Cosmos query that ignores AbortSignal still settles at the wall-clock deadline", async () => {
  let querySignal;
  const neverSettlingContainer = {
    items: {
      query(_query, options) {
        querySignal = options.abortSignal;
        return { fetchAll: async () => new Promise(() => {}) };
      },
    },
  };
  const startedAt = Date.now();
  const result = await Promise.race([
    listAuthorizedPhotoLocationRows(
      neverSettlingContainer,
      {
        groupId: "",
        userId: "user",
        role: "user",
      },
      25,
    ).then(
      () => ({ outcome: "resolved" }),
      (error) => ({ outcome: "rejected", error }),
    ),
    new Promise((resolve) => {
      setTimeout(() => resolve({ outcome: "test-deadline" }), 500);
    }),
  ]);

  assert.notEqual(
    result.outcome,
    "test-deadline",
    "the wall-clock race did not settle a Cosmos query that ignored AbortSignal",
  );
  assert.equal(result.outcome, "rejected");
  assert.match(result.error.message, /timed out/);
  assert.equal(querySignal.aborted, true);
  assert.ok(Date.now() - startedAt < 500);
});

test("legacy identifiers hydrate only when aliases agree and version fences remain valid", () => {
  const photos = [
    { name: "photo-name.jpg" },
    { name: "same-alias.jpg" },
    { name: "conflicting-alias.jpg" },
    { name: "malformed-version-fence.jpg" },
    { name: "malformed-field.jpg" },
    { name: "cross-scope.jpg" },
  ];
  const sources = photos.map((photo) => ({
    photo,
    scope: "personal/user",
    blobEtag: `"${photo.name}-etag"`,
    hasGpsMetadata: false,
  }));
  const rows = [
    location("unused", { name: undefined, photoName: "photo-name.jpg" }),
    location("same-alias.jpg", { photoName: "same-alias.jpg" }),
    location("conflicting-alias.jpg", { photoName: "other.jpg" }),
    location("malformed-version-fence.jpg", {
      photoName: "other.jpg",
      sourceBlobEtag: '"stale-etag"',
    }),
    location("unused", {
      name: undefined,
      photoName: "malformed-version-fence.jpg",
    }),
    location("unused", {
      name: 42,
      photoName: "malformed-field.jpg",
      sourceBlobEtag: '"malformed-field.jpg-etag"',
    }),
    location("unused", {
      name: undefined,
      photoName: "malformed-field.jpg",
    }),
    location("unused", {
      name: undefined,
      photoName: "cross-scope.jpg",
      scope: "personal/other",
    }),
  ];

  hydrateListedPhotoLocations(sources, rows);

  assert.deepEqual(
    photos.map(({ name, gpsLat, gpsLon }) => ({ name, gpsLat, gpsLon })),
    [
      { name: "photo-name.jpg", gpsLat: "31.2304", gpsLon: "121.4737" },
      { name: "same-alias.jpg", gpsLat: "31.2304", gpsLon: "121.4737" },
      { name: "conflicting-alias.jpg", gpsLat: undefined, gpsLon: undefined },
      { name: "malformed-version-fence.jpg", gpsLat: undefined, gpsLon: undefined },
      { name: "malformed-field.jpg", gpsLat: undefined, gpsLon: undefined },
      { name: "cross-scope.jpg", gpsLat: undefined, gpsLon: undefined },
    ],
  );
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
  assert.equal(
    (locationsSource.match(/c\.photoName/g) ?? []).length,
    3,
    "every authorized location query must project the historical identifier",
  );
  assert.equal(
    (locationsSource.match(/SELECT c\.scope, c\.name, c\.photoName/g) ?? []).length,
    3,
    "every authorized location query must carry scope into client validation",
  );
});
