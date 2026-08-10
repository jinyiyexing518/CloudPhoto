import {
  getDangerousOperationSnapshot,
  subscribeDangerousOperation,
  type DangerousOperationSnapshot,
} from "./dangerousOperationGate.ts";
import {
  preparePwaUpdateForRefresh,
  type PwaUpdateBrowserWindow,
} from "./updatePolicy.ts";

const RECOVERY_STORAGE_KEY = "cf_deployment_recovery_v1";
const RECOVERY_INTENT_KEY = "cf_deployment_recovery_intent_v1";
const RECOVERY_QUERY_KEY = "__cf_reload";
const ALLOWED_TABS = new Set(["timeline", "folder", "moments", "map", "capsule", "story"]);

export type DeploymentRecoveryStatus =
  | "idle"
  | "recovering"
  | "blocked-operation"
  | "blocked-offline"
  | "exhausted";

export interface DeploymentRecoveryState {
  status: DeploymentRecoveryStatus;
  message: string;
  primaryActionLabel?: "刷新新版";
  secondaryActionLabel?: "稍后重试";
}

export interface DeploymentChunkFailure {
  kind: "js" | "css";
  fingerprint: string;
}

interface RecoveryRecord {
  attempts: string[];
  chunks: string[];
}

interface RecoveryNavigationIntent {
  activeTab: string;
}

interface RecoveryTarget extends EventTarget {
  location?: Location;
  navigator?: Navigator;
  sessionStorage?: RecoveryStorage;
  history?: History;
  __CF_HARD_REFRESH__?: () => void;
}

type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface CoordinatorOptions {
  target: EventTarget;
  storage: RecoveryStorage | null;
  buildId: string;
  origin: string;
  isOnline: () => boolean;
  getDangerousOperationSnapshot: () => DangerousOperationSnapshot;
  subscribeDangerousOperation: (
    listener: (snapshot: DangerousOperationSnapshot) => void,
  ) => () => void;
  prepareUpdate?: () => Promise<void>;
  hardRefresh: () => void;
  getNavigationIntent?: () => RecoveryNavigationIntent | null;
  saveNavigationIntent?: (intent: RecoveryNavigationIntent) => void;
}

interface PreloadErrorEvent extends Event {
  payload?: unknown;
}

const IDLE_STATE: DeploymentRecoveryState = {
  status: "idle",
  message: "",
};

function manualRecoveryState(
  status: Exclude<DeploymentRecoveryStatus, "idle" | "recovering">,
  message: string,
): DeploymentRecoveryState {
  return {
    status,
    message,
    primaryActionLabel: "刷新新版",
    secondaryActionLabel: "稍后重试",
  };
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  }
  return "";
}

function candidateUrls(value: unknown, message: string): string[] {
  const candidates: string[] = [];
  if (value && typeof value === "object") {
    for (const key of ["url", "request", "href"] as const) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate === "string") candidates.push(candidate);
    }
  }
  candidates.push(...message.match(/https?:\/\/[^\s"'<>]+|\/assets\/[^\s"'<>]+/g) ?? []);
  return candidates.map((candidate) => candidate.replace(/[),.;:]+$/, ""));
}

function opaqueHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function classifyDeploymentChunkFailure(
  value: unknown,
  origin: string,
  options: { trustedVitePreloadEvent?: boolean } = {},
): DeploymentChunkFailure | null {
  const message = errorText(value);
  const dynamicImportFailure = /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i.test(message);
  const cssPreloadFailure = /unable to preload css|failed to preload css/i.test(message);
  if (!dynamicImportFailure && !cssPreloadFailure) return null;

  for (const candidate of candidateUrls(value, message)) {
    let url: URL;
    try {
      url = new URL(candidate, origin);
    } catch {
      continue;
    }
    if (url.origin !== origin || !url.pathname.startsWith("/assets/")) continue;
    const pathSegments = url.pathname.split("/");
    const fileName = pathSegments[pathSegments.length - 1] ?? "";
    const match = fileName.match(/-([A-Za-z0-9_-]{8,})\.(js|css)$/);
    if (!match) continue;
    const kind = match[2] as "js" | "css";
    if ((dynamicImportFailure && kind !== "js") || (cssPreloadFailure && kind !== "css")) {
      continue;
    }
    return {
      kind,
      fingerprint: opaqueHash(`${url.pathname}|${kind}`),
    };
  }
  if (
    options.trustedVitePreloadEvent
    && /^importing a module script failed\.?$/i.test(message.trim())
  ) {
    return {
      kind: "js",
      fingerprint: opaqueHash(`vite-preload:${message.toLowerCase()}`),
    };
  }
  return null;
}

function readRecord(storage: RecoveryStorage | null): RecoveryRecord {
  if (!storage) return { attempts: [], chunks: [] };
  try {
    const parsed = JSON.parse(storage.getItem(RECOVERY_STORAGE_KEY) ?? "{}") as Partial<RecoveryRecord>;
    return {
      attempts: Array.isArray(parsed.attempts)
        ? parsed.attempts.filter((value): value is string => typeof value === "string").slice(-8)
        : [],
      chunks: Array.isArray(parsed.chunks)
        ? parsed.chunks.filter((value): value is string => typeof value === "string").slice(-8)
        : [],
    };
  } catch (error) {
    console.error("[DeploymentRecovery] Cannot read recovery record:", error);
    return { attempts: [], chunks: [] };
  }
}

function writeRecord(storage: RecoveryStorage | null, record: RecoveryRecord): boolean {
  if (!storage) return false;
  try {
    storage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify({
      attempts: record.attempts.slice(-8),
      chunks: record.chunks.slice(-8),
    }));
    return true;
  } catch (error) {
    console.error("[DeploymentRecovery] Cannot persist recovery record:", error);
    return false;
  }
}

