import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import photoCatalog from "../dist/src/utils/cosmos/photoCatalog.js";
import photoCatalogRollout from "../dist/src/utils/cosmos/photoCatalogRollout.js";

const {
  CatalogNotReadyError,
  PHOTO_CATALOG_SUMMARY_ID,
  PHOTO_CATALOG_MUTATION_RECOVERY_MS,
  PHOTO_CATALOG_REBUILD_RECOVERY_MS,
  PHOTO_CATALOG_STALE_ROW_CLEANUP_LIMIT,
  PhotoCatalogMutationInProgressError,
  PhotoCatalogRebuildInProgressError,
  StalePhotoCatalogMutationError,
  StalePhotoCatalogRebuildError,
  StalePhotoCatalogCursorError,
  abandonPhotoCatalogRebuild,
  beginPhotoCatalogRebuild,
  beginPhotoCatalogMutation,
  buildPhotoCatalogRow,
  deletePhotoCatalogSnapshot,
  deleteStalePhotoCatalogRows,
  decodePhotoCatalogCursor,
  encodePhotoCatalogCursor,
  listCompletePhotoCatalog,
  listPhotoCatalogPage,
  finishPhotoCatalogMutation,
  photoCatalogBlobCopyIsStable,
  photoCatalogRowId,
  renewPhotoCatalogMutation,
  renewPhotoCatalogRebuild,
  replacePhotoCatalogSnapshot,
} = photoCatalog;
const {
  PHOTO_CATALOG_ROLLOUT_PHASE,
  photoCatalogPagingIsEnabled,
} = photoCatalogRollout;

const scope = "groups/group-a";
const activeSnapshotId = "catalog:rebuild:active";

function cosmosError(statusCode) {
  return Object.assign(new Error(`Cosmos ${statusCode}`), { statusCode });
}

function fenceState(overrides = {}) {
  const state = {
    version: 1,
    updatedAt: new Date().toISOString(),
    activeMutations: [],
    ...overrides,
  };
  state.activeMutations = state.activeMutations.map((mutation) => ({
    ...mutation,
    heartbeatAt: mutation.heartbeatAt ?? mutation.startedAt,
  }));
  if (state.rebuild) {
    state.rebuild = {
      ...state.rebuild,
      heartbeatAt: state.rebuild.heartbeatAt ?? state.rebuild.startedAt,
    };
  }
  return state;
}

function readyFenceState(
  snapshotId = activeSnapshotId,
  revision = 7,
) {
  return fenceState({
    ready: { snapshotId, revision },
  });
}

function fakeFenceStore(initialState = null) {
  let version = 1;
  let readCount = 0;
  let writeCount = 0;
  let record = initialState
    ? {
        etag: `"fence-${version}"`,
      lastModified: new Date().toISOString(),
        state: structuredClone(initialState),
      }
    : null;
  const cloneRecord = () => record
    ? {
        etag: record.etag,
        lastModified: record.lastModified,
        state: structuredClone(record.state),
      }
    : null;
  return {
    async read() {
      readCount += 1;
      return cloneRecord();
    },
    async write(_scope, expectedEtag, state) {
      writeCount += 1;
      if (
        (expectedEtag === null && record)
        || (expectedEtag !== null && record?.etag !== expectedEtag)
      ) {
        throw cosmosError(412);
      }
      record = {
        etag: `"fence-${++version}"`,
        lastModified: new Date().toISOString(),
        state: structuredClone(state),
      };
      return cloneRecord();
    },
    current() {
      return cloneRecord();
    },
    replaceState(state) {
      record = {
        etag: `"fence-${++version}"`,
        lastModified: new Date().toISOString(),
        state: structuredClone(state),
      };
    },
    replaceRecord(next) {
      record = next
        ? {
            etag: `"fence-${++version}"`,
            lastModified: next.lastModified,
            state: structuredClone(next.state),
          }
        : null;
    },
    counts() {
      return { read: readCount, write: writeCount };
    },
  };
}

