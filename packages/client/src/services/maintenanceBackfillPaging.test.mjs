import assert from "node:assert/strict";
import test from "node:test";
import { runMaintenanceBackfillPages } from "./maintenanceBackfillPaging.ts";

test("reports cumulative metadata progress after every verified page", async () => {
  const pages = [
    { processed: 30, changed: 20, skipped: 0, failed: 1, hasMore: true, cursor: "next" },
    { processed: 7, changed: 4, skipped: 0, failed: 0, hasMore: false },
  ];
  const progress = [];
  const totals = await runMaintenanceBackfillPages({
    requestPage: async () => pages.shift(),
    onProgress: (value) => progress.push(value),
    paginationError: "metadata pagination failed",
  });

  assert.deepEqual(progress, [
    { processed: 30, changed: 20, skipped: 0, failed: 1, hasMore: true },
    { processed: 37, changed: 24, skipped: 0, failed: 1, hasMore: false },
  ]);
  assert.deepEqual(totals, { processed: 37, changed: 24, skipped: 0, failed: 1 });
});

test("reports cumulative thumbnail progress after every verified page", async () => {
  const pages = [
    { processed: 30, changed: 10, skipped: 19, failed: 1, hasMore: true, cursor: "page-2" },
    { processed: 12, changed: 5, skipped: 7, failed: 0, hasMore: false },
  ];
  const progress = [];
  await runMaintenanceBackfillPages({
    requestPage: async () => pages.shift(),
    onProgress: (value) => progress.push(value),
    paginationError: "thumbnail pagination failed",
  });

  assert.deepEqual(progress.at(-1), {
    processed: 42,
    changed: 15,
    skipped: 26,
    failed: 1,
    hasMore: false,
  });
});

test("caller abort prevents the next page request and preserves prior progress", async () => {
  const controller = new AbortController();
  let calls = 0;
  const progress = [];

  await assert.rejects(
    runMaintenanceBackfillPages({
      signal: controller.signal,
      requestPage: async () => {
        calls += 1;
        return { processed: 30, changed: 12, skipped: 17, failed: 1, hasMore: true, cursor: "next" };
      },
      onProgress: (value) => {
        progress.push(value);
        controller.abort(new Error("stop"));
      },
      paginationError: "pagination failed",
    }),
    /stop/,
  );

  assert.equal(calls, 1);
  assert.deepEqual(progress.at(-1), {
    processed: 30,
    changed: 12,
    skipped: 17,
    failed: 1,
    hasMore: true,
  });
});

test("missing and repeated cursors remain explicit failures", async () => {
  await assert.rejects(
    runMaintenanceBackfillPages({
      requestPage: async () => ({ processed: 1, changed: 1, skipped: 0, failed: 0, hasMore: true }),
      paginationError: "cannot continue",
    }),
    /cannot continue/,
  );

  let calls = 0;
  await assert.rejects(
    runMaintenanceBackfillPages({
      requestPage: async () => {
        calls += 1;
        return { processed: 1, changed: 1, skipped: 0, failed: 0, hasMore: true, cursor: "same" };
      },
      paginationError: "cannot continue",
    }),
    /cannot continue/,
  );
  assert.equal(calls, 2);
});
