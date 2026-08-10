export const VIDEO_COVER_REPAIR_MAX_FILE_BYTES = 48 * 1024 * 1024;
export const VIDEO_COVER_REPAIR_SESSION_BUDGET_BYTES = 160 * 1024 * 1024;
export const VIDEO_COVER_REPAIR_MAX_ATTEMPTS = 2;
export const VIDEO_COVER_REPAIR_RETRY_BACKOFF_MS = 30_000;
export const VIDEO_PLAYBACK_COVER_MIN_TIME_SECONDS = 0.1;

export interface VideoCoverRepairNetworkSnapshot {
  online: boolean;
  effectiveType?: string;
  saveData?: boolean;
}

export interface VideoCoverRepairNetworkPolicy {
  enabled: boolean;
  concurrency: 0 | 1 | 2;
  reason: VideoCoverRepairReason | null;
}

export type VideoCoverRepairReason =
  | "offline"
  | "save-data"
  | "slow-network"
  | "file-too-large"
  | "size-unknown"
  | "budget-exhausted"
  | "upload-pending"
  | "failed";

export type VideoCoverRepairPhase =
  | "idle"
  | "queued"
  | "repairing"
  | "succeeded"
  | "deferred"
  | "failed";

export interface VideoCoverRepairState {
  phase: VideoCoverRepairPhase;
  thumbnailUrl: string | null;
  reason: VideoCoverRepairReason | null;
  attempts: number;
}

export interface VideoCoverFrameInformation {
  lowInformation: boolean;
  score: number;
  meanLuminance: number;
  luminanceDeviation: number;
  dynamicRange: number;
}

export class VideoCoverBrokenRegistry {
  private readonly entries = new Set<string>();

  private key(scope: string | number, blobName: string): string {
    return `${scope}:${blobName}`;
  }

  mark(scope: string | number, blobName: string): void {
    this.entries.add(this.key(scope, blobName));
  }

  has(scope: string | number, blobName: string): boolean {
    return this.entries.has(this.key(scope, blobName));
  }

  clear(scope: string | number, blobName: string): void {
    this.entries.delete(this.key(scope, blobName));
  }

  reset(): void {
    this.entries.clear();
  }
}

export function needsPlaybackVideoCoverCapture(
  hasDerivative: boolean,
  knownBroken: boolean,
): boolean {
  return !hasDerivative || knownBroken;
}

export function isPhotoBlobInWorkspace(
  blobName: string,
  groupId: string | null,
): boolean {
  if (groupId === null) return false;
  return groupId
    ? blobName.startsWith(`groups/${groupId}/`)
    : blobName.startsWith("personal/");
}

export function canInspectPlaybackVideoCover({
  needsCapture,
  captureAttempted,
  canCapture,
  currentTime,
}: {
  needsCapture: boolean;
  captureAttempted: boolean;
  canCapture: boolean;
  currentTime: number;
}): boolean {
  return needsCapture
    && !captureAttempted
    && canCapture
    && Number.isFinite(currentTime)
    && currentTime >= VIDEO_PLAYBACK_COVER_MIN_TIME_SECONDS;
}

export function videoCoverFrameInformation(
  rgba: Uint8ClampedArray,
): VideoCoverFrameInformation {
  let count = 0;
  let sum = 0;
  let sumSquares = 0;
  let min = 255;
  let max = 0;
  let neutralCount = 0;
  for (let index = 0; index + 3 < rgba.length; index += 4) {
    if (rgba[index + 3] < 128) continue;
    const red = rgba[index];
    const green = rgba[index + 1];
    const blue = rgba[index + 2];
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    count += 1;
    sum += luminance;
    sumSquares += luminance * luminance;
    min = Math.min(min, luminance);
    max = Math.max(max, luminance);
    if (Math.max(red, green, blue) - Math.min(red, green, blue) <= 18) {
      neutralCount += 1;
    }
  }
  if (count === 0) {
    return {
      lowInformation: true,
      score: 0,
      meanLuminance: 0,
      luminanceDeviation: 0,
      dynamicRange: 0,
    };
  }
  const meanLuminance = sum / count;
  const variance = Math.max(0, sumSquares / count - meanLuminance * meanLuminance);
  const luminanceDeviation = Math.sqrt(variance);
  const dynamicRange = max - min;
  const neutralRatio = neutralCount / count;
  const nearlyUniform = luminanceDeviation <= 10 && dynamicRange <= 35;
  const nearBlankTone = meanLuminance >= 200 || meanLuminance <= 35;
  const lowInformation = neutralRatio >= 0.97 && nearlyUniform && nearBlankTone;
  return {
    lowInformation,
    score: luminanceDeviation + dynamicRange * 0.5 + (1 - neutralRatio) * 50,
    meanLuminance,
    luminanceDeviation,
    dynamicRange,
  };
}

export function videoCoverRepairCandidateTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  return [
    Math.min(0.1, duration * 0.05),
    Math.min(1, duration * 0.15),
    Math.min(2, duration * 0.4),
  ].filter((time, index, values) => (
    time >= 0
    && time < duration
    && values.findIndex((candidate) => Math.abs(candidate - time) < 0.01) === index
  ));
}

export interface VideoCoverRepairRequest {
  blobName: string;
  originalUrl: string;
  contentType: string;
  size: number;
  hasDerivative: boolean;
  derivativeBroken: boolean;
}

type RequestWithBudget = VideoCoverRepairRequest & {
  sessionEstimatedBytes?: number;
};

export interface VideoCoverRepairSubscription {
  setVisible(visible: boolean): void;
  markDerivativeBroken(): void;
  dispose(): void;
}

interface Subscriber {
  listener: (state: VideoCoverRepairState) => void;
  visible: boolean;
}

interface QueueEntry {
  request: VideoCoverRepairRequest;
  state: VideoCoverRepairState;
  subscribers: Map<symbol, Subscriber>;
  controller: AbortController | null;
  nextRetryAt: number;
}

interface VideoCoverRepairQueueOptions {
  execute: (
    request: VideoCoverRepairRequest,
    signal: AbortSignal,
  ) => Promise<string | null>;
  network: () => VideoCoverRepairNetworkSnapshot;
  blocked?: (request: VideoCoverRepairRequest) => boolean;
  now?: () => number;
}

export function videoCoverRepairNetworkPolicy(
  snapshot: VideoCoverRepairNetworkSnapshot,
): VideoCoverRepairNetworkPolicy {
  if (!snapshot.online) return { enabled: false, concurrency: 0, reason: "offline" };
  if (snapshot.saveData) return { enabled: false, concurrency: 0, reason: "save-data" };
  if (snapshot.effectiveType === "slow-2g" || snapshot.effectiveType === "2g") {
    return { enabled: false, concurrency: 0, reason: "slow-network" };
  }
  const explicitlyFast = snapshot.effectiveType === "3g" || snapshot.effectiveType === "4g";
  return { enabled: true, concurrency: explicitlyFast ? 2 : 1, reason: null };
}

export function autoRepairVideoCoverBlockReason(
  request: VideoCoverRepairRequest,
  sessionEstimatedBytes: number,
): VideoCoverRepairReason | null {
  if (
    !request.contentType.startsWith("video/")
    || (request.hasDerivative && !request.derivativeBroken)
  ) {
    return "failed";
  }
  if (!Number.isFinite(request.size) || request.size <= 0) return "size-unknown";
  if (request.size > VIDEO_COVER_REPAIR_MAX_FILE_BYTES) return "file-too-large";
  if (
    sessionEstimatedBytes + request.size
    > VIDEO_COVER_REPAIR_SESSION_BUDGET_BYTES
  ) {
    return "budget-exhausted";
  }
  return null;
}

export function canAutoRepairVideoCover(
  request: RequestWithBudget,
): boolean {
  return autoRepairVideoCoverBlockReason(request, request.sessionEstimatedBytes ?? 0) === null;
}

function initialState(): VideoCoverRepairState {
  return { phase: "idle", thumbnailUrl: null, reason: null, attempts: 0 };
}

