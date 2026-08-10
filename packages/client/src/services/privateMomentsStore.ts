import {
  registerPrivatePhotoCacheWrite,
} from "./privatePhotoCacheLifecycle.ts";
import {
  capturePrivateLocalDataContext,
  isPrivateLocalDataStorageContextCurrent,
  privateLocalDataStorageKey,
  registerPrivateLocalDataReset,
  type PrivateLocalDataContext,
} from "./privateLocalDataLifecycle.ts";

export const PRIVATE_MOMENTS_MAX_BYTES = 256 * 1024;
const PRIVATE_DIAGNOSTICS_MAX_BYTES = 4 * 1024;
const PRIVATE_MOMENTS_MAX_ENTRIES = 500;
const PRIVATE_MOMENTS_MAX_VIEWERS = 100;
const PRIVATE_MOMENTS_MAX_DAYS = 400;
const PRIVATE_MOMENTS_MAX_COUNTER = 1_000_000_000;
const PRIVATE_MOMENTS_MAX_PHOTO_NAME = 1024;
const PRIVATE_MOMENTS_MAX_VIEWER_NAME = 80;

export type PrivateMomentsStatus =
  | "unknown"
  | "local-only"
  | "server-synced"
  | "server-unavailable";

export interface PrivateMomentInsight {
  photoName: string;
  totalViews: number;
  lastViewedAt?: string;
  lastViewedBy?: string;
  viewers: Record<string, number>;
  dailyViews: Record<string, number>;
  updatedAt?: string;
}

export interface PrivateMomentsDiagnostics {
  status: PrivateMomentsStatus;
  message?: string;
  photoCount?: number;
  updatedAt?: string;
}

export interface PrivateMomentsContext extends PrivateLocalDataContext {
  workspaceId: string;
}

type PrivateMomentsDataKind = "insights" | "diagnostics";
type PrivateMomentsListener = (map: Record<string, PrivateMomentInsight>) => void;

const memoryInsights = new Map<string, Record<string, PrivateMomentInsight>>();
const persistedInsightValues = new Map<string, string | null>();
const insightListeners = new Map<string, Set<PrivateMomentsListener>>();
const localWriteChains = new Map<string, Promise<boolean>>();
registerPrivateLocalDataReset(() => {
  memoryInsights.clear();
  persistedInsightValues.clear();
  for (const listeners of insightListeners.values()) {
    for (const listener of listeners) listener({});
  }
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedCounter(value: unknown): number | null {
  return (
    typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= PRIVATE_MOMENTS_MAX_COUNTER
  ) ? value : null;
}

function boundedTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function sanitizeCounterMap(
  value: unknown,
  maximumEntries: number,
  validKey: (key: string) => boolean,
): Record<string, number> | null {
  if (!isPlainRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > maximumEntries) return null;
  const sanitized: Record<string, number> = {};
  for (const [key, rawCount] of entries) {
    const count = boundedCounter(rawCount);
    if (!validKey(key) || count === null) return null;
    sanitized[key] = count;
  }
  return sanitized;
}

function sanitizeInsight(photoName: string, value: unknown): PrivateMomentInsight | null {
  if (
    !photoName
    || photoName.length > PRIVATE_MOMENTS_MAX_PHOTO_NAME
    || !isPlainRecord(value)
    || value.photoName !== photoName
  ) {
    return null;
  }
  const totalViews = boundedCounter(value.totalViews);
  const viewers = sanitizeCounterMap(
    value.viewers,
    PRIVATE_MOMENTS_MAX_VIEWERS,
    (viewer) => viewer.length > 0 && viewer.length <= PRIVATE_MOMENTS_MAX_VIEWER_NAME,
  );
  const dailyViews = sanitizeCounterMap(
    value.dailyViews,
    PRIVATE_MOMENTS_MAX_DAYS,
    (day) => /^\d{4}-\d{2}-\d{2}$/.test(day),
  );
  if (totalViews === null || !viewers || !dailyViews) return null;
  const lastViewedBy = typeof value.lastViewedBy === "string"
    && value.lastViewedBy.length <= PRIVATE_MOMENTS_MAX_VIEWER_NAME
    ? value.lastViewedBy
    : undefined;
  const sanitized: PrivateMomentInsight = {
    photoName,
    totalViews,
    viewers,
    dailyViews,
  };
  const lastViewedAt = boundedTimestamp(value.lastViewedAt);
  const updatedAt = boundedTimestamp(value.updatedAt);
  if (lastViewedAt) sanitized.lastViewedAt = lastViewedAt;
  if (lastViewedBy) sanitized.lastViewedBy = lastViewedBy;
  if (updatedAt) sanitized.updatedAt = updatedAt;
  return sanitized;
}

function normalizeWorkspaceId(workspaceId: string | null): string | null {
  if (workspaceId === null || workspaceId.length > 512) return null;
  return workspaceId || "personal";
}

export function capturePrivateMomentsContext(
  workspaceId: string | null,
): PrivateMomentsContext | null {
  const context = capturePrivateLocalDataContext();
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  if (!context || !normalizedWorkspaceId) return null;
  return {
    ...context,
    workspaceId: normalizedWorkspaceId,
  };
}

export function isPrivateMomentsContextCurrent(
  context: PrivateMomentsContext | null,
): context is PrivateMomentsContext {
  return isPrivateLocalDataStorageContextCurrent(context);
}

export function privateMomentsStorageKey(
  kind: PrivateMomentsDataKind,
  context: PrivateMomentsContext,
): string {
  return privateLocalDataStorageKey(context, context.workspaceId, kind);
}

function removeInvalidStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Invalid data remains inaccessible when storage itself is unavailable.
  }
}

