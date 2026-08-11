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
