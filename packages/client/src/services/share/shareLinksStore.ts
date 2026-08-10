import {
  capturePrivateLocalDataContext,
  getPrivateLocalDataStorageContextStatus,
  isPrivateLocalDataContextCurrent,
  privateLocalDataStorageKey,
  type PrivateLocalDataContext,
} from "../privateLocalDataLifecycle.ts";

export interface RecentShareLink {
  id: string;
  photoName: string;
  displayName: string;
  url: string;
  expiresAt: string;
  createdAt: string;
}

export const RECENT_SHARE_LINKS_MAX_BYTES = 64 * 1024;
const MAX_ITEMS = 60;
const MAX_ID_LENGTH = 128;
const MAX_PHOTO_NAME_LENGTH = 1024;
const MAX_DISPLAY_NAME_LENGTH = 512;
const MAX_URL_LENGTH = 4096;

export type RecentShareLinksContext = PrivateLocalDataContext;

export type RecentShareLinksPersistenceResult =
  | { persisted: true }
  | {
      persisted: false;
      reason: "stale-context" | "storage-unavailable" | "invalid-entry" | "payload-too-large";
    };

type RecentShareLinksReadResult =
  | { items: RecentShareLink[]; readable: true }
  | {
      items: [];
      readable: false;
      reason: "stale-context" | "storage-unavailable";
    };

const PERSISTED: RecentShareLinksPersistenceResult = { persisted: true };

export function captureRecentShareLinksContext(): RecentShareLinksContext | null {
  return capturePrivateLocalDataContext();
}

export function isRecentShareLinksContextCurrent(
  context: RecentShareLinksContext | null,
): context is RecentShareLinksContext {
  return isPrivateLocalDataContextCurrent(context);
}

export function privateShareLinksStorageKey(context: RecentShareLinksContext): string {
  return privateLocalDataStorageKey(context, "recent-share-links");
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function sanitizeShareLink(value: unknown): RecentShareLink | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<RecentShareLink>;
  if (
    typeof item.id !== "string"
    || item.id.length < 1
    || item.id.length > MAX_ID_LENGTH
    || typeof item.photoName !== "string"
    || item.photoName.length < 1
    || item.photoName.length > MAX_PHOTO_NAME_LENGTH
    || typeof item.displayName !== "string"
    || item.displayName.length < 1
    || item.displayName.length > MAX_DISPLAY_NAME_LENGTH
    || typeof item.url !== "string"
    || item.url.length < 1
    || item.url.length > MAX_URL_LENGTH
    || !validTimestamp(item.expiresAt)
    || !validTimestamp(item.createdAt)
  ) {
    return null;
  }
  try {
    const url = new URL(item.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return {
    id: item.id,
    photoName: item.photoName,
    displayName: item.displayName,
    url: item.url,
    expiresAt: item.expiresAt,
    createdAt: item.createdAt,
  };
}

function removeInvalidStorage(key: string): RecentShareLinksPersistenceResult {
  try {
    localStorage.removeItem(key);
    return PERSISTED;
  } catch {
    return { persisted: false, reason: "storage-unavailable" };
  }
}

function read(context: RecentShareLinksContext): RecentShareLinksReadResult {
  const key = privateShareLinksStorageKey(context);
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return { items: [], readable: false, reason: "storage-unavailable" };
  }
  if (!raw) {
    const status = getPrivateLocalDataStorageContextStatus(context);
    return status === "current"
      ? { items: [], readable: true }
      : { items: [], readable: false, reason: status };
  }
  try {
    if (raw.length > RECENT_SHARE_LINKS_MAX_BYTES) throw new Error("Recent share payload too large");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_ITEMS) {
      throw new Error("Invalid recent share payload");
    }
    const items = parsed.map(sanitizeShareLink);
    if (items.some((item) => !item)) throw new Error("Invalid recent share entry");
    const status = getPrivateLocalDataStorageContextStatus(context);
    return status === "current"
      ? { items: items as RecentShareLink[], readable: true }
      : { items: [], readable: false, reason: status };
  } catch {
    const cleanup = removeInvalidStorage(key);
    return cleanup.persisted
      ? { items: [], readable: true }
      : { items: [], readable: false, reason: "storage-unavailable" };
  }
}