function safeIntent(intent: RecoveryNavigationIntent | null | undefined): RecoveryNavigationIntent | null {
  if (!intent || !ALLOWED_TABS.has(intent.activeTab)) return null;
  return { activeTab: intent.activeTab };
}

function saveIntent(storage: RecoveryStorage | null, intent: RecoveryNavigationIntent): void {
  if (!storage) return;
  try {
    storage.setItem(RECOVERY_INTENT_KEY, JSON.stringify(intent));
  } catch (error) {
    console.error("[DeploymentRecovery] Cannot persist navigation intent:", error);
  }
}

export function consumeDeploymentRecoveryIntent(
  storage?: Pick<Storage, "getItem" | "removeItem">,
): RecoveryNavigationIntent | null {
  let resolvedStorage: Pick<Storage, "getItem" | "removeItem"> | undefined;
  try {
    resolvedStorage = storage ?? sessionStorage;
    const parsed = JSON.parse(
      resolvedStorage.getItem(RECOVERY_INTENT_KEY) ?? "null",
    ) as RecoveryNavigationIntent | null;
    resolvedStorage.removeItem(RECOVERY_INTENT_KEY);
    return safeIntent(parsed);
  } catch (error) {
    try {
      resolvedStorage?.removeItem(RECOVERY_INTENT_KEY);
    } catch {
      // The caller already receives a fail-closed null intent.
    }
    console.error("[DeploymentRecovery] Cannot restore navigation intent:", error);
    return null;
  }
}

export function createDeploymentRecoveryCoordinator(options: CoordinatorOptions) {
  let state = IDLE_STATE;
  let pendingFailure: DeploymentChunkFailure | null = null;
  let recoveryInFlight = false;
  let disposed = false;
  const stateListeners = new Set<(next: DeploymentRecoveryState) => void>();

  const setState = (next: DeploymentRecoveryState) => {
    state = next;
    for (const listener of stateListeners) listener(next);
  };

  const attemptRecovery = async (manual: boolean) => {
    if (disposed || recoveryInFlight) return;
    const dangerousOperation = options.getDangerousOperationSnapshot();
    if (dangerousOperation.active) {
      setState(manualRecoveryState("blocked-operation", "新版资源已发布，当前操作完成后刷新"));
      return;
    }
    if (!options.isOnline()) {
      setState(manualRecoveryState("blocked-offline", "新版资源已发布，联网后将刷新"));
      return;
    }

    const failure = pendingFailure;
    const record = readRecord(options.storage);
    const attemptId = failure
      ? opaqueHash(`${options.buildId}|${failure.fingerprint}`)
      : null;
    if (
      !manual
      && failure
      && attemptId !== null
      && record.attempts.includes(attemptId)
    ) {
      setState(manualRecoveryState("exhausted", "新版资源仍未加载，请刷新新版或稍后重试。"));
      return;
    }

    recoveryInFlight = true;
    setState({ status: "recovering", message: "正在切换到新版资源…" });
    if (options.prepareUpdate) {
      try {
        await options.prepareUpdate();
      } catch (error) {
        console.error("[DeploymentRecovery] Service worker activation failed:", error);
      }
    }
    const latestDangerousOperation = options.getDangerousOperationSnapshot();
    if (latestDangerousOperation.active) {
      recoveryInFlight = false;
      setState(manualRecoveryState("blocked-operation", "新版资源已发布，当前操作完成后刷新"));
      return;
    }
    if (!manual && failure && attemptId) {
      const persisted = writeRecord(options.storage, {
        attempts: [...record.attempts, attemptId],
        chunks: record.chunks,
      });
      if (!persisted) {
        recoveryInFlight = false;
        setState(manualRecoveryState("exhausted", "无法安全自动刷新，请选择刷新新版或稍后重试。"));
        return;
      }
    }
    const intent = safeIntent(options.getNavigationIntent?.());
    if (intent) {
      if (options.saveNavigationIntent) options.saveNavigationIntent(intent);
      else saveIntent(options.storage, intent);
    }
    options.hardRefresh();
  };

  const handleFailure = (value: unknown, event?: Event) => {
    const failure = classifyDeploymentChunkFailure(value, options.origin, {
      trustedVitePreloadEvent: event?.type === "vite:preloadError",
    });
    if (!failure) return false;
    event?.preventDefault();
    console.error("[DeploymentRecovery] Deployment chunk failed:", value);
    if (!pendingFailure) pendingFailure = failure;
    void attemptRecovery(false);
    return true;
  };

  const onPreloadError = (event: Event) => {
    handleFailure((event as PreloadErrorEvent).payload, event);
  };
  const onOnline = () => {
    if (pendingFailure && state.status === "blocked-offline") void attemptRecovery(false);
  };
  options.target.addEventListener("vite:preloadError", onPreloadError);
  options.target.addEventListener("online", onOnline);
  const unsubscribeDangerousOperation = options.subscribeDangerousOperation((next) => {
    if (pendingFailure && !next.active && state.status === "blocked-operation") {
      void attemptRecovery(false);
    }
  });

  return {
    getState: () => state,
    subscribe(listener: (next: DeploymentRecoveryState) => void) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    handleFailure,
    requestManualRefresh() {
      void attemptRecovery(true);
    },
    dismiss() {
      setState(IDLE_STATE);
    },
    dispose() {
      disposed = true;
      unsubscribeDangerousOperation();
      options.target.removeEventListener("vite:preloadError", onPreloadError);
      options.target.removeEventListener("online", onOnline);
      stateListeners.clear();
    },
  };
}

