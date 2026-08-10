export const MAX_CAPSULES = 100;
export const MAX_CAPSULE_PHOTOS = 200;
export const MAX_TITLE_LENGTH = 40;
export const MAX_PHOTO_NAME_LENGTH = 1024;
const MAX_CAPSULE_ID_LENGTH = 128;
const STORAGE_PREFIX = "cf_capsules_v2";
const LEGACY_STORAGE_PREFIX = "cf_capsules";

export interface Capsule {
  id: string;
  title: string;
  photoNames: string[];
  unlockDate: string;
  createdAt: string;
}

export interface CapsuleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CapsuleLoadResult {
  capsules: Capsule[];
  discardedInvalidData: boolean;
  needsMigration: boolean;
  error?: "read-failed";
}

function scopedPart(value: string): string {
  return encodeURIComponent(value);
}

export function capsuleStorageKey(userId: string, workspaceKey: string): string {
  return `${STORAGE_PREFIX}_${scopedPart(userId)}_${scopedPart(workspaceKey)}`;
}

export function legacyCapsuleStorageKey(userId: string): string {
  return `${LEGACY_STORAGE_PREFIX}_${userId}`;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1000) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function isPersistablePhotoName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_PHOTO_NAME_LENGTH
    && !value.includes("\0")
    && !/^https?:\/\//i.test(value)
    && !/(?:^|[?&])(?:sv|sig|se|sp|sr)=/i.test(value);
}

function normalizeCapsule(value: unknown): Capsule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string"
    || row.id.trim().length === 0
    || row.id.length > MAX_CAPSULE_ID_LENGTH
    || typeof row.title !== "string"
    || row.title.trim().length === 0
    || !Array.isArray(row.photoNames)
    || !isIsoDate(row.unlockDate)
    || !isIsoDate(row.createdAt)
  ) {
    return null;
  }

  const photoNames = [...new Set(row.photoNames.filter(isPersistablePhotoName))]
    .slice(0, MAX_CAPSULE_PHOTOS);
  if (photoNames.length === 0) return null;

  return {
    id: row.id.trim(),
    title: row.title.trim().slice(0, MAX_TITLE_LENGTH),
    photoNames,
    unlockDate: row.unlockDate,
    createdAt: row.createdAt,
  };
}

function normalizeCapsulesDetailed(value: unknown): {
  capsules: Capsule[];
  discardedInvalidData: boolean;
} {
  if (!Array.isArray(value)) {
    return {
      capsules: [],
      discardedInvalidData: value !== null && value !== undefined,
    };
  }

  const capsules: Capsule[] = [];
  const seenIds = new Set<string>();
  let discardedInvalidData = false;

  for (let index = value.length - 1; index >= 0 && capsules.length < MAX_CAPSULES; index -= 1) {
    const capsule = normalizeCapsule(value[index]);
    if (!capsule || seenIds.has(capsule.id)) {
      discardedInvalidData = true;
      continue;
    }
    seenIds.add(capsule.id);
    capsules.unshift(capsule);
  }
  if (value.length > capsules.length) discardedInvalidData = true;

  return { capsules, discardedInvalidData };
}

export function normalizeCapsules(value: unknown): Capsule[] {
  return normalizeCapsulesDetailed(value).capsules;
}

function parseCapsules(raw: string): {
  capsules: Capsule[];
  discardedInvalidData: boolean;
} {
  try {
    return normalizeCapsulesDetailed(JSON.parse(raw));
  } catch {
    return { capsules: [], discardedInvalidData: true };
  }
}

export function loadCapsulesFromStorage(
  storage: CapsuleStorage,
  userId: string,
  workspaceKey: string,
): CapsuleLoadResult {
  try {
    const scopedRaw = storage.getItem(capsuleStorageKey(userId, workspaceKey));
    if (scopedRaw !== null) {
      return {
        ...parseCapsules(scopedRaw),
        needsMigration: false,
      };
    }

    if (workspaceKey !== "personal") {
      return {
        capsules: [],
        discardedInvalidData: false,
        needsMigration: false,
      };
    }

    const legacyRaw = storage.getItem(legacyCapsuleStorageKey(userId));
    if (legacyRaw === null) {
      return {
        capsules: [],
        discardedInvalidData: false,
        needsMigration: false,
      };
    }
    return {
      ...parseCapsules(legacyRaw),
      needsMigration: true,
    };
  } catch {
    return {
      capsules: [],
      discardedInvalidData: false,
      needsMigration: false,
      error: "read-failed",
    };
  }
}

export function saveCapsulesToStorage(
  storage: CapsuleStorage,
  userId: string,
  workspaceKey: string,
  capsules: unknown,
): Capsule[] {
  const normalized = normalizeCapsules(capsules);
  storage.setItem(capsuleStorageKey(userId, workspaceKey), JSON.stringify(normalized));
  return normalized;
}

export function removeLegacyCapsules(storage: CapsuleStorage, userId: string): void {
  storage.removeItem(legacyCapsuleStorageKey(userId));
}
