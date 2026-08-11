import assert from "node:assert/strict";
import test from "node:test";
import renameSafety from "../dist/src/functions/photos/renameFolderSafety.js";

const {
  FOLDER_RENAME_CONCURRENCY,
  FOLDER_RENAME_REQUEST_LIMITS,
  FolderRenameError,
  planFolderRename,
  renameFolderBlobs: renameFolderBlobsWithDefaults,
} = renameSafety;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForAbort = (signal) => new Promise((_, reject) => {
  if (signal?.aborted) reject(signal.reason);
  else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
});
const renameFolderBlobs = (options) => renameFolderBlobsWithDefaults({
  copyPollIntervalMs: 0,
  ...options,
});

function createContainer(initialNames, options = {}) {
  const names = new Set(initialNames);
  const blobs = new Map(initialNames.map((name, index) => [
    name,
    { etag: `"source-${index + 1}"`, copyId: undefined },
  ]));
  const events = [];
  const copyCalls = [];
  const abortedCopies = [];
  const listPageSizes = [];
  const sourceDeletes = [];
  const sourceDeleteOptions = [];
  const destinationDeletes = [];
  const activity = {
    activeCopies: 0,
    maxActiveCopies: 0,
    activeSourceDeletes: 0,
    maxActiveSourceDeletes: 0,
    activeRollbacks: 0,
    maxActiveRollbacks: 0,
  };
  let copySequence = 0;

  return {
    names,
    events,
    copyCalls,
    abortedCopies,
    listPageSizes,
    sourceDeletes,
    sourceDeleteOptions,
    destinationDeletes,
    activity,
    listBlobsFlat({ prefix, abortSignal }) {
      events.push(`list:${prefix}`);
      const snapshot = [...names].filter((name) => name.startsWith(prefix));
      return {
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < snapshot.length; index += 1) {
            if (
              options.maxListItemsBeforeThrow
              && index >= options.maxListItemsBeforeThrow
            ) {
              throw new Error("read-past-limit");
            }
            const name = snapshot[index];
            yield { name, properties: { etag: blobs.get(name)?.etag } };
          }
        },
        byPage({ maxPageSize }) {
          listPageSizes.push({ prefix, maxPageSize });
          return {
            async *[Symbol.asyncIterator]() {
              if (abortSignal?.aborted) throw abortSignal.reason;
              const pageItems = snapshot.slice(0, maxPageSize).map((name) => ({
                name,
                properties: { etag: blobs.get(name)?.etag },
              }));
              yield { segment: { blobItems: pageItems } };
            },
          };
        },
      };
    },
    getBlockBlobClient(name) {
      return {
        async beginCopyFromURL(sourceUrl, copyOptions) {
          events.push(`copy:${name}`);
          copyCalls.push({ name, sourceUrl, options: copyOptions });
          activity.activeCopies += 1;
          activity.maxActiveCopies = Math.max(activity.maxActiveCopies, activity.activeCopies);
          let copyFinished = false;
          const finishCopy = () => {
            if (copyFinished) return;
            copyFinished = true;
            activity.activeCopies -= 1;
          };
          if (options.failCopyBeginAfterCreate === name) {
            names.add(name);
            blobs.set(name, { etag: '"uncertain"', copyId: "uncertain-copy" });
            const error = new Error("copy response lost and retry collided");
            error.statusCode = options.failCopyBeginAfterCreateStatusCode;
            finishCopy();
            throw error;
          }
          if (options.failCopyBegin === name) {
            const error = new Error("copy begin failed");
            error.statusCode = options.failCopyStatusCode ?? 412;
            finishCopy();
            throw error;
          }
          const sourceName = sourceUrl.slice("sas:".length);
          const source = blobs.get(sourceName);
          if (!source || source.etag !== copyOptions.sourceConditions?.ifMatch) {
            const error = new Error("source changed");
            error.statusCode = 412;
            finishCopy();
            throw error;
          }
          if (names.has(name) && copyOptions.conditions?.ifNoneMatch === "*") {
            const error = new Error("destination exists");
            error.statusCode = 412;
            finishCopy();
            throw error;
          }
          const copyId = `copy-${++copySequence}`;
          let cancelled = false;
          let done = false;
          let result;
          names.add(name);
          blobs.set(name, { etag: `"copying-${copySequence}"`, copyId, pending: true });
          return {
            getOperationState() {
              return { copyId };
            },
            async cancelOperation({ abortSignal } = {}) {
              if (abortSignal?.aborted) throw abortSignal.reason;
              if (done) return;
              cancelled = true;
              done = true;
              finishCopy();
            },
            isDone() {
              return done;
            },
            getResult() {
              return result;
            },
            async poll({ abortSignal } = {}) {
              try {
                const copyDelay = typeof options.copyDelayMs === "function"
                  ? options.copyDelayMs(name)
                  : options.copyDelayMs;
                if (copyDelay) {
                  await Promise.race([
                    delay(copyDelay),
                    new Promise((_, reject) => {
                      if (abortSignal?.aborted) reject(abortSignal.reason);
                      else abortSignal?.addEventListener(
                        "abort",
                        () => reject(abortSignal.reason),
                        { once: true },
                      );
                    }),
                  ]);
                }
                if (cancelled) throw new Error("copy cancelled");
                if (options.failCopyPoll === name) throw new Error("copy poll failed");
                if (options.changeSourceAfterCopy === sourceName) {
                  blobs.set(sourceName, { etag: `"changed-${copySequence}"`, copyId: undefined });
                }
                const copied = { etag: `"copied-${copySequence}"`, copyId };
                blobs.set(name, copied);
                if (options.addTargetAfterCopy === name) {
                  names.add(options.addTargetAfterCopyName);
                  blobs.set(options.addTargetAfterCopyName, { etag: '"external-target"', copyId: undefined });
                }
                result = { copyStatus: "success", ...copied };
                done = true;
              } catch (error) {
                done = true;
                throw error;
              } finally {
                finishCopy();
              }
            },
            async pollUntilDone() {
              await this.poll();
              return result;
            },
          };
        },
        async abortCopyFromURL(copyId, { abortSignal } = {}) {
          if (abortSignal?.aborted) throw abortSignal.reason;
          const blob = blobs.get(name);
          if (!blob || blob.copyId !== copyId || !blob.pending) {
            const error = new Error("copy is not pending");
            error.statusCode = 409;
            throw error;
          }
          abortedCopies.push({ name, copyId });
          blob.pending = false;
        },
        async getProperties({ abortSignal } = {}) {
          if (abortSignal?.aborted) throw abortSignal.reason;
          const blob = blobs.get(name);
          if (!blob) {
            const error = new Error("not found");
            error.statusCode = 404;
            throw error;
          }
          return { ...blob };
        },
        async deleteIfExists(deleteOptions = {}) {
          if (deleteOptions.abortSignal?.aborted) throw deleteOptions.abortSignal.reason;
          const isSource = initialNames.includes(name);
          events.push(`${isSource ? "delete-source" : "delete-destination"}:${name}`);
          const activeKey = isSource ? "activeSourceDeletes" : "activeRollbacks";
          const maxKey = isSource ? "maxActiveSourceDeletes" : "maxActiveRollbacks";
          activity[activeKey] += 1;
          activity[maxKey] = Math.max(activity[maxKey], activity[activeKey]);
          const operationDelay = isSource ? options.sourceDeleteDelayMs : options.rollbackDelayMs;
          if (isSource && options.sourceDeleteNeverSettles) {
            await waitForAbort(deleteOptions.abortSignal);
          }
          if (!isSource && options.rollbackNeverSettles) {
            await waitForAbort(deleteOptions.abortSignal);
          }
          if (operationDelay) await delay(operationDelay);
          try {
          if (isSource) {
            sourceDeletes.push(name);
            sourceDeleteOptions.push(deleteOptions);
            if (options.failSourceDelete === name) throw new Error("source delete failed");
          } else {
            destinationDeletes.push(name);
            if (options.failDestinationDelete === name) throw new Error("rollback delete failed");
            if (options.replaceDestinationBeforeRollback === name) {
              blobs.set(name, { etag: '"external"', copyId: "external-copy" });
            }
          }
          const blob = blobs.get(name);
          if (blob?.pending) {
            const error = new Error("PendingCopyOperation");
            error.statusCode = 409;
            throw error;
          }
          if (deleteOptions.conditions?.ifMatch && blob?.etag !== deleteOptions.conditions.ifMatch) {
            const error = new Error("condition failed");
            error.statusCode = 412;
            throw error;
          }
          const succeeded = names.delete(name);
          blobs.delete(name);
          return { succeeded };
          } finally {
            activity[activeKey] -= 1;
          }
        },
        getBlobLeaseClient() {
          return {
            async acquireLease(_duration, { abortSignal } = {}) {
              if (abortSignal?.aborted) throw abortSignal.reason;
              if (options.replaceDestinationBeforeSourceDelete === name) {
                blobs.set(name, { etag: '"external-before-delete"', copyId: "external-copy" });
              }
              if (!blobs.has(name)) {
                const error = new Error("not found");
                error.statusCode = 404;
                throw error;
              }
              return { leaseId: `lease:${name}` };
            },
            async releaseLease({ abortSignal } = {}) {
              if (abortSignal?.aborted) throw abortSignal.reason;
              return {};
            },
          };
        },
      };
    },
  };
}