let navigationIntentProvider: (() => RecoveryNavigationIntent | null) | null = null;
let installedCoordinator: ReturnType<typeof createDeploymentRecoveryCoordinator> | null = null;

function hardRefreshLocation(target: RecoveryTarget): void {
  if (!target.location) return;
  const url = new URL(target.location.href);
  url.searchParams.set(RECOVERY_QUERY_KEY, `${Date.now()}`);
  target.location.replace(url.toString());
}

function clearRecoveryQuery(target: RecoveryTarget): void {
  if (!target.location || !target.history) return;
  const url = new URL(target.location.href);
  if (!url.searchParams.has(RECOVERY_QUERY_KEY)) return;
  url.searchParams.delete(RECOVERY_QUERY_KEY);
  target.history.replaceState(target.history.state, "", url.toString());
}

function recoveryStorage(target: RecoveryTarget): RecoveryStorage | null {
  try {
    return target.sessionStorage ?? sessionStorage;
  } catch (error) {
    console.error("[DeploymentRecovery] Storage unavailable:", error);
    return null;
  }
}

export function installDeploymentRecovery(
  target: RecoveryTarget = window,
  buildId = `${__APP_VERSION__}:${__APP_BUILD_TIME__}`,
): void {
  if (installedCoordinator) return;
  clearRecoveryQuery(target);
  target.__CF_HARD_REFRESH__ = () => hardRefreshLocation(target);
  const storage = recoveryStorage(target);
  installedCoordinator = createDeploymentRecoveryCoordinator({
    target,
    storage,
    buildId,
    origin: target.location?.origin ?? window.location.origin,
    isOnline: () => target.navigator?.onLine !== false,
    getDangerousOperationSnapshot,
    subscribeDangerousOperation,
    prepareUpdate: async () => {
      await preparePwaUpdateForRefresh(target as PwaUpdateBrowserWindow);
    },
    hardRefresh: () => hardRefreshLocation(target),
    getNavigationIntent: () => navigationIntentProvider?.() ?? null,
  });
}

export function setDeploymentRecoveryIntentProvider(
  provider: (() => RecoveryNavigationIntent | null) | null,
): void {
  navigationIntentProvider = provider;
}

export function reportLazyBoundaryFailure(error: unknown): boolean {
  return installedCoordinator?.handleFailure(error) ?? false;
}

export function requestDeploymentRefresh(): void {
  installedCoordinator?.requestManualRefresh();
}

export function getDeploymentRecoveryState(): DeploymentRecoveryState {
  return installedCoordinator?.getState() ?? IDLE_STATE;
}

export function subscribeDeploymentRecovery(
  listener: (state: DeploymentRecoveryState) => void,
): () => void {
  return installedCoordinator?.subscribe(listener) ?? (() => {});
}

export function dismissDeploymentRecovery(): void {
  installedCoordinator?.dismiss();
}
