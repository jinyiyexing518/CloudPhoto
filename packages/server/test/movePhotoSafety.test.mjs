import assert from "node:assert/strict";
import test from "node:test";
import movePhotoSafety from "../dist/src/functions/photos/movePhotoSafety.js";

const {
  copyBlobForMove,
  removeCompletedMoveDestination,
  withVerifiedCompletedMoveDestination,
} = movePhotoSafety;

function createCopyFixture(options = {}) {
  let done = options.done ?? false;
  let status = options.status ?? "pending";
  let etag = '"destination-1"';
  let metadata = {};
  let exists = true;
  let result = options.result;
  const calls = {
    acquireLease: 0,
    abort: 0,
    begin: 0,
    delete: 0,
    poll: 0,
    pollSignal: false,
    releaseLease: 0,
  };
  const destinationBlob = {
    async beginCopyFromURL(_sourceUrl, copyOptions) {
      calls.begin += 1;
      assert.equal(copyOptions.conditions.ifNoneMatch, "*");
      assert(copyOptions.abortSignal);
      assert.equal(typeof copyOptions.metadata.cloudphotomoveid, "string");
      if (options.expectedSourceMetadata) {
        assert.deepEqual(
          copyOptions.metadata,
          {
            ...options.expectedSourceMetadata,
            cloudphotomoveid: copyOptions.metadata.cloudphotomoveid,
          },
        );
      }
      metadata = copyOptions.metadata;
      if (options.beginError) {
        done = options.beginDone ?? false;
        status = options.beginStatus ?? "pending";
        throw new Error(options.beginError);
      }
      return {
        isDone: () => done,
        getOperationState: () => ({ copyId: "copy-1" }),
        getResult: () => result,
        async poll({ abortSignal } = {}) {
          calls.poll += 1;
          calls.pollSignal = Boolean(abortSignal);
          if (options.stallPoll) {
            await new Promise((_, reject) => {
              if (abortSignal?.aborted) reject(abortSignal.reason);
              else abortSignal?.addEventListener(
                "abort",
                () => reject(abortSignal.reason),
                { once: true },
              );
            });
            return;
          }
          done = true;
          status = options.pollStatus ?? "success";
          etag = '"destination-2"';
          result = {
            copyId: "copy-1",
            copyStatus: status,
            etag,
          };
          if (options.pollError) throw new Error(options.pollError);
        },
      };
    },
    async getProperties({ abortSignal } = {}) {
      if (abortSignal?.aborted) throw abortSignal.reason;
      if (!exists) throw Object.assign(new Error("missing"), { statusCode: 404 });
      return {
        copyId: "copy-1",
        copyStatus: status,
        etag,
        metadata,
      };
    },
    async abortCopyFromURL(copyId, { abortSignal } = {}) {
      calls.abort += 1;
      assert.equal(copyId, "copy-1");
      if (abortSignal?.aborted) throw abortSignal.reason;
      if (options.abortError) {
        status = options.abortRaceStatus ?? "pending";
        etag = '"destination-abort-race"';
        throw Object.assign(new Error(options.abortError), {
          statusCode: options.abortStatusCode ?? 409,
        });
      }
      status = "aborted";
      etag = '"destination-aborted"';
    },
    async deleteIfExists({ abortSignal, conditions } = {}) {
      calls.delete += 1;
      if (abortSignal?.aborted) throw abortSignal.reason;
      assert.equal(conditions.ifMatch, etag);
      exists = false;
      return { succeeded: true };
    },
    getBlobLeaseClient() {
      return {
        async acquireLease(duration, { abortSignal } = {}) {
          calls.acquireLease += 1;
          assert.equal(duration, 15);
          if (abortSignal?.aborted) throw abortSignal.reason;
        },
        async releaseLease({ abortSignal } = {}) {
          calls.releaseLease += 1;
          if (abortSignal?.aborted) throw abortSignal.reason;
        },
      };
    },
  };
  return { calls, destinationBlob };
}

