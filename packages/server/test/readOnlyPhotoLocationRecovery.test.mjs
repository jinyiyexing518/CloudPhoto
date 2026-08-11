import assert from "node:assert/strict";
import test from "node:test";
import recovery from "../dist/src/functions/photos/readOnlyPhotoLocationRecovery.js";
import {
  createGpsJpeg,
  createXmpGpsJpeg,
} from "./fixtures/exifGpsFixtures.mjs";

const {
  READ_ONLY_LOCATION_RECOVERY_BODY_LIMIT,
  MAX_READ_ONLY_LOCATION_RECOVERY_PHOTOS,
  createReadOnlyPhotoLocationRecoveryHandler,
} = recovery;

function request(entries, groupId = "") {
  const body = JSON.stringify({ photos: entries });
  return {
    headers: new Headers({
      authorization: "******",
      "content-length": String(Buffer.byteLength(body)),
    }),
    query: new URLSearchParams(groupId ? { groupId } : {}),
    arrayBuffer: async () => Buffer.from(body),
  };
}

function blobClient(bytes, {
  etag = '"current"',
  metadata = {},
  contentType = "image/jpeg",
} = {}) {
  const reads = [];
  return {
    reads,
    client: {
      async getProperties(options) {
        assert.equal(options.conditions.ifMatch, etag);
        return {
          etag,
          metadata,
          contentType,
          contentLength: bytes.length,
        };
      },
      async downloadToBuffer(offset, count, options) {
        assert.equal(options.conditions.ifMatch, etag);
        reads.push({ offset, count });
        return bytes.subarray(offset, Math.min(offset + count, bytes.length));
      },
    },
  };
}

test("owned Blob-only EXIF and XMP locations recover read-only without an index mutation", async () => {
  const fixtures = new Map();
  for (const [name, bytes] of [
    ["personal/user/_/exif.jpg", createGpsJpeg()],
    ["personal/user/_/xmp.jpg", createXmpGpsJpeg()],
  ]) {
    fixtures.set(name, blobClient(bytes));
  }
  let membershipChecks = 0;
  let writes = 0;
  const handler = createReadOnlyPhotoLocationRecoveryHandler({
    authenticate: () => ({ role: "viewer", userId: "user" }),
    checkGroupMembership: async () => {
      membershipChecks += 1;
      return false;
    },
    getContainerClient: () => ({
      getBlockBlobClient(name) {
        const fixture = fixtures.get(name);
        assert.ok(fixture, `unexpected Blob read: ${name}`);
        return fixture.client;
      },
      async setMetadata() {
        writes += 1;
      },
    }),
  });

  const response = await handler(request(
    [...fixtures.keys()].map((name) => ({ name, blobEtag: '"current"' })),
  ), { warn: () => {} });
  const body = JSON.parse(response.body);

  assert.equal(response.status, 200);
  assert.equal(membershipChecks, 0);
  assert.equal(writes, 0, "read-time recovery must never mutate Blob or Cosmos state");
  assert.deepEqual(body.locations, [
    {
      name: "personal/user/_/exif.jpg",
      gpsLat: "31.2304",
      gpsLon: "121.4737",
      sourceBlobEtag: '"current"',
    },
    {
      name: "personal/user/_/xmp.jpg",
      gpsLat: "31.2304",
      gpsLon: "121.4737",
      sourceBlobEtag: '"current"',
    },
  ]);
  assert.deepEqual(body.processed, [...fixtures.keys()]);
  assert.equal(body.truncated, false);
  assert.ok([...fixtures.values()].every((fixture) => fixture.reads.length === 1));
});

test("legacy generic Blob content types recover from the authorized filename", async () => {
  const fixture = blobClient(createGpsJpeg(), {
    contentType: "application/octet-stream",
  });
  const handler = createReadOnlyPhotoLocationRecoveryHandler({
    authenticate: () => ({ role: "viewer", userId: "user" }),
    getContainerClient: () => ({
      getBlockBlobClient: () => fixture.client,
    }),
  });

  const response = await handler(request([{
    name: "personal/user/_/legacy.JPG",
    blobEtag: '"current"',
  }]), { warn: () => {} });
  const body = JSON.parse(response.body);

  assert.equal(response.status, 200);
  assert.deepEqual(body.locations.map(({ name }) => name), [
    "personal/user/_/legacy.JPG",
  ]);
  assert.deepEqual(body.processed, ["personal/user/_/legacy.JPG"]);
  assert.equal(body.truncated, false);
});