function makeRow(name, sortTimeMs, overrides = {}) {
  const snapshotId = overrides.snapshotId ?? activeSnapshotId;
  return {
    id: photoCatalogRowId(snapshotId, name),
    docType: "photo-catalog",
    scope,
    snapshotId,
    name,
    active: true,
    sortTimeMs,
    sortKey: `${String(sortTimeMs).padStart(16, "0")}|${Buffer.from(name).toString("base64url")}`,
    sourceBlobEtag: `"etag-${name}"`,
    size: 100,
    lastModified: "2026-08-11T00:00:00.000Z",
    contentType: "image/jpeg",
    favorite: false,
    gpsMetadataPresent: false,
    isAnimated: false,
    catalogUpdatedAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

function fakeContainer(rows, summary = {
  id: PHOTO_CATALOG_SUMMARY_ID,
  docType: "photo-catalog-summary",
  scope,
  version: 2,
  ready: true,
  revision: 7,
  activeSnapshotId,
  total: rows.filter((row) => row.active).length,
}) {
  const queries = [];
  return {
    item(id, partitionKey) {
      return {
        async read() {
          assert.equal(id, PHOTO_CATALOG_SUMMARY_ID);
          assert.equal(partitionKey, scope);
          return { resource: summary };
        },
      };
    },
    items: {
      query(spec, options) {
        queries.push({ spec, options });
        if (spec.query.includes("photo-catalog-mutation")) {
          return {
            async fetchAll() {
              return { resources: [] };
            },
          };
        }
        const parameters = new Map(spec.parameters.map((parameter) => [
          parameter.name,
          parameter.value,
        ]));
        const after = parameters.get("@after");
        const snapshotId = parameters.get("@snapshotId");
        const take = parameters.get("@take");
        const matchingRows = rows
          .filter((row) => row.scope === parameters.get("@scope"))
          .filter((row) => row.snapshotId === snapshotId)
          .filter((row) => row.docType === "photo-catalog" && row.active)
          .filter((row) => !after || row.sortKey < after)
          .sort((left, right) => (
            left.sortKey === right.sortKey ? 0 : left.sortKey < right.sortKey ? 1 : -1
          ));
        const resources = Number.isSafeInteger(take)
          ? matchingRows.slice(0, take)
          : matchingRows;
        return {
          async fetchAll() {
            return { resources };
          },
        };
      },
    },
    queries,
  };
}

function mutableCatalogContainer(initialSummary, initialRows = [], hooks = {}) {
  let etagVersion = 1;
  let summary = {
    ...initialSummary,
    _etag: initialSummary._etag ?? `"cosmos-${etagVersion}"`,
  };
  const documents = new Map(initialRows.map((row) => [row.id, row]));
  const queries = [];
  const withEtag = (next) => ({
    ...next,
    _etag: `"cosmos-${++etagVersion}"`,
  });
  const container = {
    item(id, partitionKey) {
      assert.equal(partitionKey, scope);
      return {
        async read() {
          if (id === PHOTO_CATALOG_SUMMARY_ID) {
            return { resource: structuredClone(summary), etag: summary._etag };
          }
          const resource = documents.get(id);
          if (!resource) throw cosmosError(404);
          return { resource: structuredClone(resource) };
        },
        async replace(next, options) {
          assert.equal(id, PHOTO_CATALOG_SUMMARY_ID);
          if (options.accessCondition.condition !== summary._etag) {
            throw cosmosError(412);
          }
          if (next.ready && hooks.failReadyReplaceStatus) {
            throw cosmosError(hooks.failReadyReplaceStatus);
          }
          if (!next.ready && hooks.failUnreadyReplaceStatus) {
            throw cosmosError(hooks.failUnreadyReplaceStatus);
          }
          summary = withEtag(next);
          if (next.ready && hooks.throwAfterReadyReplace) {
            throw new Error("Cosmos response lost after ready publication");
          }
          return { resource: structuredClone(summary), etag: summary._etag };
        },
        async delete() {
          if (!documents.delete(id)) throw cosmosError(404);
          return {};
        },
      };
    },
    items: {
      async create(next) {
        if (next.id === PHOTO_CATALOG_SUMMARY_ID) {
          if (summary) throw cosmosError(409);
          summary = withEtag(next);
          return { resource: structuredClone(summary), etag: summary._etag };
        }
        if (documents.has(next.id)) throw cosmosError(409);
        documents.set(next.id, structuredClone(next));
        return { resource: structuredClone(next) };
      },
      async upsert(next) {
        if (next.docType === "photo-catalog") {
          hooks.upsertStarted?.push(next.name);
          const delayMs = next.name === hooks.failUpsertName
            ? (hooks.failUpsertDelayMs ?? 0)
            : (hooks.upsertDelayMs ?? 0);
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          if (next.name === hooks.failUpsertName) {
            hooks.upsertFinished?.push(next.name);
            throw new Error(`upsert failed for ${next.name}`);
          }
        }
        documents.set(next.id, structuredClone(next));
        if (next.docType === "photo-catalog") hooks.upsertFinished?.push(next.name);
        return { resource: structuredClone(next) };
      },
      query(spec, options) {
        queries.push({ spec, options });
        const parameters = new Map(spec.parameters.map((parameter) => [
          parameter.name,
          parameter.value,
        ]));
        return {
          async fetchAll() {
            if (spec.query.includes("photo-catalog-mutation")) {
              return {
                resources: [...documents.values()]
                  .filter((document) => document.docType === "photo-catalog-mutation")
                  .map(({ id, startedAt, _ts }) => ({ id, startedAt, _ts })),
              };
            }
            if (spec.query.includes("c.snapshotId != @activeSnapshotId")) {
              const limit = Number(spec.query.match(/SELECT TOP (\d+)/)?.[1]);
              return {
                resources: [...documents.values()]
                  .filter((document) => (
                    document.docType === "photo-catalog"
                    && document.scope === parameters.get("@scope")
                    && document.snapshotId !== parameters.get("@activeSnapshotId")
                  ))
                  .slice(0, limit)
                  .map(({ id, snapshotId }) => ({ id, snapshotId })),
              };
            }
            let resources = [...documents.values()]
              .filter((document) => document.docType === "photo-catalog")
              .filter((document) => (
                document.scope === parameters.get("@scope")
                && document.snapshotId === parameters.get("@snapshotId")
              ));
            if (spec.query.includes("SELECT c.id FROM c")) {
              return { resources: resources.map(({ id }) => ({ id })) };
            }
            resources = resources
              .filter((row) => row.active)
              .filter((row) => (
                !parameters.get("@after")
                || row.sortKey < parameters.get("@after")
              ))
              .sort((left, right) => (
                left.sortKey === right.sortKey ? 0 : left.sortKey < right.sortKey ? 1 : -1
              ));
            const take = parameters.get("@take");
            return {
              resources: Number.isSafeInteger(take)
                ? resources.slice(0, take)
                : resources,
            };
          },
        };
      },
    },
    documents,
    queries,
    getSummary() {
      return structuredClone(summary);
    },
    setSummary(next) {
      summary = withEtag(next);
    },
  };
  return container;
}

test("builds a deterministic catalog row using taken/upload/Blob time precedence", () => {
  const row = buildPhotoCatalogRow({
    name: "groups/group-a/trips/photo.jpg",
    properties: {
      contentLength: 123,
      contentType: "image/jpeg",
      etag: '"etag-v1"',
      lastModified: new Date("2026-08-08T00:00:00.000Z"),
    },
    metadata: {
      takenAt: "2026-08-10T00:00:00.000Z",
      createdAt: "2026-08-09T00:00:00.000Z",
      originalName: Buffer.from("旅行.jpg").toString("base64"),
      favorite: "1",
    },
  }, scope, activeSnapshotId, {
    thumbnailName: "groups/group-a/trips/_th_photo.webp",
  }, new Date("2026-08-11T00:00:00.000Z"));

  assert.equal(row.sortTimeMs, Date.parse("2026-08-10T00:00:00.000Z"));
  assert.equal(
    row.sortKey.split("|")[0],
    String(Date.parse("2026-08-10T00:00:00.000Z")).padStart(16, "0"),
  );
  assert.equal(row.name, "groups/group-a/trips/photo.jpg");
  assert.equal(row.folder, "trips");
  assert.equal(row.groupId, "group-a");
  assert.equal(row.originalName, "旅行.jpg");
  assert.equal(row.favorite, true);
  assert.equal(row.thumbnailName, "groups/group-a/trips/_th_photo.webp");
  assert.equal(row.sourceBlobEtag, '"etag-v1"');
  assert.equal(row.gpsMetadataPresent, false);
  assert.equal(row.active, true);

  const sameTime = buildPhotoCatalogRow({
    name: "groups/group-a/trips/other.jpg",
    properties: {
      contentLength: 1,
      contentType: "image/jpeg",
      etag: '"etag-v2"',
      lastModified: new Date("2026-08-08T00:00:00.000Z"),
    },
    metadata: { takenAt: "2026-08-10T00:00:00.000Z" },
  }, scope, activeSnapshotId, {}, new Date("2026-08-11T00:00:00.000Z"));
  assert.notEqual(row.sortKey, sameTime.sortKey);
});

test("preserves hydrated location coordinates and Blob metadata provenance", () => {
  const row = buildPhotoCatalogRow({
    name: "groups/group-a/trips/location.jpg",
    properties: {
      contentLength: 1,
      contentType: "image/jpeg",
      etag: '"etag-location"',
      lastModified: new Date("2026-08-08T00:00:00.000Z"),
    },
    metadata: {},
  }, scope, activeSnapshotId, {}, new Date("2026-08-11T00:00:00.000Z"), {
    gpsLat: "31.2304",
    gpsLon: "121.4737",
    gpsMetadataPresent: false,
  });

  assert.equal(row.gpsLat, "31.2304");
  assert.equal(row.gpsLon, "121.4737");
  assert.equal(row.gpsMetadataPresent, false);
  assert.equal(row.sourceBlobEtag, '"etag-location"');
});

test("falls back from invalid taken/upload dates to the Blob timestamp", () => {
  const row = buildPhotoCatalogRow({
    name: "groups/group-a/_/legacy.jpg",
    properties: {
      contentLength: 1,
      contentType: "image/jpeg",
      etag: '"etag-v1"',
      lastModified: new Date("2026-08-07T12:30:00.000Z"),
    },
    metadata: {
      takenAt: "not-a-date",
      createdAt: "also-invalid",
    },
  }, scope, activeSnapshotId, {}, new Date("2026-08-11T00:00:00.000Z"));

  assert.equal(row.sortTimeMs, Date.parse("2026-08-07T12:30:00.000Z"));
  assert.equal(row.folder, "");
});

test("blocks pending copies and excludes terminal incomplete copies from snapshots", () => {
  assert.equal(photoCatalogBlobCopyIsStable({ properties: {} }), true);
  assert.equal(
    photoCatalogBlobCopyIsStable({ properties: { copyStatus: "success" } }),
    true,
  );
  assert.equal(
    photoCatalogBlobCopyIsStable({ properties: { copyStatus: "aborted" } }),
    false,
  );
  assert.equal(
    photoCatalogBlobCopyIsStable({ properties: { copyStatus: "failed" } }),
    false,
  );
  assert.throws(
    () => photoCatalogBlobCopyIsStable({ properties: { copyStatus: "pending" } }),
    PhotoCatalogRebuildInProgressError,
  );
});

test("binds opaque cursors to one scope and catalog revision", () => {
  const encoded = encodePhotoCatalogCursor({
    scope,
    revision: 7,
    snapshotId: activeSnapshotId,
    after: "001754780800000|name",
  });

  assert.doesNotMatch(encoded, /[+/=]/);
  assert.deepEqual(
    decodePhotoCatalogCursor(encoded, scope, 7, activeSnapshotId),
    {
      scope,
      revision: 7,
      snapshotId: activeSnapshotId,
      after: "001754780800000|name",
    },
  );
  assert.equal(
    decodePhotoCatalogCursor(encoded, "groups/group-b", 7, activeSnapshotId),
    null,
  );
  assert.equal(
    decodePhotoCatalogCursor(encoded, scope, 7, "catalog:rebuild:other"),
    null,
  );
  assert.throws(
    () => decodePhotoCatalogCursor(
      encoded,
      scope,
      7,
      "catalog:rebuild:other",
      true,
    ),
    StalePhotoCatalogCursorError,
  );
  assert.throws(
    () => decodePhotoCatalogCursor(encoded, scope, 8, activeSnapshotId, true),
    StalePhotoCatalogCursorError,
  );
  assert.equal(
    decodePhotoCatalogCursor("not-json", scope, 7, activeSnapshotId),
    null,
  );
});

test("returns bounded stable pages from catalog rows without duplicates", async () => {
  const rows = [
    makeRow("a.jpg", 100),
    makeRow("b.jpg", 100),
    makeRow("c.jpg", 90),
    makeRow("deleted.jpg", 200, { active: false }),
  ];
  const container = fakeContainer(rows);
  const fences = fakeFenceStore(readyFenceState());

  const first = await listPhotoCatalogPage(container, {
    scope,
    limit: 2,
  }, fences);
  assert.equal(first.items.length, 2);
  assert.equal(first.total, 3);
  assert.equal(first.revision, 7);
  assert.equal(first.done, false);
  assert(first.nextCursor);

  const second = await listPhotoCatalogPage(container, {
    scope,
    limit: 2,
    cursor: first.nextCursor,
  }, fences);
  assert.equal(second.items.length, 1);
  assert.equal(second.done, true);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map((row) => row.name)).size, 3);

  const pageQueries = container.queries.filter(
    ({ spec }) => !spec.query.includes("photo-catalog-mutation"),
  );
  assert.equal(pageQueries.length, 2);
  for (const query of pageQueries) {
    assert.match(query.spec.query, /SELECT TOP @take \* FROM c/);
    assert.match(query.spec.query, /c\.docType = "photo-catalog"/);
    assert.match(query.spec.query, /c\.snapshotId = @snapshotId/);
    assert.match(query.spec.query, /c\.active = true/);
    assert.match(query.spec.query, /ORDER BY c\.sortKey DESC/);
    assert.equal(query.options.partitionKey, scope);
    assert.equal(
      new Map(query.spec.parameters.map((parameter) => [
        parameter.name,
        parameter.value,
      ])).get("@take"),
      3,
    );
    assert.equal(
      new Map(query.spec.parameters.map((parameter) => [
        parameter.name,
        parameter.value,
      ])).get("@snapshotId"),
      activeSnapshotId,
    );
  }
});