test("aborts a stalled poll at the deadline and removes its owned residue", async () => {
  const fixture = createCopyFixture({ stallPoll: true });
  let renewals = 0;

  await assert.rejects(
    () => copyBlobForMove({
      destinationBlob: fixture.destinationBlob,
      sourceUrl: "https://example.test/source",
      sourceEtag: '"source-1"',
      renewCatalogMutation: async () => {
        renewals += 1;
      },
      timeoutMs: 20,
      pollIntervalMs: 0,
      cleanupTimeoutMs: 100,
    }),
    /Photo move copy timed out/,
  );

  assert.equal(fixture.calls.poll, 1);
  assert.equal(fixture.calls.pollSignal, true);
  assert.equal(fixture.calls.abort, 1);
  assert.equal(fixture.calls.delete, 1);
  assert.equal(renewals, 4);
});

test("reconciles a copy that completes while its abort response fails", async () => {
  const fixture = createCopyFixture({
    stallPoll: true,
    abortError: "copy already completed",
    abortRaceStatus: "success",
  });

  await assert.rejects(
    () => copyBlobForMove({
      destinationBlob: fixture.destinationBlob,
      sourceUrl: "https://example.test/source",
      renewCatalogMutation: async () => {},
      timeoutMs: 20,
      pollIntervalMs: 0,
      cleanupTimeoutMs: 100,
    }),
    /Photo move copy timed out/,
  );

  assert.equal(fixture.calls.abort, 1);
  assert.equal(fixture.calls.delete, 1);
});

test("removes a terminal failed copy so the destination can be retried", async () => {
  const fixture = createCopyFixture({
    pollStatus: "failed",
    pollError: "copy service failed",
  });

  await assert.rejects(
    () => copyBlobForMove({
      destinationBlob: fixture.destinationBlob,
      sourceUrl: "https://example.test/source",
      renewCatalogMutation: async () => {},
      timeoutMs: 100,
      pollIntervalMs: 0,
      cleanupTimeoutMs: 100,
    }),
    /copy service failed/,
  );

  assert.equal(fixture.calls.abort, 0);
  assert.equal(fixture.calls.delete, 1);
});

test("does not mutate a pending copy after the catalog lease is lost", async () => {
  const fixture = createCopyFixture();
  let renewals = 0;

  await assert.rejects(
    () => copyBlobForMove({
      destinationBlob: fixture.destinationBlob,
      sourceUrl: "https://example.test/source",
      renewCatalogMutation: async () => {
        renewals += 1;
        if (renewals > 1) throw new Error("catalog lease lost");
      },
      timeoutMs: 100,
      pollIntervalMs: 0,
      cleanupTimeoutMs: 100,
    }),
    /catalog lease lost/,
  );

  assert.equal(fixture.calls.abort, 0);
  assert.equal(fixture.calls.delete, 0);
});

test("returns only an owned successful copy result", async () => {
  const sourceMetadata = { favorite: "1", originalname: "photo.jpg" };
  const fixture = createCopyFixture({ expectedSourceMetadata: sourceMetadata });
  const result = await copyBlobForMove({
    destinationBlob: fixture.destinationBlob,
    sourceUrl: "https://example.test/source",
    sourceMetadata,
    renewCatalogMutation: async () => {},
    timeoutMs: 100,
    pollIntervalMs: 0,
  });

  assert.deepEqual(result, {
    copyId: "copy-1",
    copyStatus: "success",
    etag: '"destination-2"',
  });
  assert.equal(fixture.calls.delete, 0);
});

test("reconciles a lost begin-copy response by its durable operation marker", async () => {
  const fixture = createCopyFixture({
    beginError: "copy response lost",
    beginDone: true,
    beginStatus: "success",
  });

  await assert.rejects(
    () => copyBlobForMove({
      destinationBlob: fixture.destinationBlob,
      sourceUrl: "https://example.test/source",
      renewCatalogMutation: async () => {},
      timeoutMs: 100,
      pollIntervalMs: 0,
      cleanupTimeoutMs: 100,
    }),
    /copy response lost/,
  );

  assert.equal(fixture.calls.abort, 0);
  assert.equal(fixture.calls.delete, 1);
});