export class VideoCoverRepairQueue {
  private readonly execute: VideoCoverRepairQueueOptions["execute"];
  private readonly network: VideoCoverRepairQueueOptions["network"];
  private readonly blocked: NonNullable<VideoCoverRepairQueueOptions["blocked"]>;
  private readonly now: () => number;
  private readonly entries = new Map<string, QueueEntry>();
  private activeCount = 0;
  private sessionEstimatedBytes = 0;

  constructor(options: VideoCoverRepairQueueOptions) {
    this.execute = options.execute;
    this.network = options.network;
    this.blocked = options.blocked ?? (() => false);
    this.now = options.now ?? Date.now;
  }

  subscribe(
    request: VideoCoverRepairRequest,
    listener: (state: VideoCoverRepairState) => void,
  ): VideoCoverRepairSubscription {
    let entry = this.entries.get(request.blobName);
    if (!entry) {
      entry = {
        request,
        state: initialState(),
        subscribers: new Map(),
        controller: null,
        nextRetryAt: 0,
      };
      this.entries.set(request.blobName, entry);
    } else if (
      entry.state.phase === "succeeded"
      && request.hasDerivative
      && !request.derivativeBroken
    ) {
      entry.request = request;
      this.update(entry, initialState());
    } else {
      entry.request = request;
    }

    const id = Symbol(request.blobName);
    entry.subscribers.set(id, { listener, visible: false });
    listener(entry.state);

    return {
      setVisible: (visible) => {
        const subscriber = entry!.subscribers.get(id);
        if (!subscriber || subscriber.visible === visible) return;
        subscriber.visible = visible;
        if (!visible) {
          this.abortIfUnobserved(entry!);
          return;
        }
        this.enqueue(entry!);
      },
      markDerivativeBroken: () => {
        entry!.request = { ...entry!.request, derivativeBroken: true };
        this.enqueue(entry!);
      },
      dispose: () => {
        entry!.subscribers.delete(id);
        this.abortIfUnobserved(entry!);
        if (
          entry!.subscribers.size === 0
          && entry!.state.phase !== "repairing"
          && entry!.state.phase !== "succeeded"
          && this.entries.get(entry!.request.blobName) === entry
        ) {
          this.entries.delete(entry!.request.blobName);
        }
      },
    };
  }

  reset(): void {
    for (const entry of this.entries.values()) {
      entry.controller?.abort(new DOMException("Repair session reset", "AbortError"));
    }
    this.entries.clear();
    this.sessionEstimatedBytes = 0;
  }

  networkChanged(): void {
    const networkPolicy = videoCoverRepairNetworkPolicy(this.network());
    if (!networkPolicy.enabled) {
      for (const entry of this.entries.values()) {
        entry.controller?.abort(new DOMException("Automatic repair paused", "AbortError"));
        if (this.hasVisibleSubscriber(entry) && entry.state.phase !== "succeeded") {
          this.update(entry, {
            ...entry.state,
            phase: "deferred",
            reason: networkPolicy.reason,
          });
        }
      }
      return;
    }
    for (const entry of this.entries.values()) {
      if (this.hasVisibleSubscriber(entry)) this.enqueue(entry);
    }
  }

  dependencyChanged(blobName: string): void {
    const entry = this.entries.get(blobName);
    if (entry && this.hasVisibleSubscriber(entry)) this.enqueue(entry);
  }

  externalSucceeded(blobName: string, thumbnailUrl: string): void {
    const entry = this.entries.get(blobName);
    if (!entry) return;
    this.update(entry, {
      ...entry.state,
      phase: "succeeded",
      thumbnailUrl,
      reason: null,
    });
  }

  private hasVisibleSubscriber(entry: QueueEntry): boolean {
    return [...entry.subscribers.values()].some((subscriber) => subscriber.visible);
  }

  private abortIfUnobserved(entry: QueueEntry): void {
    if (this.hasVisibleSubscriber(entry)) return;
    entry.controller?.abort(new DOMException("No visible repair subscriber", "AbortError"));
    if (entry.state.phase === "queued") {
      this.update(entry, { ...entry.state, phase: "idle", reason: null });
    }
  }