test("returns a complete ready snapshot for legacy clients without rebuilding", async () => {
  const rows = [
    makeRow("a.jpg", 100),
    makeRow("b.jpg", 90),
    makeRow("other-snapshot.jpg", 200, {
      snapshotId: "catalog:rebuild:other",
    }),
  ];
  const container = fakeContainer(rows, {
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 7,
    activeSnapshotId,
    total: 2,
  });
  const fences = fakeFenceStore(readyFenceState());

  const complete = await listCompletePhotoCatalog(container, scope, fences);
  assert.deepEqual(complete.map((row) => row.name), ["a.jpg", "b.jpg"]);
  const completeQuery = container.queries.find(
    ({ spec }) => spec.query.includes("SELECT * FROM c"),
  );
  assert(completeQuery);
  assert.match(completeQuery.spec.query, /c\.snapshotId = @snapshotId/);
  assert.match(completeQuery.spec.query, /ORDER BY c\.sortKey DESC/);
  assert.equal(completeQuery.options.partitionKey, scope);
});

test("refuses unready catalogs and stale continuation revisions", async () => {
  const row = makeRow("a.jpg", 100);
  await assert.rejects(
    () => listPhotoCatalogPage(fakeContainer([row], {
      id: PHOTO_CATALOG_SUMMARY_ID,
      docType: "photo-catalog-summary",
      scope,
      version: 2,
      ready: false,
      revision: 1,
      total: 1,
    }), { scope, limit: 2 }, fakeFenceStore()),
    CatalogNotReadyError,
  );
  await assert.rejects(
    () => listPhotoCatalogPage(fakeContainer([row], {
      id: PHOTO_CATALOG_SUMMARY_ID,
      docType: "photo-catalog-summary",
      scope,
      version: 2,
      ready: false,
      revision: 2,
      total: 1,
      rebuildId: "catalog:rebuild:active",
      rebuildStartedAt: new Date().toISOString(),
    }), { scope, limit: 2 }, fakeFenceStore(fenceState({
      rebuild: {
        id: "catalog:rebuild:active",
        startedAt: new Date().toISOString(),
      },
    }))),
    PhotoCatalogRebuildInProgressError,
  );

  const cursor = encodePhotoCatalogCursor({
    scope,
    revision: 6,
    snapshotId: activeSnapshotId,
    after: row.sortKey,
  });
  await assert.rejects(
    () => listPhotoCatalogPage(fakeContainer([row]), {
      scope,
      limit: 2,
      cursor,
    }, fakeFenceStore(readyFenceState())),
    StalePhotoCatalogCursorError,
  );
});

test("replaces a catalog snapshot behind an unready revision fence", async () => {
  let etagVersion = 4;
  const oldSnapshotId = "catalog:rebuild:old";
  let summary = {
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 4,
    total: 1,
    activeSnapshotId: oldSnapshotId,
    _etag: `"${etagVersion}"`,
  };
  const oldRow = makeRow("old.jpg", 1, { snapshotId: oldSnapshotId });
  const resources = new Map([
    [oldRow.id, oldRow],
    ["location:keep", {
      id: "location:keep",
      scope,
      name: "keep.jpg",
      lat: 1,
      lon: 2,
    }],
  ]);
  const events = [];
  const container = {
    item(id, partitionKey) {
      assert.equal(partitionKey, scope);
      return {
        async read() {
          if (id === summary.id) {
            return { resource: { ...summary }, etag: summary._etag };
          }
          const resource = resources.get(id);
          if (!resource) throw cosmosError(404);
          return { resource };
        },
        async replace(next, options) {
          assert.equal(id, summary.id);
          if (options.accessCondition.condition !== summary._etag) {
            throw cosmosError(412);
          }
          summary = { ...next, _etag: `"${++etagVersion}"` };
          events.push(`summary:${next.ready ? "ready" : "unready"}`);
          return { resource: { ...summary }, etag: summary._etag };
        },
        async delete() {
          resources.delete(id);
          events.push(`delete:${id}`);
          return {};
        },
      };
    },
    items: {
      async upsert(next) {
        if (next.id === summary.id) {
          summary = { ...next, _etag: `"${++etagVersion}"` };
          events.push(`summary:${next.ready ? "ready" : "unready"}`);
          return { resource: { ...summary }, etag: summary._etag };
        }
        resources.set(next.id, next);
        events.push(`upsert:${next.name}`);
        return { resource: next };
      },
      query(spec) {
        return {
          async fetchAll() {
            if (spec.query.includes("photo-catalog-mutation")) {
              return { resources: [] };
            }
            const parameters = new Map(spec.parameters.map((parameter) => [
              parameter.name,
              parameter.value,
            ]));
            return {
              resources: [...resources.values()]
                .filter((resource) => resource.docType === "photo-catalog")
                .filter((resource) => (
                  !parameters.has("@snapshotId")
                  || resource.snapshotId === parameters.get("@snapshotId")
                ))
                .map(({ id }) => ({ id })),
            };
          },
        };
      },
    },
  };
  const fences = fakeFenceStore(readyFenceState(oldSnapshotId, 4));
  const rebuild = await beginPhotoCatalogRebuild(
    container,
    scope,
    new Date("2026-08-11T01:00:00.000Z"),
    fences,
  );
  const snapshotRows = [
    makeRow("new-a.jpg", 3, { snapshotId: rebuild.id }),
    makeRow("new-b.jpg", 2, { snapshotId: rebuild.id }),
  ];

  const result = await replacePhotoCatalogSnapshot(
    container,
    scope,
    snapshotRows,
    new Date("2026-08-11T01:00:00.000Z"),
    rebuild,
    fences,
  );

  assert.deepEqual(result, { revision: 5, total: 2 });
  assert.deepEqual(events, [
    "summary:unready",
    "summary:unready",
    "upsert:new-a.jpg",
    "upsert:new-b.jpg",
    "summary:unready",
    "summary:ready",
  ]);
  assert.equal(summary.ready, true);
  assert.equal(summary.revision, 5);
  assert.equal(summary.total, 2);
  assert.equal(summary.activeSnapshotId, rebuild.id);
  assert.equal(summary.rebuiltAt, "2026-08-11T01:00:00.000Z");
  assert(resources.has(oldRow.id));
  assert(resources.has("location:keep"));
  await deletePhotoCatalogSnapshot(container, scope, oldSnapshotId);
  assert.equal(resources.has(oldRow.id), false);
  assert(resources.has("location:keep"));
});