test("holds a verified destination lease through an absent-source outcome", async () => {
  const fixture = createCopyFixture();
  const completedCopy = await copyBlobForMove({
    destinationBlob: fixture.destinationBlob,
    sourceUrl: "https://example.test/source",
    renewCatalogMutation: async () => {},
    timeoutMs: 100,
    pollIntervalMs: 0,
  });
  let operationCalls = 0;

  const result = await withVerifiedCompletedMoveDestination({
    destinationBlob: fixture.destinationBlob,
    completedCopy,
    renewCatalogMutation: async () => {},
    operation: async () => {
      operationCalls += 1;
      return { succeeded: false };
    },
    onLeaseReleaseError: assert.fail,
    criticalSectionTimeoutMs: 100,
    leaseReleaseTimeoutMs: 100,
  });

  assert.deepEqual(result, { succeeded: false });
  assert.equal(operationCalls, 1);
  assert.equal(fixture.calls.acquireLease, 1);
  assert.equal(fixture.calls.releaseLease, 1);
  assert.equal(fixture.calls.delete, 0);
});

test("does not delete the source after the completed destination changes", async () => {
  const fixture = createCopyFixture();
  const completedCopy = await copyBlobForMove({
    destinationBlob: fixture.destinationBlob,
    sourceUrl: "https://example.test/source",
    renewCatalogMutation: async () => {},
    timeoutMs: 100,
    pollIntervalMs: 0,
  });
  fixture.destinationBlob.getProperties = async () => ({
    copyId: "copy-1",
    copyStatus: "success",
    etag: '"destination-replaced"',
  });
  let operationCalls = 0;

  await assert.rejects(
    () => withVerifiedCompletedMoveDestination({
      destinationBlob: fixture.destinationBlob,
      completedCopy,
      renewCatalogMutation: async () => {},
      operation: async () => {
        operationCalls += 1;
      },
      onLeaseReleaseError: assert.fail,
      criticalSectionTimeoutMs: 100,
      leaseReleaseTimeoutMs: 100,
    }),
    /destination changed before source deletion/,
  );

  assert.equal(operationCalls, 0);
  assert.equal(fixture.calls.acquireLease, 1);
  assert.equal(fixture.calls.releaseLease, 1);
});

test("removes an unchanged completed destination after a source conflict", async () => {
  const fixture = createCopyFixture();
  const completedCopy = await copyBlobForMove({
    destinationBlob: fixture.destinationBlob,
    sourceUrl: "https://example.test/source",
    renewCatalogMutation: async () => {},
    timeoutMs: 100,
    pollIntervalMs: 0,
  });
  let renewals = 0;

  await removeCompletedMoveDestination({
    destinationBlob: fixture.destinationBlob,
    completedCopy,
    renewCatalogMutation: async () => {
      renewals += 1;
    },
    cleanupTimeoutMs: 100,
  });

  assert.equal(fixture.calls.delete, 1);
  assert.equal(renewals, 1);
});

test("does not remove a completed destination changed by another writer", async () => {
  const fixture = createCopyFixture();
  const completedCopy = await copyBlobForMove({
    destinationBlob: fixture.destinationBlob,
    sourceUrl: "https://example.test/source",
    renewCatalogMutation: async () => {},
    timeoutMs: 100,
    pollIntervalMs: 0,
  });
  fixture.destinationBlob.getProperties = async () => ({
    copyId: "copy-1",
    copyStatus: "success",
    etag: '"destination-replaced"',
  });

  await assert.rejects(
    () => removeCompletedMoveDestination({
      destinationBlob: fixture.destinationBlob,
      completedCopy,
      renewCatalogMutation: async () => {},
      cleanupTimeoutMs: 100,
    }),
    /destination changed before conflict cleanup/,
  );

  assert.equal(fixture.calls.delete, 0);
});
