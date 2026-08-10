import {
  capturePrivateLocalDataContext,
  isPrivateLocalDataContextCurrent,
  isPrivateLocalDataStorageContextCurrent,
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

function removeInvalidStorage(key: string): boolean {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    // Invalid private data remains inaccessible when storage itself is unavailable.
    return false;
  }
}

function read(context: RecentShareLinksContext): RecentShareLink[] {
  const key = privateShareLinksStorageKey(context);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    if (raw.length > RECENT_SHARE_LINKS_MAX_BYTES) throw new Error("Recent share payload too large");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_ITEMS) {
      throw new Error("Invalid recent share payload");
    }
    const items = parsed.map(sanitizeShareLink);
    if (items.some((item) => !item)) throw new Error("Invalid recent share entry");
    return isPrivateLocalDataStorageContextCurrent(context)
      ? items as RecentShareLink[]
      : [];
  } catch {
    removeInvalidStorage(key);
    return [];
  }
}

function write(context: RecentShareLinksContext, items: RecentShareLink[]): boolean {
  if (!isPrivateLocalDataStorageContextCurrent(context)) return false;
  const sanitized = items.slice(0, MAX_ITEMS).map(sanitizeShareLink);
  if (sanitized.some((item) => !item)) return false;
  const serialized = JSON.stringify(sanitized);
  if (serialized.length > RECENT_SHARE_LINKS_MAX_BYTES) return false;
  const key = privateShareLinksStorageKey(context);
  try {
    localStorage.setItem(key, serialized);
    if (isPrivateLocalDataStorageContextCurrent(context)) return true;
    if (localStorage.getItem(key) === serialized) removeInvalidStorage(key);
    return false;
  } catch {
    return false;
  }
}

export function listRecentShareLinks(
  context: RecentShareLinksContext | null = captureRecentShareLinksContext(),
): RecentShareLink[] {
  if (!context) return [];
  const now = Date.now();
  const stored = read(context);
  const items = stored.filter((x) => {
    const expires = new Date(x.expiresAt).getTime();
    return Number.isFinite(expires) && expires > now;
  });
  if (items.length !== stored.length && !write(context, items)) return [];
  return isPrivateLocalDataStorageContextCurrent(context) ? items : [];
}

export function addRecentShareLink(
  context: RecentShareLinksContext | null,
  input: Omit<RecentShareLink, "id" | "createdAt">,
): boolean {
  if (!isRecentShareLinksContextCurrent(context)) return false;
  const nowIso = new Date().toISOString();
  const item = sanitizeShareLink({
    ...input,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: nowIso,
  });
  if (!item) return false;
  const prev = read(context).filter((x) => x.url !== input.url);
  return write(context, [item, ...prev]);
}

export function removeRecentShareLink(
  context: RecentShareLinksContext | null,
  id: string,
): boolean {
  if (!context) return false;
  return write(context, read(context).filter((x) => x.id !== id));
}

export function clearRecentShareLinks(context: RecentShareLinksContext | null): boolean {
  if (!isPrivateLocalDataStorageContextCurrent(context)) return false;
  return removeInvalidStorage(privateShareLinksStorageKey(context))
    && isPrivateLocalDataStorageContextCurrent(context);
}