function readStoredMomentInsights(
  context: PrivateMomentsContext,
): Record<string, PrivateMomentInsight> {
  const key = privateMomentsStorageKey("insights", context);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      persistedInsightValues.set(key, null);
      return {};
    }
    if (raw.length > PRIVATE_MOMENTS_MAX_BYTES) {
      removeInvalidStorage(key);
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed)) throw new Error("Invalid private moments payload");
    const entries = Object.entries(parsed);
    if (entries.length > PRIVATE_MOMENTS_MAX_ENTRIES) {
      throw new Error("Private moments entry limit exceeded");
    }
    const sanitized: Record<string, PrivateMomentInsight> = {};
    for (const [photoName, value] of entries) {
      const insight = sanitizeInsight(photoName, value);
      if (!insight) throw new Error("Invalid private moments entry");
      sanitized[photoName] = insight;
    }
    persistedInsightValues.set(key, raw);
    return isPrivateMomentsContextCurrent(context) ? sanitized : {};
  } catch {
    removeInvalidStorage(key);
    persistedInsightValues.set(key, null);
    return {};
  }
}

export function readPrivateMomentInsights(
  workspaceId: string | null,
): Record<string, PrivateMomentInsight> {
  const context = capturePrivateMomentsContext(workspaceId);
  if (!context) return {};
  const key = privateMomentsStorageKey("insights", context);
  const cached = memoryInsights.get(key);
  if (cached) {
    try {
      if (persistedInsightValues.get(key) === localStorage.getItem(key)) return cached;
    } catch {
      return {};
    }
  }
  const stored = readStoredMomentInsights(context);
  memoryInsights.set(key, stored);
  return stored;
}

function notifyMomentInsights(
  key: string,
  map: Record<string, PrivateMomentInsight>,
): void {
  for (const listener of insightListeners.get(key) ?? []) listener(map);
}

export function subscribePrivateMomentInsights(
  workspaceId: string | null,
  listener: PrivateMomentsListener,
): () => void {
  const context = capturePrivateMomentsContext(workspaceId);
  if (!context) return () => undefined;
  const key = privateMomentsStorageKey("insights", context);
  const listeners = insightListeners.get(key) ?? new Set<PrivateMomentsListener>();
  listeners.add(listener);
  insightListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) insightListeners.delete(key);
  };
}

export function mutatePrivateMomentInsights(
  context: PrivateMomentsContext | null,
  updater: (
    current: Record<string, PrivateMomentInsight>,
  ) => Record<string, PrivateMomentInsight>,
): Record<string, PrivateMomentInsight> | null {
  if (!isPrivateMomentsContextCurrent(context)) return null;
  const key = privateMomentsStorageKey("insights", context);
  const current = memoryInsights.get(key) ?? readStoredMomentInsights(context);
  const updated = updater(current);
  if (!isPlainRecord(updated) || Object.keys(updated).length > PRIVATE_MOMENTS_MAX_ENTRIES) {
    return null;
  }
  const sanitized: Record<string, PrivateMomentInsight> = {};
  for (const [photoName, value] of Object.entries(updated)) {
    const insight = sanitizeInsight(photoName, value);
    if (!insight) return null;
    sanitized[photoName] = insight;
  }
  if (!isPrivateMomentsContextCurrent(context)) return null;
  memoryInsights.set(key, sanitized);
  notifyMomentInsights(key, sanitized);
  return sanitized;
}

