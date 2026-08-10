import assert from "node:assert/strict";
import test from "node:test";
import maintenance from "../dist/src/functions/photos/locationMaintenance.js";

const { reconcileLocationIndex } = maintenance;

test("reconciles existing valid Blob GPS even when metadata does not change", async () => {
  let syncs = 0;
  const result = await reconcileLocationIndex({
    metadataChanged: false,
    sync: async () => { syncs += 1; },
  });
  assert.deepEqual(result, { metadataChanged: false, indexReconciled: true });
  assert.equal(syncs, 1);
});

test("reports a failed index repair separately without claiming metadata changed", async () => {
  const result = await reconcileLocationIndex({
    metadataChanged: false,
    sync: async () => { throw new Error("Cosmos unavailable"); },
  });
  assert.deepEqual(result, { metadataChanged: false, indexReconciled: false });
});
