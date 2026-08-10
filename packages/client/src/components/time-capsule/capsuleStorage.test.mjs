import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CAPSULES,
  MAX_CAPSULE_PHOTOS,
  MAX_PHOTO_NAME_LENGTH,
  MAX_TITLE_LENGTH,
  capsuleStorageKey,
  loadCapsulesFromStorage,
  normalizeCapsules,
  saveCapsulesToStorage,
} from "./capsuleStorage.ts";

const validCapsule = {
  id: "capsule-1",
  title: "夏日",
  unlockDate: "2026-08-12",
  createdAt: "2026-08-11",
  photoNames: ["photos/a.jpg"],
};

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
    values,
  };
}

test("normalization rejects non-arrays and invalid rows without throwing", () => {
  assert.deepEqual(normalizeCapsules(null), []);
  assert.deepEqual(normalizeCapsules({}), []);
  assert.deepEqual(normalizeCapsules([null, {}, { ...validCapsule, unlockDate: "2026-02-30" }]), []);
  assert.deepEqual(normalizeCapsules([{ ...validCapsule, photoNames: "photos/a.jpg" }]), []);
});

test("normalization bounds titles, photo names, and capsule count", () => {
  const longNames = Array.from(
    { length: MAX_CAPSULE_PHOTOS + 5 },
    (_, index) => `photos/${index}.jpg`,
  );
  const capsules = Array.from(
    { length: MAX_CAPSULES + 3 },
    (_, index) => ({
      ...validCapsule,
      id: `capsule-${index}`,
      title: "夏".repeat(MAX_TITLE_LENGTH + 8),
      photoNames: [
        longNames[0],
        longNames[0],
        "https://account.blob.core.windows.net/photos/a.jpg?sv=1&sig=secret",
        "photos/a.jpg?sv=1&sig=secret",
        "x".repeat(MAX_PHOTO_NAME_LENGTH + 1),
        ...longNames.slice(1),
      ],
    }),
  );

  const normalized = normalizeCapsules(capsules);
  assert.equal(normalized.length, MAX_CAPSULES);
  assert.equal(normalized.at(-1).id, `capsule-${MAX_CAPSULES + 2}`);
  assert.equal(normalized[0].title.length, MAX_TITLE_LENGTH);
  assert.equal(normalized[0].photoNames.length, MAX_CAPSULE_PHOTOS);
  assert.equal(new Set(normalized[0].photoNames).size, normalized[0].photoNames.length);
  assert.ok(normalized[0].photoNames.every((name) => !name.includes("sig=")));
});

test("workspace keys isolate group capsules and only personal reads legacy data", () => {
  const legacyKey = "cf_capsules_user-1";
  const storage = memoryStorage({
    [legacyKey]: JSON.stringify([validCapsule]),
  });

  const personal = loadCapsulesFromStorage(storage, "user-1", "personal");
  assert.deepEqual(personal.capsules, [validCapsule]);
  assert.equal(personal.needsMigration, true);

  const group = loadCapsulesFromStorage(storage, "user-1", "group-1");
  assert.deepEqual(group.capsules, []);
  assert.equal(group.needsMigration, false);
  assert.notEqual(
    capsuleStorageKey("user-1", "personal"),
    capsuleStorageKey("user-1", "group-1"),
  );
});

test("scoped malformed and legal non-array payloads resolve safely", () => {
  const key = capsuleStorageKey("user-1", "personal");
  assert.deepEqual(
    loadCapsulesFromStorage(memoryStorage({ [key]: "{" }), "user-1", "personal").capsules,
    [],
  );
  assert.deepEqual(
    loadCapsulesFromStorage(memoryStorage({ [key]: "{}" }), "user-1", "personal").capsules,
    [],
  );
});

test("storage read and write failures are surfaced", () => {
  const readResult = loadCapsulesFromStorage(
    {
      getItem() {
        throw new Error("denied");
      },
      setItem() {},
      removeItem() {},
    },
    "user-1",
    "personal",
  );
  assert.equal(readResult.error, "read-failed");

  assert.throws(
    () => saveCapsulesToStorage(
      {
        getItem() {
          return null;
        },
        setItem() {
          throw new Error("quota");
        },
        removeItem() {},
      },
      "user-1",
      "personal",
      [validCapsule],
    ),
    /quota/,
  );
});