  private enqueue(entry: QueueEntry): void {
    if (!this.hasVisibleSubscriber(entry) || entry.state.phase === "succeeded") return;
    if (entry.state.phase === "repairing" || entry.state.phase === "queued") return;
    if (this.blocked(entry.request)) {
      this.update(entry, { ...entry.state, phase: "deferred", reason: "upload-pending" });
      return;
    }
    if (
      entry.state.attempts >= VIDEO_COVER_REPAIR_MAX_ATTEMPTS
      || (entry.state.phase === "failed" && this.now() < entry.nextRetryAt)
    ) {
      this.update(entry, { ...entry.state, phase: "failed", reason: "failed" });
      return;
    }
    const networkPolicy = videoCoverRepairNetworkPolicy(this.network());
    if (!networkPolicy.enabled) {
      this.update(entry, {
        ...entry.state,
        phase: "deferred",
        reason: networkPolicy.reason,
      });
      return;
    }
    const blockReason = autoRepairVideoCoverBlockReason(
      entry.request,
      this.sessionEstimatedBytes,
    );
    if (blockReason) {
      this.update(entry, {
        ...entry.state,
        phase: "deferred",
        reason: blockReason,
      });
      return;
    }
    this.update(entry, { ...entry.state, phase: "queued", reason: null });
    this.drain();
  }

  private drain(): void {
    const concurrency = videoCoverRepairNetworkPolicy(this.network()).concurrency;
    if (concurrency === 0) return;
    while (this.activeCount < concurrency) {
      const next = [...this.entries.values()].find(
        (entry) => entry.state.phase === "queued" && this.hasVisibleSubscriber(entry),
      );
      if (!next) return;
      this.start(next);
    }
  }

  private start(entry: QueueEntry): void {
    if (this.blocked(entry.request)) {
      this.update(entry, { ...entry.state, phase: "deferred", reason: "upload-pending" });
      return;
    }
    const blockReason = autoRepairVideoCoverBlockReason(
      entry.request,
      this.sessionEstimatedBytes,
    );
    if (blockReason) {
      this.update(entry, { ...entry.state, phase: "deferred", reason: blockReason });
      return;
    }
    this.sessionEstimatedBytes += entry.request.size;
    this.activeCount += 1;
    const controller = new AbortController();
    entry.controller = controller;
    this.update(entry, {
      phase: "repairing",
      thumbnailUrl: null,
      reason: null,
      attempts: entry.state.attempts + 1,
    });

    void this.execute(entry.request, controller.signal)
      .then((thumbnailUrl) => {
        if (controller.signal.aborted) return;
        if (thumbnailUrl) {
          this.update(entry, {
            ...entry.state,
            phase: "succeeded",
            thumbnailUrl,
            reason: null,
          });
          return;
        }
        this.fail(entry);
      })
      .catch(() => {
        if (!controller.signal.aborted) this.fail(entry);
      })
      .finally(() => {
        if (entry.controller === controller) entry.controller = null;
        this.activeCount = Math.max(0, this.activeCount - 1);
        if (controller.signal.aborted && entry.state.phase === "repairing") {
          const networkPolicy = videoCoverRepairNetworkPolicy(this.network());
          this.update(entry, {
            ...entry.state,
            phase: networkPolicy.enabled ? "idle" : "deferred",
            reason: networkPolicy.reason,
          });
        }
        if (
          entry.subscribers.size === 0
          && entry.state.phase !== "succeeded"
          && this.entries.get(entry.request.blobName) === entry
        ) {
          this.entries.delete(entry.request.blobName);
        }
        this.drain();
      });
  }

  private fail(entry: QueueEntry): void {
    entry.nextRetryAt = this.now() + VIDEO_COVER_REPAIR_RETRY_BACKOFF_MS;
    this.update(entry, { ...entry.state, phase: "failed", reason: "failed" });
  }

  private update(entry: QueueEntry, state: VideoCoverRepairState): void {
    entry.state = state;
    for (const subscriber of entry.subscribers.values()) subscriber.listener(state);
  }
}
