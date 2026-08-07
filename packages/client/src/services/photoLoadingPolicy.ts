export type AuthRole = "admin" | "viewer";

export interface AuthIdentity {
  userId: string;
  role: AuthRole;
}

export interface AuthorizationSnapshot extends AuthIdentity {
  token: string;
  cacheOwner: string;
}

export function authCacheOwner(userId: string, role: AuthRole): string {
  return `${encodeURIComponent(userId)}:${role}`;
}

export function decodeAuthorizationSnapshot(token: string | null): AuthorizationSnapshot | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const normalized = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const decoded = JSON.parse(atob(normalized)) as {
      userId?: unknown;
      role?: unknown;
    };
    if (
      typeof decoded.userId !== "string"
      || (decoded.role !== "admin" && decoded.role !== "viewer")
    ) {
      return null;
    }
    return {
      token,
      userId: decoded.userId,
      role: decoded.role,
      cacheOwner: authCacheOwner(decoded.userId, decoded.role),
    };
  } catch {
    return null;
  }
}

export function isSafeReplayMethod(method: string): boolean {
  return ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export type ProxyProbeResult = "proxy" | "not-proxy" | "transient";

export const PROXY_PROBE_STABLE_TTL_MS = 5 * 60 * 1000;
export const PROXY_PROBE_TRANSIENT_TTL_MS = 5_000;

export function classifyProxyProbe(input: {
  ok: boolean;
  status: number;
  contentType: string;
  route?: string;
}): ProxyProbeResult {
  if (input.ok && input.contentType.includes("application/json")) {
    return input.route === "cloudphoto-proxy" ? "proxy" : "not-proxy";
  }
  if (input.ok && input.contentType.includes("text/html")) {
    return "not-proxy";
  }
  if (input.status === 404) {
    return "not-proxy";
  }
  return "transient";
}

export function proxyProbeTtlMs(result: ProxyProbeResult): number {
  return result === "transient"
    ? PROXY_PROBE_TRANSIENT_TTL_MS
    : PROXY_PROBE_STABLE_TTL_MS;
}

export function canPublishPhotoList(input: {
  expectedOwner: string;
  currentOwner: string | null;
  expectedCacheGeneration: number;
  currentCacheGeneration: number;
  expectedStateRevision?: number;
  currentStateRevision?: number;
}): boolean {
  return input.expectedOwner.length > 0
    && input.currentOwner === input.expectedOwner
    && input.expectedCacheGeneration === input.currentCacheGeneration
    && (
      input.expectedStateRevision === undefined
      || input.currentStateRevision === input.expectedStateRevision
    );
}

export interface HedgeAttempt<T> {
  promise: Promise<T>;
  cancel: (reason?: unknown) => void;
  release: () => void;
}

export interface HedgeOutcome<T> {
  value: T;
  source: "primary" | "fallback";
  release: () => void;
}

interface SettledValue<T> {
  value: T;
  attempt: HedgeAttempt<T>;
  source: "primary" | "fallback";
}

export function raceHedgedAttempts<T>(options: {
  startPrimary: () => HedgeAttempt<T>;
  startFallback: () => HedgeAttempt<T>;
  hedgeDelayMs: number;
  isUsable: (value: T) => boolean;
  signal?: AbortSignal;
}): Promise<HedgeOutcome<T>> {
  return new Promise((resolve, reject) => {
    const attempts: Partial<Record<"primary" | "fallback", HedgeAttempt<T>>> = {};
    const failures: Partial<Record<"primary" | "fallback", unknown>> = {};
    const unusable: Partial<Record<"primary" | "fallback", SettledValue<T>>> = {};
    let fallbackStarted = false;
    let finished = false;

    const cleanupTimer = () => clearTimeout(hedgeTimer);
    const cleanupAbort = () => options.signal?.removeEventListener("abort", onAbort);
    const cancelAttempt = (source: "primary" | "fallback", reason?: unknown) => {
      const attempt = attempts[source];
      if (!attempt) return;
      attempt.cancel(reason);
      attempt.release();
    };
    const finish = (outcome: SettledValue<T>) => {
      if (finished) return;
      finished = true;
      cleanupTimer();
      cleanupAbort();
      const loser = outcome.source === "primary" ? "fallback" : "primary";
      cancelAttempt(loser, new DOMException("Hedged request lost", "AbortError"));
      resolve({
        value: outcome.value,
        source: outcome.source,
        release: outcome.attempt.release,
      });
    };
    const rejectAll = () => {
      if (finished) return;
      finished = true;
      cleanupTimer();
      cleanupAbort();
      reject(failures.primary ?? failures.fallback ?? new TypeError("Both routes failed"));
    };
    const finishIfComplete = () => {
      if (!fallbackStarted) return;
      const primaryDone = "primary" in failures || "primary" in unusable;
      const fallbackDone = "fallback" in failures || "fallback" in unusable;
      if (!primaryDone || !fallbackDone) return;
      const selected = unusable.primary ?? unusable.fallback;
      if (selected) {
        const discarded = selected.source === "primary" ? unusable.fallback : unusable.primary;
        if (discarded) {
          discarded.attempt.cancel(new DOMException("Alternate response discarded", "AbortError"));
          discarded.attempt.release();
        }
        finish(selected);
      } else {
        rejectAll();
      }
    };
    const settle = (
      source: "primary" | "fallback",
      attempt: HedgeAttempt<T>,
      value: T,
    ) => {
      if (finished) {
        attempt.cancel(new DOMException("Request already settled", "AbortError"));
        attempt.release();
        return;
      }
      if (options.isUsable(value)) {
        finish({ value, attempt, source });
        return;
      }
      unusable[source] = { value, attempt, source };
      if (source === "primary") startFallback();
      finishIfComplete();
    };
    const fail = (
      source: "primary" | "fallback",
      attempt: HedgeAttempt<T>,
      error: unknown,
    ) => {
      attempt.release();
      if (finished) return;
      failures[source] = error;
      if (source === "primary") startFallback();
      finishIfComplete();
    };
    const runAttempt = (source: "primary" | "fallback", attempt: HedgeAttempt<T>) => {
      attempts[source] = attempt;
      void attempt.promise.then(
        (value) => settle(source, attempt, value),
        (error) => fail(source, attempt, error),
      );
    };
    const startFallback = () => {
      if (finished || fallbackStarted) return;
      fallbackStarted = true;
      runAttempt("fallback", options.startFallback());
    };
    const onAbort = () => {
      if (finished) return;
      finished = true;
      cleanupTimer();
      cleanupAbort();
      const reason = options.signal?.reason ?? new DOMException("Aborted", "AbortError");
      cancelAttempt("primary", reason);
      cancelAttempt("fallback", reason);
      reject(reason);
    };

    const hedgeTimer = setTimeout(startFallback, options.hedgeDelayMs);
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    runAttempt("primary", options.startPrimary());
  });
}