function assertRenameError(fn, status) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof FolderRenameError);
    assert.equal(error.status, status);
    return true;
  });
}

test("path policy accepts only canonical relative same-parent renames", () => {
  assert.deepEqual(planFolderRename("Trips/Old", "Trips/New"), {
    oldFolder: "Trips/Old",
    newFolder: "Trips/New",
    unchanged: false,
  });
  assert.deepEqual(planFolderRename("Cafe\u0301", "Café"), {
    oldFolder: "Cafe\u0301",
    newFolder: "Café",
    unchanged: true,
  });

  for (const value of [
    "",
    "/root",
    "root/",
    "a//b",
    ".",
    "..",
    "a/./b",
    "a/../b",
    "a\\b",
    "_voice",
    "a/_voice",
    "a\u0000b",
    "a\u001fb",
    "a\u007fb",
  ]) {
    assertRenameError(() => planFolderRename(value, "safe"), 400);
    assertRenameError(() => planFolderRename("safe", value), 400);
  }
  assertRenameError(() => planFolderRename("Parent/Old", "Other/New"), 400);
  assertRenameError(() => planFolderRename("Old", "Old/Nested"), 400);
});

test("preflights both complete prefixes and rejects any target blob without mutation", async () => {
  const oldPrefix = "personal/user/Old/";
  const newPrefix = "personal/user/New/";
  const container = createContainer([
    `${oldPrefix}photo.jpg`,
    `${newPrefix}existing.jpg`,
    `${newPrefix}second.jpg`,
  ], { maxListItemsBeforeThrow: 1 });

  await assert.rejects(
    renameFolderBlobs({
      container,
      oldPrefix,
      newPrefix,
      generateSourceUrl: async (name) => `sas:${name}`,
      context: { error() {} },
    }),
    (error) => {
      assert.ok(error instanceof FolderRenameError);
      assert.equal(error.status, 409);
      assert.match(error.message, /目标文件夹已存在/);
      return true;
    },
  );
  assert.deepEqual(container.events, [`list:${oldPrefix}`, `list:${newPrefix}`]);
  assert.deepEqual(container.listPageSizes, [
    { prefix: oldPrefix, maxPageSize: FOLDER_RENAME_REQUEST_LIMITS.maxBlobs + 1 },
    { prefix: newPrefix, maxPageSize: 1 },
  ]);
  assert.equal(container.copyCalls.length, 0);
  assert.equal(container.sourceDeletes.length, 0);
});