function write(
  context: RecentShareLinksContext,
  items: RecentShareLink[],
): RecentShareLinksPersistenceResult {
  const initialStatus = getPrivateLocalDataStorageContextStatus(context);
  if (initialStatus !== "current") {
    return { persisted: false, reason: initialStatus };
  }
  const sanitized = items.slice(0, MAX_ITEMS).map(sanitizeShareLink);
  if (sanitized.some((item) => !item)) {
    return { persisted: false, reason: "invalid-entry" };
  }
  const serialized = JSON.stringify(sanitized);
  if (serialized.length > RECENT_SHARE_LINKS_MAX_BYTES) {
    return { persisted: false, reason: "payload-too-large" };
  }
  const key = privateShareLinksStorageKey(context);
  try {
    localStorage.setItem(key, serialized);
  } catch {
    return {
      persisted: false,
      reason: isPrivateLocalDataContextCurrent(context)
        ? "storage-unavailable"
        : "stale-context",
    };
  }
  const finalStatus = getPrivateLocalDataStorageContextStatus(context);
  if (finalStatus === "current") return PERSISTED;
  try {
    if (localStorage.getItem(key) === serialized) removeInvalidStorage(key);
  } catch {
    // The write remains fenced and inaccessible without a matching owner marker.
  }
  return { persisted: false, reason: finalStatus };
}

export function listRecentShareLinks(
  context: RecentShareLinksContext | null = captureRecentShareLinksContext(),
): RecentShareLink[] {
  if (!context) return [];
  const now = Date.now();
  const stored = read(context);
  if (!stored.readable) return [];
  const items = stored.items.filter((x) => {
    const expires = new Date(x.expiresAt).getTime();
    return Number.isFinite(expires) && expires > now;
  });
  if (items.length !== stored.items.length) write(context, items);
  return getPrivateLocalDataStorageContextStatus(context) === "current" ? items : [];
}

export function addRecentShareLink(
  context: RecentShareLinksContext | null,
  input: Omit<RecentShareLink, "id" | "createdAt">,
): RecentShareLinksPersistenceResult {
  if (!isRecentShareLinksContextCurrent(context)) {
    return { persisted: false, reason: "stale-context" };
  }
  const nowIso = new Date().toISOString();
  const item = sanitizeShareLink({
    ...input,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: nowIso,
  });
  if (!item) return { persisted: false, reason: "invalid-entry" };
  const prev = read(context);
  if (!prev.readable) return { persisted: false, reason: prev.reason };
  return write(context, [item, ...prev.items.filter((x) => x.url !== input.url)]);
}

export function removeRecentShareLink(
  context: RecentShareLinksContext | null,
  id: string,
): RecentShareLinksPersistenceResult {
  if (!context) return { persisted: false, reason: "stale-context" };
  const stored = read(context);
  if (!stored.readable) return { persisted: false, reason: stored.reason };
  return write(context, stored.items.filter((x) => x.id !== id));
}

export function clearRecentShareLinks(
  context: RecentShareLinksContext | null,
): RecentShareLinksPersistenceResult {
  if (!context) return { persisted: false, reason: "stale-context" };
  const initialStatus = getPrivateLocalDataStorageContextStatus(context);
  if (initialStatus !== "current") {
    return { persisted: false, reason: initialStatus };
  }
  const result = removeInvalidStorage(privateShareLinksStorageKey(context));
  if (!result.persisted) return result;
  const finalStatus = getPrivateLocalDataStorageContextStatus(context);
  return finalStatus === "current"
    ? PERSISTED
    : { persisted: false, reason: finalStatus };
}