test("bounds stale snapshot cleanup and resumes without touching the active snapshot", async () => {
  const oldSnapshotId = "catalog:rebuild:old";
  const failedSnapshotId = "catalog:rebuild:failed";
  const activeRow = makeRow("active.jpg", 4);
  const staleRows = [
    makeRow("old-a.jpg", 3, { snapshotId: oldSnapshotId }),
    makeRow("old-b.jpg", 2, { snapshotId: oldSnapshotId }),
    makeRow("failed.jpg", 1, { snapshotId: failedSnapshotId }),
  ];
  const locationRow = {
    id: "location:keep",
    scope,
    name: "keep.jpg",
    lat: 1,
    lon: 2,
  };
  const container = mutableCatalogContainer({
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 7,
    total: 1,
    activeSnapshotId,
  }, [activeRow, ...staleRows, locationRow]);
  const fences = fakeFenceStore(readyFenceState());

  assert.equal(PHOTO_CATALOG_STALE_ROW_CLEANUP_LIMIT, 250);
  assert.equal(
    await deleteStalePhotoCatalogRows(container, scope, 2, fences),
    2,
  );
  assert(container.documents.has(activeRow.id));
  assert(container.documents.has(locationRow.id));
  assert.equal(
    staleRows.filter((row) => container.documents.has(row.id)).length,
    1,
  );

  assert.equal(
    await deleteStalePhotoCatalogRows(container, scope, 2, fences),
    1,
  );
  assert(container.documents.has(activeRow.id));
  assert(container.documents.has(locationRow.id));
  assert.equal(
    staleRows.some((row) => container.documents.has(row.id)),
    false,
  );
});

test("stale snapshot cleanup stops before deletion when the Blob fence changes", async () => {
  const staleRow = makeRow("stale.jpg", 1, {
    snapshotId: "catalog:rebuild:stale",
  });
  const activeRow = makeRow("active.jpg", 2);
  const container = mutableCatalogContainer({
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 7,
    total: 1,
    activeSnapshotId,
  }, [activeRow, staleRow]);
  let reads = 0;
  const changingFence = {
    async read() {
      reads += 1;
      return {
        etag: `"fence-${reads}"`,
        lastModified: new Date().toISOString(),
        state: readyFenceState(),
      };
    },
    async write() {
      throw new Error("write not expected");
    },
  };

  await assert.rejects(
    () => deleteStalePhotoCatalogRows(container, scope, 10, changingFence),
    StalePhotoCatalogCursorError,
  );
  assert(container.documents.has(activeRow.id));
  assert(container.documents.has(staleRow.id));
});

test("snapshot write failure drains in-flight workers before abandoned rows are deleted", async () => {
  const upsertStarted = [];
  const upsertFinished = [];
  const container = mutableCatalogContainer({
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 7,
    total: 0,
    activeSnapshotId,
  }, [], {
    failUpsertName: "photo-00.jpg",
    failUpsertDelayMs: 5,
    upsertDelayMs: 30,
    upsertStarted,
    upsertFinished,
  });
  const fences = fakeFenceStore(readyFenceState());
  const rebuild = await beginPhotoCatalogRebuild(
    container,
    scope,
    new Date("2026-08-11T01:00:00.000Z"),
    fences,
  );
  const rows = Array.from({ length: 20 }, (_, index) => (
    makeRow(`photo-${String(index).padStart(2, "0")}.jpg`, 20 - index, {
      snapshotId: rebuild.id,
    })
  ));

  await assert.rejects(
    () => replacePhotoCatalogSnapshot(
      container,
      scope,
      rows,
      new Date("2026-08-11T01:00:00.000Z"),
      rebuild,
      fences,
    ),
    /upsert failed for photo-00\.jpg/,
  );
  assert.equal(upsertStarted.length, 12, "no queued row may start after the first failure");
  assert.equal(upsertFinished.length, 12, "the rejection must wait for every started write");

  await abandonPhotoCatalogRebuild(container, rebuild, fences);
  assert.equal(
    [...container.documents.values()].some((row) => row.snapshotId === rebuild.id),
    false,
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(
    [...container.documents.values()].some((row) => row.snapshotId === rebuild.id),
    false,
    "no in-flight writer may recreate an abandoned snapshot after cleanup",
  );
});

test("keeps a superseded rebuild isolated from the published snapshot", async () => {
  let etagVersion = 1;
  const oldSnapshotId = "catalog:rebuild:old";
  let summary = {
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 1,
    total: 1,
    activeSnapshotId: oldSnapshotId,
    _etag: `"${etagVersion}"`,
  };
  const oldRow = makeRow("same.jpg", 1, {
    snapshotId: oldSnapshotId,
    subject: "old",
  });
  const documents = new Map([[oldRow.id, oldRow]]);
  const container = {
    item(id, partitionKey) {
      assert.equal(partitionKey, scope);
      return {
        async read() {
          if (id === summary.id) return { resource: { ...summary }, etag: summary._etag };
          const resource = documents.get(id);
          if (!resource) throw cosmosError(404);
          return { resource };
        },
        async replace(next, options) {
          assert.equal(id, summary.id);
          if (options.accessCondition.condition !== summary._etag) {
            throw cosmosError(412);
          }
          summary = {
            ...next,
            _etag: `"${++etagVersion}"`,
            _ts: next.rebuildHeartbeatAt
              ? Math.floor(Date.parse(next.rebuildHeartbeatAt) / 1000)
              : summary._ts,
          };
          return { resource: { ...summary }, etag: summary._etag };
        },
        async delete() {
          documents.delete(id);
          return {};
        },
      };
    },
    items: {
      async upsert(next) {
        if (next.id === summary.id) {
          summary = {
            ...next,
            _etag: `"${++etagVersion}"`,
            _ts: next.rebuildHeartbeatAt
              ? Math.floor(Date.parse(next.rebuildHeartbeatAt) / 1000)
              : summary._ts,
          };
          return { resource: { ...summary }, etag: summary._etag };
        }
        documents.set(next.id, next);
        return { resource: next };
      },
      query(spec) {
        const parameters = new Map(spec.parameters.map((parameter) => [
          parameter.name,
          parameter.value,
        ]));
        if (spec.query.includes("photo-catalog-mutation")) {
          return {
            async fetchAll() {
              return { resources: [] };
            },
          };
        }
        const snapshotId = parameters.get("@snapshotId");
        const matchingRows = [...documents.values()]
          .filter((document) => document.docType === "photo-catalog")
          .filter((document) => document.snapshotId === snapshotId);
        if (spec.query.includes("SELECT c.id FROM c")) {
          return {
            async fetchAll() {
              return { resources: matchingRows.map(({ id }) => ({ id })) };
            },
          };
        }
        const after = parameters.get("@after");
        const take = parameters.get("@take");
        return {
          async fetchAll() {
            return {
              resources: matchingRows
                .filter((row) => row.active)
                .filter((row) => !after || row.sortKey < after)
                .sort((left, right) => (
                  left.sortKey === right.sortKey
                    ? 0
                    : left.sortKey < right.sortKey ? 1 : -1
                ))
                .slice(0, take),
            };
          },
        };
      },
    },
  };
  const fences = fakeFenceStore(readyFenceState(oldSnapshotId, 1));

  const staleStartedAt = new Date("2026-08-11T01:00:00.000Z");
  const staleRebuild = await beginPhotoCatalogRebuild(
    container,
    scope,
    staleStartedAt,
    fences,
  );
  const currentRebuild = await beginPhotoCatalogRebuild(
    container,
    scope,
    new Date(staleStartedAt.getTime() + PHOTO_CATALOG_REBUILD_RECOVERY_MS + 1),
    fences,
  );
  const currentRow = makeRow("same.jpg", 3, {
    snapshotId: currentRebuild.id,
    subject: "current",
  });
  await replacePhotoCatalogSnapshot(
    container,
    scope,
    [currentRow],
    new Date("2026-08-11T01:03:00.001Z"),
    currentRebuild,
    fences,
  );

  const staleRow = makeRow("same.jpg", 2, {
    snapshotId: staleRebuild.id,
    subject: "stale",
  });
  await assert.rejects(
    () => replacePhotoCatalogSnapshot(
      container,
      scope,
      [staleRow],
      new Date("2026-08-11T01:04:00.000Z"),
      staleRebuild,
      fences,
    ),
    StalePhotoCatalogRebuildError,
  );

  const page = await listPhotoCatalogPage(container, { scope, limit: 24 }, fences);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].subject, "current");
  assert.equal(page.items[0].snapshotId, currentRebuild.id);
  assert(documents.has(currentRow.id));
  assert.equal(documents.has(staleRow.id), false);

  await abandonPhotoCatalogRebuild(container, staleRebuild, fences);
  assert(documents.has(currentRow.id));
  assert.equal(documents.has(staleRow.id), false);
});