test("recovery remains scope-isolated for personal, group, and admin requests", async () => {
  const touched = [];
  let membershipChecks = 0;
  const makeHandler = (identity, membership = false) => createReadOnlyPhotoLocationRecoveryHandler({
    authenticate: () => identity,
    checkGroupMembership: async () => {
      membershipChecks += 1;
      return membership;
    },
    getContainerClient: () => ({
      getBlockBlobClient(name) {
        touched.push(name);
        return blobClient(createGpsJpeg()).client;
      },
    }),
  });

  const personal = await makeHandler({ role: "viewer", userId: "user" })(
    request([
      { name: "personal/user/_/mine.jpg", blobEtag: '"current"' },
      { name: "personal/other/_/orphan.jpg", blobEtag: '"current"' },
    ]),
    { warn: () => {} },
  );
  assert.equal(personal.status, 403);
  assert.deepEqual(touched, [], "cross-scope names must be rejected before Blob access");

  const group = await makeHandler({ role: "viewer", userId: "user" }, true)(
    request([{ name: "groups/group/_/shared.jpg", blobEtag: '"current"' }], "group"),
    { warn: () => {} },
  );
  assert.equal(group.status, 200);
  assert.equal(membershipChecks, 1, "group authorization must be checked once per batch");

  const admin = await makeHandler({ role: "admin", userId: "admin" })(
    request([{ name: "personal/other/_/admin-visible.jpg", blobEtag: '"current"' }]),
    { warn: () => {} },
  );
  assert.equal(admin.status, 200);
});

test("authorization and request parsing share the bounded request deadline", async () => {
  let membershipSignal;
  let blobReads = 0;
  const handler = createReadOnlyPhotoLocationRecoveryHandler({
    authenticate: () => ({ role: "viewer", userId: "user" }),
    checkGroupMembership: (_groupId, _userId, signal) => {
      membershipSignal = signal;
      return new Promise(() => {});
    },
    timeoutMs: 25,
    getContainerClient: () => ({
      getBlockBlobClient() {
        blobReads += 1;
        return blobClient(createGpsJpeg()).client;
      },
    }),
  });
  const startedAt = Date.now();
  const response = await handler(request([{
    name: "groups/group/_/shared.jpg",
    blobEtag: '"current"',
  }], "group"), { warn: () => {} });

  assert.equal(response.status, 503);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(membershipSignal.aborted, true);
  assert.equal(blobReads, 0);

  const oversized = request([]);
  oversized.headers.set(
    "content-length",
    String(READ_ONLY_LOCATION_RECOVERY_BODY_LIMIT + 1),
  );
  const oversizedResponse = await handler(oversized, { warn: () => {} });
  assert.equal(oversizedResponse.status, 413);
});

test("the body cap uses actual bytes and malformed top-level JSON fails closed", async () => {
  const handler = createReadOnlyPhotoLocationRecoveryHandler({
    authenticate: () => ({ role: "viewer", userId: "user" }),
  });
  const oversizedBody = Buffer.alloc(READ_ONLY_LOCATION_RECOVERY_BODY_LIMIT + 1, 0x20);
  const understated = {
    headers: new Headers({
      authorization: "******",
      "content-length": "2",
    }),
    query: new URLSearchParams(),
    arrayBuffer: async () => oversizedBody,
  };
  const understatedResponse = await handler(understated, { warn: () => {} });
  assert.equal(understatedResponse.status, 413);

  const nullBody = Buffer.from("null");
  const malformedTopLevel = {
    headers: new Headers({
      authorization: "******",
      "content-length": String(nullBody.length),
    }),
    query: new URLSearchParams(),
    arrayBuffer: async () => nullBody,
  };
  const malformedResponse = await handler(malformedTopLevel, { warn: () => {} });
  assert.equal(malformedResponse.status, 400);
});