async function runSerializedMomentWrite(
  key: string,
  operation: () => boolean,
): Promise<boolean> {
  const previous = localWriteChains.get(key) ?? Promise.resolve(true);
  const pending = previous.catch(() => false).then(async () => {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request(`cloudphoto-moments:${key}`, operation);
    }
    return operation();
  });
  localWriteChains.set(key, pending);
  try {
    return await pending;
  } finally {
    if (localWriteChains.get(key) === pending) localWriteChains.delete(key);
  }
}

export function recordPrivateMomentViewLocally(
  context: PrivateMomentsContext | null,
  photoName: string,
  viewer: string,
  viewedAt: string,
): Promise<boolean> {
  const day = viewedAt.slice(0, 10);
  const previous = context
    ? memoryInsights.get(privateMomentsStorageKey("insights", context))?.[photoName]
    : undefined;
  const updated = mutatePrivateMomentInsights(context, (current) => {
    const item = current[photoName] ?? {
      photoName,
      totalViews: 0,
      viewers: {},
      dailyViews: {},
    };
    return {
      ...current,
      [photoName]: {
        ...item,
        totalViews: item.totalViews + 1,
        lastViewedAt: viewedAt,
        lastViewedBy: viewer,
        viewers: {
          ...item.viewers,
          [viewer]: (item.viewers[viewer] ?? 0) + 1,
        },
        dailyViews: {
          ...item.dailyViews,
          [day]: (item.dailyViews[day] ?? 0) + 1,
        },
      },
    };
  });
  if (!context || !updated) return Promise.resolve(false);
  const key = privateMomentsStorageKey("insights", context);
  const operation = runSerializedMomentWrite(key, () => {
    if (!isPrivateMomentsContextCurrent(context)) return false;
    const persisted = readStoredMomentInsights(context);
    const current = persisted[photoName] ?? previous ?? {
      photoName,
      totalViews: 0,
      viewers: {},
      dailyViews: {},
    };
    return writePrivateMomentInsightsUnlocked(context, {
      ...persisted,
      [photoName]: {
        ...current,
        totalViews: current.totalViews + 1,
        lastViewedAt: viewedAt,
        lastViewedBy: viewer,
        viewers: {
          ...current.viewers,
          [viewer]: (current.viewers[viewer] ?? 0) + 1,
        },
        dailyViews: {
          ...current.dailyViews,
          [day]: (current.dailyViews[day] ?? 0) + 1,
        },
      },
    });
  });
  const unregisterWrite = registerPrivatePhotoCacheWrite(operation.then(() => undefined));
  void operation.then(unregisterWrite, unregisterWrite);
  return operation;
}

function insightRecency(insight: PrivateMomentInsight): number {
  return Date.parse(insight.updatedAt ?? insight.lastViewedAt ?? "") || 0;
}

function mergePersistedInsight(
  current: PrivateMomentInsight | undefined,
  incoming: PrivateMomentInsight,
): PrivateMomentInsight {
  if (!current) return incoming;
  const incomingIsNewer = insightRecency(incoming) >= insightRecency(current);
  const viewers = { ...current.viewers };
  for (const [viewer, count] of Object.entries(incoming.viewers)) {
    viewers[viewer] = Math.max(viewers[viewer] ?? 0, count);
  }
  const dailyViews = { ...current.dailyViews };
  for (const [day, count] of Object.entries(incoming.dailyViews)) {
    dailyViews[day] = Math.max(dailyViews[day] ?? 0, count);
  }
  return {
    ...(incomingIsNewer ? current : incoming),
    ...(incomingIsNewer ? incoming : current),
    totalViews: Math.max(current.totalViews, incoming.totalViews),
    viewers,
    dailyViews,
  };
}

export function writePrivateMomentInsights(
  context: PrivateMomentsContext | null,
  map: Record<string, PrivateMomentInsight>,
): Promise<boolean> {
  if (!context) return Promise.resolve(false);
  const key = privateMomentsStorageKey("insights", context);
  const operation = runSerializedMomentWrite(
    key,
    () => writePrivateMomentInsightsUnlocked(context, map),
  );
  const unregisterWrite = registerPrivatePhotoCacheWrite(operation.then(() => undefined));
  void operation.then(unregisterWrite, unregisterWrite);
  return operation;
}