test("acquires a rebuild fence against the latest summary with If-Match", async () => {
  let etagVersion = 1;
  let replaceAttempts = 0;
  const originalSnapshotId = "catalog:rebuild:original";
  const concurrentlyPublishedSnapshotId = "catalog:rebuild:concurrent";
  let summary = {
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 1,
    total: 1,
    activeSnapshotId: originalSnapshotId,
    _etag: `"${etagVersion}"`,
  };
  const container = {
    item(id, partitionKey) {
      assert.equal(id, PHOTO_CATALOG_SUMMARY_ID);
      assert.equal(partitionKey, scope);
      return {
        async read() {
          return { resource: { ...summary }, etag: summary._etag };
        },
        async replace(next, options) {
          replaceAttempts += 1;
          if (replaceAttempts === 1) {
            summary = {
              ...summary,
              ready: true,
              revision: 2,
              activeSnapshotId: concurrentlyPublishedSnapshotId,
              _etag: `"${++etagVersion}"`,
            };
            throw cosmosError(412);
          }
          assert.equal(options.accessCondition.condition, summary._etag);
          summary = { ...next, _etag: `"${++etagVersion}"` };
          return { resource: { ...summary }, etag: summary._etag };
        },
      };
    },
    items: {
      async create() {
        throw new Error("existing summaries must use conditional replace");
      },
      query(spec) {
        assert.match(spec.query, /photo-catalog-mutation/);
        return {
          async fetchAll() {
            return { resources: [] };
          },
        };
      },
    },
  };

  const fences = fakeFenceStore(readyFenceState(originalSnapshotId, 1));
  const rebuild = await beginPhotoCatalogRebuild(container, scope, new Date(), fences);
  assert.equal(replaceAttempts, 2);
  assert.equal(rebuild.revision, 3);
  assert.equal(rebuild.previousSnapshotId, concurrentlyPublishedSnapshotId);
  assert.equal(summary.revision, 3);
  assert.equal(summary.ready, false);
  assert.equal(summary.activeSnapshotId, concurrentlyPublishedSnapshotId);
  assert.equal(summary.rebuildId, rebuild.id);
});

test("journals mutations and keeps paging fail-closed until completion", async () => {
  let etagVersion = 1;
  let summary = {
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 3,
    total: 1,
    activeSnapshotId,
    _etag: `"${etagVersion}"`,
  };
  const documents = new Map();
  const rows = [makeRow("a.jpg", 100)];
  let injectMutationOnFence = false;
  const container = {
    item(id, partitionKey) {
      assert.equal(partitionKey, scope);
      return {
        async read() {
          if (id === summary.id) return { resource: { ...summary }, etag: summary._etag };
          const resource = documents.get(id);
          if (!resource) throw cosmosError(404);
          return { resource };
        },
        async replace(next, options) {
          assert.equal(id, summary.id);
          if (options.accessCondition.condition !== summary._etag) {
            throw cosmosError(412);
          }
          summary = { ...next, _etag: `"${++etagVersion}"` };
          if (injectMutationOnFence && next.rebuildId) {
            injectMutationOnFence = false;
            documents.set("catalog:mutation:race", {
              id: "catalog:mutation:race",
              docType: "photo-catalog-mutation",
              scope,
              names: ["groups/group-a/_/race.jpg"],
              startedAt: new Date().toISOString(),
            });
          }
          return { resource: summary, etag: summary._etag };
        },
        async delete() {
          documents.delete(id);
          return {};
        },
      };
    },
    items: {
      async upsert(next) {
        if (next.id === summary.id) {
          summary = { ...next, _etag: `"${++etagVersion}"` };
          return { resource: summary, etag: summary._etag };
        }
        documents.set(next.id, next);
        return { resource: next, etag: `"doc-${documents.size}"` };
      },
      async create(next) {
        if (next.id === summary.id) {
          summary = { ...next, _etag: `"${++etagVersion}"` };
          return { resource: summary, etag: summary._etag };
        }
        next._ts = Math.floor(Date.parse(next.startedAt) / 1000);
        documents.set(next.id, next);
        return { resource: next, etag: `"doc-${documents.size}"` };
      },
      query(spec) {
        const parameters = new Map(spec.parameters.map((parameter) => [
          parameter.name,
          parameter.value,
        ]));
        if (spec.query.includes("photo-catalog-mutation")) {
          return {
            async fetchAll() {
              return {
                resources: [...documents.values()]
                  .filter((document) => document.docType === "photo-catalog-mutation")
                  .map(({ id, startedAt, _ts }) => ({ id, startedAt, _ts })),
              };
            },
          };
        }
        if (spec.query.includes("SELECT c.id FROM c")) {
          return {
            async fetchAll() {
              return {
                resources: [...rows, ...documents.values()]
                  .filter((document) => document.docType === "photo-catalog")
                  .filter((document) => (
                    document.snapshotId === parameters.get("@snapshotId")
                  ))
                  .map(({ id }) => ({ id })),
              };
            },
          };
        }
        return {
          async fetchAll() {
            return {
              resources: rows.filter((row) => (
                row.snapshotId === parameters.get("@snapshotId")
              )),
            };
          },
        };
      },
    },
  };
  const fences = fakeFenceStore(readyFenceState(activeSnapshotId, 3));

  const handle = await beginPhotoCatalogMutation(
    scope,
    ["groups/group-a/_/a.jpg"],
    container,
    fences,
  );
  assert.equal(summary.ready, false);
  assert.equal(summary.revision, 4);
  assert(documents.has(handle.id));
  await assert.rejects(
    () => listPhotoCatalogPage(container, { scope, limit: 1 }, fences),
    PhotoCatalogMutationInProgressError,
  );
  await assert.rejects(
    () => replacePhotoCatalogSnapshot(
      container,
      scope,
      [],
      new Date(handle.startedAt),
      undefined,
      fences,
    ),
    PhotoCatalogMutationInProgressError,
  );

  await finishPhotoCatalogMutation(handle, container, fences);
  assert.equal(summary.ready, false);
  assert.equal(summary.revision, 5);
  assert.equal(documents.has(handle.id), false);

  const staleRebuild = await beginPhotoCatalogRebuild(
    container,
    scope,
    new Date(),
    fences,
  );
  const concurrentMutation = await beginPhotoCatalogMutation(
    scope,
    ["groups/group-a/_/during-scan.jpg"],
    container,
    fences,
  );
  await finishPhotoCatalogMutation(concurrentMutation, container, fences);
  assert.equal(summary.rebuildId, staleRebuild.id);
  await assert.rejects(
    () => replacePhotoCatalogSnapshot(
      container,
      scope,
      [],
      new Date(),
      staleRebuild,
      fences,
    ),
    StalePhotoCatalogRebuildError,
  );
  assert.equal(summary.ready, false);
  await abandonPhotoCatalogRebuild(container, staleRebuild, fences);
  assert.equal(summary.rebuildId, undefined);
  assert.equal(summary.rebuildStartedAt, undefined);

  injectMutationOnFence = true;
  await assert.rejects(
    () => replacePhotoCatalogSnapshot(
      container,
      scope,
      [],
      new Date(),
      undefined,
      fences,
    ),
    PhotoCatalogMutationInProgressError,
  );
  assert.equal(summary.ready, false);
  assert(documents.has("catalog:mutation:race"));
  assert.equal(summary.rebuildId, undefined);
  assert.equal(summary.rebuildStartedAt, undefined);
  documents.delete("catalog:mutation:race");

  const orphan = await beginPhotoCatalogMutation(
    scope,
    ["groups/group-a/_/orphan.jpg"],
    container,
    fences,
  );
  orphan.startedAt = new Date(
    Date.now() - PHOTO_CATALOG_MUTATION_RECOVERY_MS - 1,
  ).toISOString();
  orphan._ts = Math.floor(Date.parse(orphan.startedAt) / 1000);
  const orphanFence = fences.current();
  orphanFence.state.activeMutations[0].startedAt = orphan.startedAt;
  orphanFence.state.activeMutations[0].heartbeatAt = orphan.startedAt;
  fences.replaceState(orphanFence.state);
  await assert.rejects(
    () => listPhotoCatalogPage(container, { scope, limit: 1 }, fences),
    CatalogNotReadyError,
  );
  await replacePhotoCatalogSnapshot(
    container,
    scope,
    [],
    new Date(),
    undefined,
    fences,
  );
  assert.equal(documents.has(orphan.id), false);
  assert.equal(summary.ready, true);
  assert.equal(summary.total, 0);
});