test("uses an atomic destination no-overwrite condition and preserves relative derivative paths", async () => {
  const oldPrefix = "groups/g1/Old/";
  const newPrefix = "groups/g1/New/";
  const relativeNames = [
    "photo.jpg",
    "_th_photo.webp",
    "_preview/photo.webp",
    "_voice/photo.webm",
    "_motion/photo.mp4",
  ];
  const container = createContainer(relativeNames.map((name) => oldPrefix + name));

  const result = await renameFolderBlobs({
    container,
    oldPrefix,
    newPrefix,
    generateSourceUrl: async (name) => `sas:${name}`,
    context: { error() {} },
  });

  assert.deepEqual(result, { renamed: relativeNames.length });
  assert.deepEqual(
    container.copyCalls.map(({ name }) => name),
    relativeNames.map((name) => newPrefix + name),
  );
  for (const call of container.copyCalls) {
    assert.equal(call.options.conditions.ifNoneMatch, "*");
    assert.match(call.options.sourceConditions.ifMatch, /^"source-/);
  }
  const firstDelete = container.events.findIndex((event) => event.startsWith("delete-source:"));
  const lastCopy = container.events.reduce(
    (index, event, current) => event.startsWith("copy:") ? current : index,
    -1,
  );
  assert.ok(firstDelete > lastCopy, "all copies must finish before any source delete");
  assert.ok(container.sourceDeleteOptions.every((item) => /^"source-/.test(item.conditions.ifMatch)));
});

test("a middle copy failure rolls back only created destinations and never deletes a source", async () => {
  const oldPrefix = "personal/user/Old/";
  const newPrefix = "personal/user/New/";
  const sources = ["a.jpg", "b.jpg", "c.jpg"].map((name) => oldPrefix + name);
  const failedDestination = `${newPrefix}b.jpg`;
  const container = createContainer(sources, { failCopyPoll: failedDestination });

  await assert.rejects(
    renameFolderBlobs({
      container,
      oldPrefix,
      newPrefix,
      generateSourceUrl: async (name) => `sas:${name}`,
      context: { error() {} },
    }),
    (error) => {
      assert.ok(error instanceof FolderRenameError);
      assert.equal(error.status, 500);
      assert.equal(error.details.phase, "copy");
      assert.equal(error.details.recoveryNeeded, false);
      return true;
    },
  );
  assert.deepEqual(container.sourceDeletes, []);
  assert.deepEqual(
    container.destinationDeletes.sort(),
    [`${newPrefix}a.jpg`, failedDestination, `${newPrefix}c.jpg`].sort(),
  );
  assert.deepEqual(container.abortedCopies, [{
    name: failedDestination,
    copyId: "copy-2",
  }]);
  assert.ok(sources.every((name) => container.names.has(name)));
});

test("rollback failure is logged and explicitly reports recovery needed", async () => {
  const oldPrefix = "personal/user/Old/";
  const newPrefix = "personal/user/New/";
  const sources = ["a.jpg", "b.jpg"].map((name) => oldPrefix + name);
  const contextErrors = [];
  const container = createContainer(sources, {
    failCopyPoll: `${newPrefix}b.jpg`,
    failDestinationDelete: `${newPrefix}a.jpg`,
  });

  await assert.rejects(
    renameFolderBlobs({
      container,
      oldPrefix,
      newPrefix,
      generateSourceUrl: async (name) => `sas:${name}`,
      context: { error: (...args) => contextErrors.push(args) },
    }),
    (error) => {
      assert.equal(error.details.recoveryNeeded, true);
      assert.match(error.message, /需要人工恢复/);
      return true;
    },
  );
  assert.ok(contextErrors.length > 0);
  assert.deepEqual(container.sourceDeletes, []);
});

test("delete failure returns a non-success partial result while every media item retains a copy", async () => {
  const oldPrefix = "personal/user/Old/";
  const newPrefix = "personal/user/New/";
  const sources = ["a.jpg", "b.jpg", "c.jpg"].map((name) => oldPrefix + name);
  const failedSource = `${oldPrefix}b.jpg`;
  const container = createContainer(sources, { failSourceDelete: failedSource });

  await assert.rejects(
    renameFolderBlobs({
      container,
      oldPrefix,
      newPrefix,
      generateSourceUrl: async (name) => `sas:${name}`,
      context: { error() {} },
    }),
    (error) => {
      assert.ok(error instanceof FolderRenameError);
      assert.equal(error.status, 500);
      assert.equal(error.details.phase, "delete");
      assert.deepEqual(error.details.remainingSources, [failedSource]);
      return true;
    },
  );

  for (const source of sources) {
    const destination = newPrefix + source.slice(oldPrefix.length);
    assert.ok(container.names.has(source) || container.names.has(destination));
  }
  assert.ok(container.names.has(newPrefix + "b.jpg"), "never delete the destination for a failed source delete");
});

test("a source update after copy rolls back destinations and is never deleted", async () => {
  const oldPrefix = "personal/user/Old/";
  const newPrefix = "personal/user/New/";
  const source = `${oldPrefix}photo.jpg`;
  const container = createContainer([source], { changeSourceAfterCopy: source });

  await assert.rejects(
    renameFolderBlobs({
      container,
      oldPrefix,
      newPrefix,
      generateSourceUrl: async (name) => `sas:${name}`,
      context: { error() {} },
    }),
    (error) => {
      assert.equal(error.details.phase, "copy");
      assert.equal(error.details.recoveryNeeded, false);
      return true;
    },
  );

  assert.ok(container.names.has(source), "the concurrently updated source must remain");
  assert.equal(container.names.has(`${newPrefix}photo.jpg`), false);
  assert.deepEqual(container.sourceDeletes, []);
});

test("rollback never deletes a destination replaced by another writer", async () => {
  const oldPrefix = "personal/user/Old/";
  const newPrefix = "personal/user/New/";
  const sources = ["a.jpg", "b.jpg"].map((name) => oldPrefix + name);
  const firstDestination = `${newPrefix}a.jpg`;
  const container = createContainer(sources, {
    failCopyPoll: `${newPrefix}b.jpg`,
    replaceDestinationBeforeRollback: firstDestination,
  });

  await assert.rejects(
    renameFolderBlobs({
      container,
      oldPrefix,
      newPrefix,
      generateSourceUrl: async (name) => `sas:${name}`,
      context: { error() {} },
    }),
    (error) => {
      assert.equal(error.details.phase, "copy");
      assert.equal(error.details.recoveryNeeded, true);
      assert.ok(error.details.createdDestinations.includes(firstDestination));
      return true;
    },
  );

  assert.ok(container.names.has(firstDestination), "a replaced destination must not be rolled back");
  assert.deepEqual(container.sourceDeletes, []);
});

test("a destination replaced after copy is leased and verified before its source can be deleted", async () => {
  const oldPrefix = "personal/user/Old/";
  const newPrefix = "personal/user/New/";
  const source = `${oldPrefix}photo.jpg`;
  const destination = `${newPrefix}photo.jpg`;
  const container = createContainer([source], {
    replaceDestinationBeforeSourceDelete: destination,
  });

  await assert.rejects(
    renameFolderBlobs({
      container,
      oldPrefix,
      newPrefix,
      generateSourceUrl: async (name) => `sas:${name}`,
      context: { error() {} },
    }),
    (error) => {
      assert.equal(error.details.phase, "delete");
      assert.equal(error.details.recoveryNeeded, true);
      return true;
    },
  );

  assert.ok(container.names.has(source));
  assert.ok(container.names.has(destination));
  assert.deepEqual(container.sourceDeletes, []);
});

test("a new target blob during copy prevents source deletion and preserves the external target", async () => {
  const oldPrefix = "personal/user/Old/";
  const newPrefix = "personal/user/New/";
  const source = `${oldPrefix}photo.jpg`;
  const destination = `${newPrefix}photo.jpg`;
  const externalTarget = `${newPrefix}external.jpg`;
  const container = createContainer([source], {
    addTargetAfterCopy: destination,
    addTargetAfterCopyName: externalTarget,
  });

  await assert.rejects(
    renameFolderBlobs({
      container,
      oldPrefix,
      newPrefix,
      generateSourceUrl: async (name) => `sas:${name}`,
      context: { error() {} },
    }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.details.recoveryNeeded, false);
      return true;
    },
  );

  assert.ok(container.names.has(source));
  assert.equal(container.names.has(destination), false);
  assert.ok(container.names.has(externalTarget));
  assert.deepEqual(container.sourceDeletes, []);
});

test("a lost begin-copy response reports an unowned destination as recovery-needed", async () => {
  const oldPrefix = "personal/user/Old/";
  const newPrefix = "personal/user/New/";
  const source = `${oldPrefix}photo.jpg`;
  const destination = `${newPrefix}photo.jpg`;
  const container = createContainer([source], {
    failCopyBeginAfterCreate: destination,
    failCopyBeginAfterCreateStatusCode: 412,
  });

  await assert.rejects(
    renameFolderBlobs({
      container,
      oldPrefix,
      newPrefix,
      generateSourceUrl: async (name) => `sas:${name}`,
      context: { error() {} },
    }),
    (error) => {
      assert.equal(error.status, 500);
      assert.equal(error.details.recoveryNeeded, true);
      assert.ok(error.details.createdDestinations.includes(destination));
      return true;
    },
  );

  assert.ok(container.names.has(source));
  assert.ok(container.names.has(destination));
  assert.deepEqual(container.sourceDeletes, []);
});

test("copy and delete phases use their independent bounded concurrency limits", async () => {
  assert.deepEqual(FOLDER_RENAME_CONCURRENCY, {
    copy: 4,
    delete: 4,
    rollback: 2,
  });
  assert.deepEqual(FOLDER_RENAME_REQUEST_LIMITS, {
    maxBlobs: 100,
    copyPhaseTimeoutMs: 120_000,
    copyPollIntervalMs: 2_000,
    copyCancelTimeoutMs: 10_000,
    rollbackPhaseTimeoutMs: 60_000,
    deleteCriticalSectionTimeoutMs: 20_000,
    requestTimeoutMs: 210_000,
  });
  const oldPrefix = "personal/user/Old/";
  const newPrefix = "personal/user/New/";
  const sources = Array.from({ length: 12 }, (_, index) => `${oldPrefix}${index}.jpg`);
  const container = createContainer(sources, {
    copyDelayMs: 15,
    sourceDeleteDelayMs: 15,
  });

  await renameFolderBlobs({
    container,
    oldPrefix,
    newPrefix,
    generateSourceUrl: async (name) => `sas:${name}`,
    context: { error() {} },
  });

  assert.equal(container.activity.maxActiveCopies, FOLDER_RENAME_CONCURRENCY.copy);
  assert.equal(container.activity.maxActiveSourceDeletes, FOLDER_RENAME_CONCURRENCY.delete);
  assert.ok(container.activity.maxActiveCopies > 1);
  assert.ok(container.activity.maxActiveSourceDeletes > 1);
});

test("copy failure stops dispatching new work and rollback remains independently bounded", async () => {
  const oldPrefix = "personal/user/Old/";
  const newPrefix = "personal/user/New/";
  const sources = Array.from({ length: 12 }, (_, index) => `${oldPrefix}${index}.jpg`);
  const failedDestination = `${newPrefix}1.jpg`;
  const container = createContainer(sources, {
    copyDelayMs: (name) => name === failedDestination ? 5 : 25,
    failCopyPoll: failedDestination,
    rollbackDelayMs: 15,
  });

  await assert.rejects(
    renameFolderBlobs({
      container,
      oldPrefix,
      newPrefix,
      generateSourceUrl: async (name) => `sas:${name}`,
      context: { error() {} },
    }),
    FolderRenameError,
  );

  assert.equal(container.activity.maxActiveCopies, FOLDER_RENAME_CONCURRENCY.copy);
  assert.equal(container.copyCalls.length, FOLDER_RENAME_CONCURRENCY.copy);
  assert.equal(container.activity.maxActiveRollbacks, FOLDER_RENAME_CONCURRENCY.rollback);
  assert.ok(container.activity.maxActiveRollbacks > 1);
  assert.deepEqual(container.sourceDeletes, []);
});

test("oversized folders are rejected before mutation instead of overrunning one HTTP request", async () => {
  const oldPrefix = "personal/user/Old/";
  const newPrefix = "personal/user/New/";
  const sources = Array.from(
    { length: FOLDER_RENAME_REQUEST_LIMITS.maxBlobs + 50 },
    (_, index) => `${oldPrefix}${index}.jpg`,
  );
  const container = createContainer(sources, {
    maxListItemsBeforeThrow: FOLDER_RENAME_REQUEST_LIMITS.maxBlobs + 1,
  });

  await assert.rejects(
    renameFolderBlobs({
      container,
      oldPrefix,
      newPrefix,
      generateSourceUrl: async (name) => `sas:${name}`,
      context: { error() {} },
    }),
    (error) => {
      assert.equal(error.status, 413);
      assert.equal(error.details.recoveryNeeded, false);
      return true;
    },
  );
  assert.deepEqual(container.copyCalls, []);
  assert.deepEqual(container.sourceDeletes, []);
});

test("copy timeout cancels active pollers, rolls back boundedly, and preserves every source", async () => {
  const oldPrefix = "personal/user/Old/";
  const newPrefix = "personal/user/New/";
  const sources = Array.from({ length: 8 }, (_, index) => `${oldPrefix}${index}.jpg`);
  const container = createContainer(sources, {
    copyDelayMs: 30,
    rollbackDelayMs: 10,
  });

  await assert.rejects(
    renameFolderBlobs({
      container,
      oldPrefix,
      newPrefix,
      generateSourceUrl: async (name) => `sas:${name}`,
      context: { error() {} },
      copyPhaseTimeoutMs: 5,
    }),
    (error) => {
      assert.equal(error.details.phase, "copy");
      return true;
    },
  );

  assert.equal(container.copyCalls.length, FOLDER_RENAME_CONCURRENCY.copy);
  assert.equal(container.abortedCopies.length, FOLDER_RENAME_CONCURRENCY.copy);
  assert.ok(container.activity.maxActiveRollbacks <= FOLDER_RENAME_CONCURRENCY.rollback);
  assert.ok(sources.every((name) => container.names.has(name)));
  assert.deepEqual(container.sourceDeletes, []);
});

test("the server request deadline also bounds rollback storage calls", async () => {
  const oldPrefix = "personal/user/Old/";
  const newPrefix = "personal/user/New/";
  const sources = ["a.jpg", "b.jpg", "c.jpg"].map((name) => oldPrefix + name);
  const container = createContainer(sources, {
    failCopyPoll: `${newPrefix}b.jpg`,
    rollbackNeverSettles: true,
  });
  const startedAt = Date.now();

  await assert.rejects(
    renameFolderBlobs({
      container,
      oldPrefix,
      newPrefix,
      generateSourceUrl: async (name) => `sas:${name}`,
      context: { error() {} },
      requestTimeoutMs: 20,
    }),
    (error) => {
      assert.equal(error.details.phase, "copy");
      assert.equal(error.details.recoveryNeeded, true);
      return true;
    },
  );

  assert.ok(Date.now() - startedAt < 500);
  assert.deepEqual(container.sourceDeletes, []);
  assert.ok(sources.every((name) => container.names.has(name)));
});

test("source deletion cannot outlive the destination lease safety margin", async () => {
  const oldPrefix = "personal/user/Old/";
  const newPrefix = "personal/user/New/";
  const source = `${oldPrefix}photo.jpg`;
  const destination = `${newPrefix}photo.jpg`;
  const container = createContainer([source], { sourceDeleteNeverSettles: true });
  const startedAt = Date.now();

  await assert.rejects(
    renameFolderBlobs({
      container,
      oldPrefix,
      newPrefix,
      generateSourceUrl: async (name) => `sas:${name}`,
      context: { error() {} },
      deleteCriticalSectionTimeoutMs: 20,
    }),
    (error) => {
      assert.equal(error.details.phase, "delete");
      assert.equal(error.details.recoveryNeeded, true);
      return true;
    },
  );

  assert.ok(Date.now() - startedAt < 500);
  assert.ok(container.names.has(source));
  assert.ok(container.names.has(destination));
});

test("service throttling is left to Azure SDK retry and never creates an outer retry storm", async () => {
  const oldPrefix = "personal/user/Old/";
  const newPrefix = "personal/user/New/";
  const sources = Array.from({ length: 8 }, (_, index) => `${oldPrefix}${index}.jpg`);
  const failedDestination = `${newPrefix}0.jpg`;
  const container = createContainer(sources, {
    failCopyBegin: failedDestination,
    failCopyStatusCode: 503,
  });

  await assert.rejects(
    renameFolderBlobs({
      container,
      oldPrefix,
      newPrefix,
      generateSourceUrl: async (name) => `sas:${name}`,
      context: { error() {} },
    }),
    FolderRenameError,
  );

  assert.equal(
    container.copyCalls.filter((call) => call.name === failedDestination).length,
    1,
  );
  assert.ok(container.copyCalls.length <= FOLDER_RENAME_CONCURRENCY.copy);
  assert.deepEqual(container.sourceDeletes, []);
});
