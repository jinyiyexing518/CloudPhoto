import assert from "node:assert/strict";
import test from "node:test";
import photoLocationSync from "../dist/src/utils/cosmos/photoLocationSync.js";

const { publishPhotoLocationSnapshot, syncPhotoLocationFromBlob } = photoLocationSync;

function cosmosError(statusCode) {
  return Object.assign(new Error(`Cosmos ${statusCode}`), { statusCode });
}

function fakeContainer(initial) {
  let version = 1;
  let resource = initial ? { ...initial, _etag: String(version) } : undefined;
  let beforeReplace = null;

  const item = {
    async read() {
      if (!resource) throw cosmosError(404);
      return { resource: { ...resource }, etag: resource._etag };
    },
    async replace(next, options) {
      beforeReplace?.();
      beforeReplace = null;
      if (!resource || options?.accessCondition?.condition !== resource._etag) {
        throw cosmosError(412);
      }
      resource = { ...next, _etag: String(++version) };
      return { resource: { ...resource }, etag: resource._etag };
    },
    async delete(options) {
      if (!resource) throw cosmosError(404);
      if (options?.accessCondition?.condition !== resource._etag) throw cosmosError(412);
      resource = undefined;
      return {};
    },
  };

  return {
    item: () => item,
    items: {
      async create(next) {
        if (resource) throw cosmosError(409);
        resource = { ...next, _etag: String(++version) };
        return { resource: { ...resource }, etag: resource._etag };
      },
    },
    get resource() {
      return resource;
    },
    replaceResource(next) {
      resource = { ...next, _etag: String(++version) };
    },
    beforeNextReplace(callback) {
      beforeReplace = callback;
    },
  };
}

const location = {
  id: "photo.jpg",
  scope: "personal/user",
  name: "photo.jpg",
  lat: 1,
  lon: 2,
  uploadedAt: "2026-08-07T00:00:00.000Z",
};

test("publishes a location snapshot with its source Blob ETag", async () => {
  const container = fakeContainer();
  const result = await publishPhotoLocationSnapshot(
    container,
    location,
    "blob-v1",
    async () => true,
  );

  assert.equal(result.status, "published");
  assert.equal(container.resource.sourceBlobEtag, "blob-v1");
});

test("invalid Blob GPS deletes a stale location index entry", async () => {
  const container = fakeContainer({
    ...location,
    sourceBlobEtag: "blob-v0",
  });
  const blob = {
    async getProperties() {
      return {
        etag: "blob-v1",
        metadata: { gpsLat: "NaN", gpsLon: "NaN" },
        contentType: "image/jpeg",
      };
    },
  };

  await syncPhotoLocationFromBlob(
    blob,
    location.name,
    location.scope,
    undefined,
    container,
  );

  assert.equal(container.resource, undefined);
});

test("valid Blob GPS rebuilds a missing location index entry", async () => {
  const container = fakeContainer();
  const blob = {
    async getProperties() {
      return {
        etag: "blob-v1",
        metadata: {
          gpsLat: "31.2304",
          gpsLon: "121.4737",
          createdAt: "2026-08-10T00:00:00.000Z",
        },
        contentType: "image/jpeg",
      };
    },
  };

  await syncPhotoLocationFromBlob(
    blob,
    location.name,
    location.scope,
    undefined,
    container,
  );

  assert.equal(container.resource.lat, 31.2304);
  assert.equal(container.resource.lon, 121.4737);
  assert.equal(container.resource.sourceBlobEtag, "blob-v1");
});

test("a stale publisher cannot overwrite a newer conditional publication", async () => {
  const container = fakeContainer({
    ...location,
    sourceBlobEtag: "blob-v0",
  });
  let sourceChecks = 0;
  container.beforeNextReplace(() => {
    container.replaceResource({
      ...location,
      lat: 9,
      sourceBlobEtag: "blob-v2",
    });
  });

  const result = await publishPhotoLocationSnapshot(
    container,
    { ...location, lat: 3 },
    "blob-v1",
    async () => {
      sourceChecks += 1;
      return sourceChecks === 1;
    },
  );

  assert.deepEqual(result, { status: "source-changed" });
  assert.equal(container.resource.sourceBlobEtag, "blob-v2");
  assert.equal(container.resource.lat, 9);
});