test("tracks concurrent Blob mutations independently and finishes them out of order", async () => {
  const container = mutableCatalogContainer({
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 1,
    activeSnapshotId,
    total: 1,
  });

  const fences = fakeFenceStore(readyFenceState(activeSnapshotId, 1));
  const first = await beginPhotoCatalogMutation(
    scope,
    ["groups/group-a/_/a.jpg"],
    container,
    fences,
  );
  const second = await beginPhotoCatalogMutation(
    scope,
    ["groups/group-a/_/b.jpg"],
    container,
    fences,
  );

  assert.deepEqual(
    fences.current().state.activeMutations.map(({ id }) => id).sort(),
    [first.id, second.id].sort(),
  );
  assert.equal(fences.current().state.ready, undefined);

  await finishPhotoCatalogMutation(second, container, fences);
  assert.deepEqual(
    fences.current().state.activeMutations.map(({ id }) => id),
    [first.id],
  );
  await finishPhotoCatalogMutation(first, container, fences);
  assert.deepEqual(fences.current().state.activeMutations, []);
  assert.equal(fences.current().state.ready, undefined);
});

test("renews mutation leases and rejects a writer after its token is reclaimed", async () => {
  const container = mutableCatalogContainer({
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 1,
    activeSnapshotId,
    total: 1,
  });
  const fences = fakeFenceStore(readyFenceState(activeSnapshotId, 1));
  const mutation = await beginPhotoCatalogMutation(
    scope,
    ["groups/group-a/_/lease.jpg"],
    container,
    fences,
  );
  const oldHeartbeat = new Date(
    Date.now() - PHOTO_CATALOG_MUTATION_RECOVERY_MS,
  ).toISOString();
  const staleRecord = fences.current();
  staleRecord.state.activeMutations[0].heartbeatAt = oldHeartbeat;
  fences.replaceState(staleRecord.state);
  mutation.blobFenceHeartbeatAt = oldHeartbeat;

  await renewPhotoCatalogMutation(mutation, fences, true);
  assert.notEqual(
    fences.current().state.activeMutations[0].heartbeatAt,
    oldHeartbeat,
  );

  fences.replaceState(fenceState());
  await assert.rejects(
    () => renewPhotoCatalogMutation(mutation, fences, true),
    StalePhotoCatalogMutationError,
  );
});

test("keeps an old mutation active while its Blob heartbeat is fresh", async () => {
  const oldStartedAt = new Date(
    Date.now() - PHOTO_CATALOG_MUTATION_RECOVERY_MS - 1,
  ).toISOString();
  const container = mutableCatalogContainer({
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: false,
    revision: 2,
    activeSnapshotId,
    total: 1,
  });
  container.documents.set("catalog:mutation:alive", {
    id: "catalog:mutation:alive",
    docType: "photo-catalog-mutation",
    scope,
    names: ["groups/group-a/_/alive.jpg"],
    startedAt: oldStartedAt,
  });
  const fences = fakeFenceStore(fenceState({
    activeMutations: [{
      id: "catalog:mutation:alive",
      startedAt: oldStartedAt,
      heartbeatAt: new Date().toISOString(),
    }],
  }));

  await assert.rejects(
    () => beginPhotoCatalogRebuild(container, scope, new Date(), fences),
    PhotoCatalogMutationInProgressError,
  );
  assert.equal(container.getSummary().rebuildId, undefined);
  assert(container.documents.has("catalog:mutation:alive"));
});

test("renews both rebuild fences so a live scan cannot be reclaimed", async () => {
  const oldStartedAt = new Date(
    Date.now() - PHOTO_CATALOG_REBUILD_RECOVERY_MS - 1,
  );
  const container = mutableCatalogContainer({
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 1,
    activeSnapshotId,
    total: 1,
  });
  const fences = fakeFenceStore(readyFenceState(activeSnapshotId, 1));
  const rebuild = await beginPhotoCatalogRebuild(
    container,
    scope,
    oldStartedAt,
    fences,
  );
  const firstBlobEtag = rebuild.blobFenceEtag;
  const firstCosmosEtag = rebuild.fenceEtag;

  await renewPhotoCatalogRebuild(rebuild, container, fences, true);

  const renewedSummary = container.getSummary();
  assert.equal(renewedSummary.rebuildId, rebuild.id);
  assert.equal(renewedSummary.rebuildHeartbeatAt, rebuild.blobFenceHeartbeatAt);
  assert.notEqual(rebuild.blobFenceEtag, firstBlobEtag);
  assert.notEqual(rebuild.fenceEtag, firstCosmosEtag);
  assert.equal(
    fences.current().state.rebuild.heartbeatAt,
    rebuild.blobFenceHeartbeatAt,
  );

  await assert.rejects(
    () => beginPhotoCatalogRebuild(container, scope, new Date(), fences),
    PhotoCatalogRebuildInProgressError,
  );
  assert.equal(container.getSummary().rebuildId, rebuild.id);
});

test("lets a late mutation finish invalidate a newer catalog publication", async () => {
  const container = mutableCatalogContainer({
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 1,
    activeSnapshotId,
    total: 1,
  });
  const fences = fakeFenceStore(readyFenceState(activeSnapshotId, 1));
  const mutation = await beginPhotoCatalogMutation(
    scope,
    ["groups/group-a/_/late.jpg"],
    container,
    fences,
  );
  const replacementSnapshotId = "catalog:rebuild:replacement";
  container.documents.delete(mutation.id);
  container.setSummary({
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 9,
    activeSnapshotId: replacementSnapshotId,
    total: 2,
  });
  fences.replaceState(readyFenceState(replacementSnapshotId, 9));

  await finishPhotoCatalogMutation(mutation, container, fences);

  assert.equal(container.getSummary().ready, false);
  assert.equal(fences.current().state.ready, undefined);
  assert.deepEqual(fences.current().state.activeMutations, []);
});

test("keeps the Blob fence invalid when late-finish Cosmos cleanup fails", async () => {
  const hooks = {};
  const container = mutableCatalogContainer({
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 1,
    activeSnapshotId,
    total: 1,
  }, [], hooks);
  const fences = fakeFenceStore(readyFenceState(activeSnapshotId, 1));
  const mutation = await beginPhotoCatalogMutation(
    scope,
    ["groups/group-a/_/late-failure.jpg"],
    container,
    fences,
  );
  const replacementSnapshotId = "catalog:rebuild:replacement";
  container.setSummary({
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 9,
    activeSnapshotId: replacementSnapshotId,
    total: 2,
  });
  fences.replaceState(readyFenceState(replacementSnapshotId, 9));
  hooks.failUnreadyReplaceStatus = 500;

  await assert.rejects(
    () => finishPhotoCatalogMutation(mutation, container, fences),
    /Cosmos 500/,
  );

  assert.equal(fences.current().state.ready, undefined);
  assert(container.documents.has(mutation.id));
  assert.equal(container.getSummary().ready, true);
});

