import assert from "node:assert/strict";
import test from "node:test";
import renameFolder from "../dist/src/functions/photos/renameFolder.js";

const { reconcileRenamedPhotoLocations } = renameFolder;

function fakeContainer(names) {
  return {
    async *listBlobsFlat() {
      for (const name of names) yield { name };
    },
    getBlockBlobClient(name) {
      return { name };
    },
  };
}

test("folder location reconciliation is bounded and reports failed pairs", async () => {
  let active = 0;
  let maxActive = 0;
  const warnings = [];
  const result = await reconcileRenamedPhotoLocations(
    fakeContainer([
      "personal/u/new/a.jpg",
      "personal/u/new/b.jpg",
      "personal/u/new/c.jpg",
      "personal/u/new/d.jpg",
      "personal/u/new/e.jpg",
      "personal/u/new/_th_a.jpg",
    ]),
    "personal/u/old/",
    "personal/u/new/",
    "personal/u",
    { warn: (...args) => warnings.push(args) },
    1_000,
    async (_client, name) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (name === "personal/u/old/c.jpg") throw new Error("Cosmos unavailable");
    },
  );

  assert.deepEqual(result, { pending: 1, inventoryIncomplete: false });
  assert.equal(warnings.length, 1);
  assert.ok(maxActive <= 4);
});

test("folder location reconciliation aborts stalled work at its deadline", async () => {
  const result = await reconcileRenamedPhotoLocations(
    fakeContainer(["personal/u/new/a.jpg"]),
    "personal/u/old/",
    "personal/u/new/",
    "personal/u",
    { warn() {} },
    10,
    async (_client, _name, _scope, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  );

  assert.deepEqual(result, { pending: 1, inventoryIncomplete: false });
});

test("folder location reconciliation reports incomplete inventories without inventing an exact count", async () => {
  const container = fakeContainer([]);
  container.listBlobsFlat = async function* () {
    yield { name: "personal/u/new/a.jpg" };
    yield { name: "personal/u/new/b.jpg" };
    yield { name: "personal/u/new/c.jpg" };
    throw new Error("Blob listing unavailable");
  };
  let syncCalls = 0;
  const result = await reconcileRenamedPhotoLocations(
    container,
    "personal/u/old/",
    "personal/u/new/",
    "personal/u",
    { warn() {} },
    1_000,
    async () => { syncCalls++; },
  );

  assert.deepEqual(result, { pending: 3, inventoryIncomplete: true });
  assert.equal(syncCalls, 0);
});
