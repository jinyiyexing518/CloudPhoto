import assert from "node:assert/strict";
import test from "node:test";
import renameSafety from "../dist/src/functions/photos/renameFolderSafety.js";

const {
  FolderRenameError,
  planFolderRename,
  renameFolderBlobs,
} = renameSafety;

function createContainer(initialNames, options = {}) {
  const names = new Set(initialNames);
  const blobs = new Map(initialNames.map((name, index) => [
    name,
    { etag: `"source-${index + 1}"`, copyId: undefined },
  ]));
  const events = [];
  const copyCalls = [];
  const sourceDeletes = [];
  const sourceDeleteOptions = [];
  const destinationDeletes = [];
  let copySequence = 0;

  return {
    names,
    events,
    copyCalls,
    sourceDeletes,
    sourceDeleteOptions,
    destinationDeletes,
    listBlobsFlat({ prefix }) {
      events.push(`list:${prefix}`);
      const snapshot = [...names].filter((name) => name.startsWith(prefix));
      return {
        async *[Symbol.asyncIterator]() {
          for (const name of snapshot) {
            yield { name, properties: { etag: blobs.get(name)?.etag } };
          }
        },
      };
    },
    getBlockBlobClient(name) {
      return {
        async beginCopyFromURL(sourceUrl, copyOptions) {
          events.push(`copy:${name}`);
          copyCalls.push({ name, sourceUrl, options: copyOptions });
          if (options.failCopyBeginAfterCreate === name) {
            names.add(name);
            blobs.set(name, { etag: '"uncertain"', copyId: "uncertain-copy" });
            const error = new Error("copy response lost and retry collided");
            error.statusCode = options.failCopyBeginAfterCreateStatusCode;
            throw error;
          }
          if (options.failCopyBegin === name) {
            const error = new Error("copy begin failed");
            error.statusCode = 412;
            throw error;
          }
          const sourceName = sourceUrl.slice("sas:".length);
          const source = blobs.get(sourceName);
          if (!source || source.etag !== copyOptions.sourceConditions?.ifMatch) {
            const error = new Error("source changed");
            error.statusCode = 412;
            throw error;
          }
          if (names.has(name) && copyOptions.conditions?.ifNoneMatch === "*") {
            const error = new Error("destination exists");
            error.statusCode = 412;
            throw error;
          }
          const copyId = `copy-${++copySequence}`;
          names.add(name);
          blobs.set(name, { etag: `"copying-${copySequence}"`, copyId });
          return {
            getOperationState() {
              return { copyId };
            },
            async pollUntilDone() {
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
              return { copyStatus: "success", ...copied };
            },
          };
        },
        async getProperties() {
          const blob = blobs.get(name);
          if (!blob) {
            const error = new Error("not found");
            error.statusCode = 404;
            throw error;
          }
          return { ...blob };
        },
        async deleteIfExists(deleteOptions = {}) {
          const isSource = initialNames.includes(name);
          events.push(`${isSource ? "delete-source" : "delete-destination"}:${name}`);
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
          if (deleteOptions.conditions?.ifMatch && blob?.etag !== deleteOptions.conditions.ifMatch) {
            const error = new Error("condition failed");
            error.statusCode = 412;
            throw error;
          }
          const succeeded = names.delete(name);
          blobs.delete(name);
          return { succeeded };
        },
        getBlobLeaseClient() {
          return {
            async acquireLease() {
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
            async releaseLease() {
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
  ]);

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
    [`${newPrefix}a.jpg`, failedDestination].sort(),
  );
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
      assert.deepEqual(error.details.remainingSources, [failedSource, `${oldPrefix}c.jpg`]);
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