test("invalid Blob GPS metadata fails closed and batch work is explicitly bounded", async () => {
  const invalid = blobClient(createGpsJpeg(), {
    metadata: { gpsLat: "NaN", gpsLon: "121.4737" },
  });
  const handler = createReadOnlyPhotoLocationRecoveryHandler({
    authenticate: () => ({ role: "viewer", userId: "user" }),
    checkGroupMembership: async () => false,
    getContainerClient: () => ({
      getBlockBlobClient: () => invalid.client,
    }),
  });

  const invalidResponse = await handler(request([{
    name: "personal/user/_/invalid-metadata.jpg",
    blobEtag: '"current"',
  }]), { warn: () => {} });
  assert.deepEqual(JSON.parse(invalidResponse.body).locations, []);
  assert.deepEqual(invalid.reads, [], "present-but-invalid GPS metadata must not fall back to EXIF");

  const tooMany = Array.from(
    { length: MAX_READ_ONLY_LOCATION_RECOVERY_PHOTOS + 1 },
    (_, index) => ({
      name: `personal/user/_/${index}.jpg`,
      blobEtag: '"current"',
    }),
  );
  const bounded = await handler(request(tooMany), { warn: () => {} });
  assert.equal(bounded.status, 400);
  assert.match(JSON.parse(bounded.body).error, /at most/i);
});

test("large scans are serialized so every request makes bounded progress", async () => {
  const contentLength = 3 * 1024 * 1024;
  let bytesRead = 0;
  const handler = createReadOnlyPhotoLocationRecoveryHandler({
    authenticate: () => ({ role: "viewer", userId: "user" }),
    getContainerClient: () => ({
      getBlockBlobClient() {
        return {
          async getProperties() {
            return {
              etag: '"current"',
              metadata: {},
              contentType: "image/heic",
              contentLength,
            };
          },
          async downloadToBuffer(_offset, count) {
            bytesRead += count;
            return Buffer.alloc(count);
          },
        };
      },
    }),
  });
  const entries = Array.from({ length: 4 }, (_, index) => ({
    name: `personal/user/_/large-${index}.heic`,
    blobEtag: '"current"',
  }));
  const response = await handler(request(entries), { warn: () => {} });
  const body = JSON.parse(response.body);

  assert.equal(response.status, 200);
  assert.ok(body.processed.length >= 1, "at least one large candidate must complete");
  assert.ok(body.processed.length < entries.length, "the shared byte budget must still bind");
  assert.ok(bytesRead <= 8 * 1024 * 1024);
  assert.equal(body.bytesRead, bytesRead);
  assert.equal(body.truncated, true);
});

test("a never-settling Blob range read degrades within a real wall-clock bound", async () => {
  let rangeSignal;
  const handler = createReadOnlyPhotoLocationRecoveryHandler({
    authenticate: () => ({ role: "viewer", userId: "user" }),
    checkGroupMembership: async () => false,
    timeoutMs: 25,
    getContainerClient: () => ({
      getBlockBlobClient: () => ({
        async getProperties() {
          return {
            etag: '"current"',
            metadata: {},
            contentType: "image/jpeg",
            contentLength: 1024,
          };
        },
        downloadToBuffer(_offset, _count, options) {
          rangeSignal = options.abortSignal;
          return new Promise(() => {});
        },
      }),
    }),
  });
  const startedAt = Date.now();
  const response = await Promise.race([
    handler(request([{
      name: "personal/user/_/hung.jpg",
      blobEtag: '"current"',
    }]), { warn: () => {} }),
    new Promise((resolve) => {
      setTimeout(() => resolve({ status: 599, body: "{}" }), 500);
    }),
  ]);
  const body = JSON.parse(response.body);

  assert.equal(response.status, 200);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(rangeSignal.aborted, true);
  assert.deepEqual(body.locations, []);
  assert.deepEqual(body.processed, []);
  assert.equal(body.truncated, true);
});