test("fails closed on recent malformed or future Blob fences and recovers expired damage", async () => {
  const recentContainer = mutableCatalogContainer({
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 1,
    activeSnapshotId,
    total: 1,
  });
  const recentMalformed = fakeFenceStore();
  recentMalformed.replaceRecord({
    lastModified: new Date().toISOString(),
    state: null,
  });
  await assert.rejects(
    () => beginPhotoCatalogMutation(
      scope,
      ["groups/group-a/_/blocked.jpg"],
      recentContainer,
      recentMalformed,
    ),
    CatalogNotReadyError,
  );
  assert.equal(recentMalformed.counts().write, 0);
  assert.equal(
    [...recentContainer.documents.values()]
      .some(({ docType }) => docType === "photo-catalog-mutation"),
    false,
  );

  const expiredContainer = mutableCatalogContainer({
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 1,
    activeSnapshotId,
    total: 1,
  });
  const expiredMalformed = fakeFenceStore();
  expiredMalformed.replaceRecord({
    lastModified: new Date(
      Date.now() - PHOTO_CATALOG_MUTATION_RECOVERY_MS - 1,
    ).toISOString(),
    state: null,
  });
  const recovered = await beginPhotoCatalogMutation(
    scope,
    ["groups/group-a/_/recovered.jpg"],
    expiredContainer,
    expiredMalformed,
  );
  assert.deepEqual(
    expiredMalformed.current().state.activeMutations.map(({ id }) => id),
    [recovered.id],
  );

  const futureFence = fakeFenceStore(readyFenceState());
  futureFence.replaceState({
    ...readyFenceState(),
    updatedAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  });
  const futureContainer = fakeContainer([makeRow("a.jpg", 1)]);
  await assert.rejects(
    () => listPhotoCatalogPage(
      futureContainer,
      { scope, limit: 1 },
      futureFence,
    ),
    CatalogNotReadyError,
  );
  assert.equal(futureContainer.queries.length, 0);

  const futureHeartbeatFence = fakeFenceStore(fenceState({
    activeMutations: [{
      id: "catalog:mutation:future",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    }],
  }));
  const futureHeartbeatContainer = fakeContainer([makeRow("a.jpg", 1)]);
  await assert.rejects(
    () => listPhotoCatalogPage(
      futureHeartbeatContainer,
      { scope, limit: 1 },
      futureHeartbeatFence,
    ),
    CatalogNotReadyError,
  );
  assert.equal(futureHeartbeatContainer.queries.length, 0);
});

test("recovers malformed or future Cosmos owners only after their server timestamps expire", async () => {
  const now = new Date();
  const futureTimestamp = new Date(now.getTime() + 5 * 60_000).toISOString();
  const recentSummary = {
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: false,
    revision: 2,
    activeSnapshotId,
    total: 1,
    rebuildId: "catalog:rebuild:future",
    rebuildStartedAt: futureTimestamp,
    rebuildHeartbeatAt: futureTimestamp,
    _ts: Math.floor(now.getTime() / 1000),
  };
  const recentContainer = mutableCatalogContainer(recentSummary);
  const recentFences = fakeFenceStore(readyFenceState(activeSnapshotId, 1));

  await assert.rejects(
    () => beginPhotoCatalogRebuild(recentContainer, scope, now, recentFences),
    PhotoCatalogRebuildInProgressError,
  );
  assert.equal(recentContainer.getSummary().rebuildId, recentSummary.rebuildId);

  for (const invalidTimestamp of [undefined, "0"]) {
    const malformedContainer = mutableCatalogContainer({
      ...recentSummary,
      rebuildStartedAt: invalidTimestamp,
      rebuildHeartbeatAt: invalidTimestamp,
    });
    await assert.rejects(
      () => beginPhotoCatalogRebuild(
        malformedContainer,
        scope,
        now,
        fakeFenceStore(readyFenceState(activeSnapshotId, 1)),
      ),
      PhotoCatalogRebuildInProgressError,
    );
    assert.equal(malformedContainer.getSummary().rebuildId, recentSummary.rebuildId);
  }

  const oldTimestamp = new Date(
    now.getTime() - PHOTO_CATALOG_REBUILD_RECOVERY_MS - 2_000,
  ).toISOString();
  const recentlyWrittenOldClaim = mutableCatalogContainer({
    ...recentSummary,
    rebuildStartedAt: oldTimestamp,
    rebuildHeartbeatAt: oldTimestamp,
  });
  await assert.rejects(
    () => beginPhotoCatalogRebuild(
      recentlyWrittenOldClaim,
      scope,
      now,
      fakeFenceStore(readyFenceState(activeSnapshotId, 1)),
    ),
    PhotoCatalogRebuildInProgressError,
  );

  const expiredServerTimestamp = Math.floor(
    (now.getTime() - PHOTO_CATALOG_REBUILD_RECOVERY_MS - 2_000) / 1000,
  );
  const expiredContainer = mutableCatalogContainer({
    ...recentSummary,
    _ts: expiredServerTimestamp,
  });
  const expiredFences = fakeFenceStore(readyFenceState(activeSnapshotId, 1));
  const recoveredRebuild = await beginPhotoCatalogRebuild(
    expiredContainer,
    scope,
    now,
    expiredFences,
  );
  assert.notEqual(recoveredRebuild.id, recentSummary.rebuildId);
  assert.equal(expiredContainer.getSummary().rebuildId, recoveredRebuild.id);

  const futureMutation = {
    id: "catalog:mutation:future",
    docType: "photo-catalog-mutation",
    scope,
    names: ["groups/group-a/_/future.jpg"],
    startedAt: futureTimestamp,
    _ts: Math.floor(now.getTime() / 1000),
  };
  const recentMutationContainer = mutableCatalogContainer({
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: false,
    revision: 2,
    activeSnapshotId,
    total: 1,
  });
  recentMutationContainer.documents.set(futureMutation.id, futureMutation);
  await assert.rejects(
    () => beginPhotoCatalogRebuild(
      recentMutationContainer,
      scope,
      now,
      fakeFenceStore(fenceState()),
    ),
    PhotoCatalogMutationInProgressError,
  );

  const malformedMutationContainer = mutableCatalogContainer({
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: false,
    revision: 2,
    activeSnapshotId,
    total: 1,
  });
  malformedMutationContainer.documents.set(futureMutation.id, {
    ...futureMutation,
    startedAt: "0",
  });
  await assert.rejects(
    () => beginPhotoCatalogRebuild(
      malformedMutationContainer,
      scope,
      now,
      fakeFenceStore(fenceState()),
    ),
    PhotoCatalogMutationInProgressError,
  );

  const expiredMutationContainer = mutableCatalogContainer({
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: false,
    revision: 2,
    activeSnapshotId,
    total: 1,
  });
  expiredMutationContainer.documents.set(futureMutation.id, {
    ...futureMutation,
    _ts: Math.floor(
      (now.getTime() - PHOTO_CATALOG_MUTATION_RECOVERY_MS - 2_000) / 1000,
    ),
  });
  const recoveredMutationRebuild = await beginPhotoCatalogRebuild(
    expiredMutationContainer,
    scope,
    now,
    fakeFenceStore(fenceState()),
  );
  assert.equal(
    expiredMutationContainer.getSummary().rebuildId,
    recoveredMutationRebuild.id,
  );
});

test("rejects a session-stale Cosmos summary against the authoritative Blob marker", async () => {
  const staleRow = makeRow("stale.jpg", 1);
  const staleContainer = fakeContainer([staleRow]);
  const currentSnapshotId = "catalog:rebuild:current";
  const fences = fakeFenceStore(readyFenceState(currentSnapshotId, 8));

  await assert.rejects(
    () => listPhotoCatalogPage(
      staleContainer,
      { scope, limit: 24 },
      fences,
    ),
    StalePhotoCatalogCursorError,
  );
  assert.equal(staleContainer.queries.length, 0);
});

test("rejects a page when the Blob fence changes while Cosmos rows are queried", async () => {
  const container = fakeContainer([makeRow("a.jpg", 1)]);
  const backingStore = fakeFenceStore(readyFenceState());
  let reads = 0;
  const changingStore = {
    async read(readScope) {
      const record = await backingStore.read(readScope);
      reads += 1;
      if (reads === 1) {
        backingStore.replaceState(fenceState({
          activeMutations: [{
            id: "catalog:mutation:late",
            startedAt: new Date().toISOString(),
          }],
        }));
      }
      return record;
    },
    write: (...args) => backingStore.write(...args),
  };

  await assert.rejects(
    () => listPhotoCatalogPage(
      container,
      { scope, limit: 1 },
      changingStore,
    ),
    StalePhotoCatalogCursorError,
  );
  assert.equal(
    container.queries.filter(({ spec }) => spec.query.includes("SELECT TOP")).length,
    1,
  );
});

test("rolls back the ready Blob marker when conditional Cosmos publication loses", async () => {
  const hooks = {};
  const oldSnapshotId = "catalog:rebuild:old";
  const container = mutableCatalogContainer({
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 1,
    activeSnapshotId: oldSnapshotId,
    total: 1,
  }, [makeRow("old.jpg", 1, { snapshotId: oldSnapshotId })], hooks);
  const fences = fakeFenceStore(readyFenceState(oldSnapshotId, 1));
  const rebuild = await beginPhotoCatalogRebuild(
    container,
    scope,
    new Date(),
    fences,
  );
  hooks.failReadyReplaceStatus = 412;
  const row = makeRow("new.jpg", 2, { snapshotId: rebuild.id });

  await assert.rejects(
    () => replacePhotoCatalogSnapshot(
      container,
      scope,
      [row],
      new Date(),
      rebuild,
      fences,
    ),
    StalePhotoCatalogRebuildError,
  );
  assert.equal(fences.current().state.ready, undefined);
  assert.equal(fences.current().state.rebuild, undefined);
  assert.equal(container.getSummary().ready, false);
});