function writePrivateMomentInsightsUnlocked(
  context: PrivateMomentsContext | null,
  map: Record<string, PrivateMomentInsight>,
): boolean {
  if (!isPrivateMomentsContextCurrent(context) || !isPlainRecord(map)) return false;
  const persisted = readStoredMomentInsights(context);
  const mergedMap: Record<string, PrivateMomentInsight> = { ...persisted };
  for (const [photoName, value] of Object.entries(map)) {
    const insight = sanitizeInsight(photoName, value);
    if (!insight) return false;
    mergedMap[photoName] = mergePersistedInsight(mergedMap[photoName], insight);
  }
  const sanitizedEntries = Object.entries(mergedMap);
  sanitizedEntries.sort((a, b) => insightRecency(b[1]) - insightRecency(a[1]));
  let boundedEntries = sanitizedEntries.slice(0, PRIVATE_MOMENTS_MAX_ENTRIES);
  let serialized = JSON.stringify(Object.fromEntries(boundedEntries));
  while (serialized.length > PRIVATE_MOMENTS_MAX_BYTES && boundedEntries.length > 0) {
    boundedEntries = boundedEntries.slice(0, Math.floor(boundedEntries.length / 2));
    serialized = JSON.stringify(Object.fromEntries(boundedEntries));
  }
  if (serialized.length > PRIVATE_MOMENTS_MAX_BYTES || !isPrivateMomentsContextCurrent(context)) {
    return false;
  }
  try {
    const key = privateMomentsStorageKey("insights", context);
    localStorage.setItem(key, serialized);
    if (isPrivateMomentsContextCurrent(context)) {
      const persistedMap = Object.fromEntries(boundedEntries);
      memoryInsights.set(key, persistedMap);
      persistedInsightValues.set(key, serialized);
      notifyMomentInsights(key, persistedMap);
      return true;
    }
    removeInvalidStorage(key);
    return false;
  } catch {
    return false;
  }
}

function sanitizeDiagnostics(value: unknown): PrivateMomentsDiagnostics | null {
  if (!isPlainRecord(value)) return null;
  const allowedStatuses: readonly PrivateMomentsStatus[] = [
    "unknown",
    "local-only",
    "server-synced",
    "server-unavailable",
  ];
  if (!allowedStatuses.includes(value.status as PrivateMomentsStatus)) return null;
  const message = typeof value.message === "string" && value.message.length <= 240
    ? value.message
    : undefined;
  const photoCount = value.photoCount === undefined ? undefined : boundedCounter(value.photoCount);
  if (photoCount === null) return null;
  return {
    status: value.status as PrivateMomentsStatus,
    message,
    photoCount,
    updatedAt: boundedTimestamp(value.updatedAt),
  };
}

export function readPrivateMomentsDiagnostics(
  workspaceId: string | null,
): PrivateMomentsDiagnostics {
  const context = capturePrivateMomentsContext(workspaceId);
  if (!context) return { status: "unknown" };
  const key = privateMomentsStorageKey("diagnostics", context);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { status: "unknown" };
    if (raw.length > PRIVATE_DIAGNOSTICS_MAX_BYTES) {
      removeInvalidStorage(key);
      return { status: "unknown" };
    }
    const diagnostics = sanitizeDiagnostics(JSON.parse(raw));
    if (!diagnostics) throw new Error("Invalid private moments diagnostics");
    return isPrivateMomentsContextCurrent(context)
      ? diagnostics
      : { status: "unknown" };
  } catch {
    removeInvalidStorage(key);
    return { status: "unknown" };
  }
}

export function writePrivateMomentsDiagnostics(
  context: PrivateMomentsContext | null,
  status: PrivateMomentsStatus,
  details?: { message?: string; photoCount?: number },
): boolean {
  if (!isPrivateMomentsContextCurrent(context)) return false;
  const diagnostics = sanitizeDiagnostics({
    status,
    message: details?.message?.slice(0, 240),
    photoCount: details?.photoCount,
    updatedAt: new Date().toISOString(),
  });
  if (!diagnostics) return false;
  const serialized = JSON.stringify(diagnostics);
  if (serialized.length > PRIVATE_DIAGNOSTICS_MAX_BYTES) return false;
  try {
    const key = privateMomentsStorageKey("diagnostics", context);
    localStorage.setItem(key, serialized);
    if (isPrivateMomentsContextCurrent(context)) return true;
    removeInvalidStorage(key);
    return false;
  } catch {
    return false;
  }
}