test("accepts an ambiguous Cosmos response only after exact publication read-back", async () => {
  const hooks = { throwAfterReadyReplace: true };
  const oldSnapshotId = "catalog:rebuild:old";
  const container = mutableCatalogContainer({
    id: PHOTO_CATALOG_SUMMARY_ID,
    docType: "photo-catalog-summary",
    scope,
    version: 2,
    ready: true,
    revision: 1,
    activeSnapshotId: oldSnapshotId,
    total: 1,
  }, [], hooks);
  const fences = fakeFenceStore(readyFenceState(oldSnapshotId, 1));
  const rebuild = await beginPhotoCatalogRebuild(
    container,
    scope,
    new Date(),
    fences,
  );
  const row = makeRow("new.jpg", 2, { snapshotId: rebuild.id });

  const result = await replacePhotoCatalogSnapshot(
    container,
    scope,
    [row],
    new Date(),
    rebuild,
    fences,
  );

  assert.deepEqual(result, { revision: 2, total: 1 });
  assert.deepEqual(fences.current().state.ready, {
    snapshotId: rebuild.id,
    revision: 2,
  });
  assert.equal(container.getSummary().activeSnapshotId, rebuild.id);
});

test("wires every active-photo mutation through the durable catalog fence", () => {
  const mutationFiles = [
    ["../src/functions/photos/uploadPhoto.ts", "await blockBlobClient.uploadData(", true],
    ["../src/functions/photos/updatePhotoMetadata.ts", "await blockBlobClient.setMetadata(", true],
    ["../src/functions/photos/deletePhoto.ts", "await blockBlobClient.setMetadata(", true],
    ["../src/functions/trash/restorePhoto.ts", "await blockBlobClient.setMetadata(", true],
    ["../src/functions/trash/deleteTrashItem.ts", "await blockBlobClient.deleteIfExists(", true],
    ["../src/functions/photos/movePhoto.ts", "await copyBlobForMove(", false],
    ["../src/functions/photos/renameFolder.ts", "await renameFolderBlobs(", false],
    ["../src/functions/photos/backfillPhotoMetadata.ts", "await blockBlobClient.setMetadata(", true],
    ["../src/functions/photos/backfillThumbnails.ts", "await thumbClient.uploadData(", true],
    ["../src/functions/photos/setVideoThumbnail.ts", "await thumbClient.uploadData(", true],
  ];

  for (const [relativePath, mutation, renewsBeforeCall] of mutationFiles) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    const begin = source.indexOf("await beginPhotoCatalogMutation(");
    const renew = source.indexOf("renewPhotoCatalogMutation(", begin);
    const mutate = source.indexOf(mutation);
    const finish = source.lastIndexOf("await finishPhotoCatalogMutation(");
    assert.notEqual(begin, -1, `${relativePath} must begin a catalog mutation`);
    assert.notEqual(renew, -1, `${relativePath} must renew its catalog mutation`);
    assert.notEqual(mutate, -1, `${relativePath} mutation probe must remain live`);
    assert.notEqual(finish, -1, `${relativePath} must finish the catalog mutation`);
    assert(begin < mutate, `${relativePath} must fence the catalog before Blob mutation`);
    if (renewsBeforeCall) {
      assert(renew < mutate, `${relativePath} must assert its lease before Blob mutation`);
    } else {
      assert(
        renew < finish,
        `${relativePath} must pass its lease assertion into the Blob mutation`,
      );
    }
    assert(mutate < finish, `${relativePath} must finish the fence after Blob mutation`);
    assert(
      source.lastIndexOf("finally", finish) < finish,
      `${relativePath} must finish the catalog fence from a finally path`,
    );
    assert(
      source.indexOf("Photo catalog finalization failed", finish) > finish,
      `${relativePath} must preserve the media result when catalog finalization fails`,
    );
  }

  const metadataBackfill = readFileSync(
    new URL("../src/functions/photos/backfillPhotoMetadata.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    metadataBackfill,
    /const catalogMutation = dryRun\s*\?\s*null\s*:\s*await beginPhotoCatalogMutation/,
    "metadata dry-runs must remain read-only",
  );
});

test("keeps paged reads on Cosmos and legacy materialization behind the page branch", () => {
  const listPhotos = readFileSync(
    new URL("../src/functions/photos/listPhotos.ts", import.meta.url),
    "utf8",
  );
  const catalog = readFileSync(
    new URL("../src/utils/cosmos/photoCatalog.ts", import.meta.url),
    "utf8",
  );
  const locations = readFileSync(
    new URL("../src/functions/photos/getPhotoLocations.ts", import.meta.url),
    "utf8",
  );
  const rollout = readFileSync(
    new URL("../src/utils/cosmos/photoCatalogRollout.ts", import.meta.url),
    "utf8",
  );

  assert(
    listPhotos.indexOf("if (pagedRequest)") < listPhotos.indexOf("getBlobServiceClient()"),
    "bounded photo pages must return before the legacy Blob scan",
  );
  assert.match(listPhotos, /await listPhotoCatalogPage\(/);
  assert.equal(PHOTO_CATALOG_ROLLOUT_PHASE, "enabled");
  assert.equal(photoCatalogPagingIsEnabled(), true);
  assert.equal(photoCatalogPagingIsEnabled("writers-only"), false);
  assert.match(
    listPhotos,
    /if \(pagedRequest && !catalogPagingEnabled\)/,
    "the rollback phase must make paged reads fall back",
  );
  assert.match(
    listPhotos,
    /const catalogContainer = catalogPagingEnabled && catalogScope/,
    "writers-only rollback must not materialize a catalog",
  );
  assert.match(
    rollout,
    /PHOTO_CATALOG_ROLLOUT_PHASE: PhotoCatalogRolloutPhase = "enabled"/,
    "paging activation must remain an explicit rollout value",
  );
  assert(
    listPhotos.indexOf("await listCompletePhotoCatalog(")
      < listPhotos.indexOf("await beginPhotoCatalogRebuild("),
    "ready legacy requests must reuse the active snapshot before considering a rebuild",
  );
  assert.match(listPhotos, /await replacePhotoCatalogSnapshot\(/);
  assert.equal(
    (listPhotos.match(/await deleteStalePhotoCatalogRows\(/g) ?? []).length,
    3,
    "failed stale-row cleanup must be retried on first pages, ready legacy reuse, and rebuild",
  );
  assert.match(
    listPhotos,
    /!request\.query\.has\("cursor"\)[\s\S]*!catalogRevisionIsClean\(catalogScope, page\.revision\)/,
    "large stale snapshots must resume bounded cleanup on later first-page reads",
  );
  assert.match(
    listPhotos,
    /deleted < PHOTO_CATALOG_STALE_ROW_CLEANUP_LIMIT[\s\S]*markCatalogRevisionClean/,
    "a revision is clean only after a bounded cleanup returns fewer than the limit",
  );
  assert(
    listPhotos.indexOf("await beginPhotoCatalogRebuild(")
      < listPhotos.indexOf("listBlobsFlat("),
    "the catalog rebuild fence must cover the complete Blob scan",
  );
  assert(
    listPhotos.indexOf("listBlobsFlat(")
      < listPhotos.indexOf("await replacePhotoCatalogSnapshot("),
    "a scanned snapshot must publish through its original rebuild fence",
  );
  assert.match(listPhotos, /photo-catalog-mutating/);
  assert.match(listPhotos, /photo-catalog-rebuilding/);
  assert.match(listPhotos, /const catalogSortKeys = catalogRows/);
  assert.match(
    listPhotos,
    /return sortKeyA === sortKeyB \? 0 : sortKeyA > sortKeyB \? -1 : 1/,
    "legacy personal/group responses must use the catalog tie-breaker",
  );
  assert.doesNotMatch(catalog, /listBlobs(?:Flat|ByHierarchy)?\(/);
  assert.match(locations, /IS_NUMBER\(c\.lat\) AND IS_NUMBER\(c\.lon\)/);
});
