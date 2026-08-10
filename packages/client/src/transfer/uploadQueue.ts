export interface UploadFileLike {
  name: string;
  size: number;
  type: string;
}

export interface NetworkConnectionLike {
  effectiveType?: string;
  saveData?: boolean;
}

export interface UploadConcurrencyPolicy {
  budget: number;
}

export type UploadQueueStatus =
  | "pending"
  | "preparing"
  | "uploading"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface UploadQueueItem<TFile extends UploadFileLike = UploadFileLike> {
  id: string;
  file: TFile;
  weight: number;
  status: UploadQueueStatus;
  /** Highest logical byte position observed for this file across retry attempts. */
  loaded: number;
  /** Byte position reported by the current request attempt. */
  attemptLoaded: number;
  /** Actual bytes sent across all attempts; this can exceed file.size after retries. */
  transferredBytes: number;
  error?: unknown;
}

export interface UploadAggregateProgress {
  bytesLoaded: number;
  bytesTotal: number;
  transferredBytes: number;
  filesSettled: number;
  filesTotal: number;
  succeededCount: number;
  failedCount: number;
  cancelledCount: number;
  activeCount: number;
  queuedCount: number;
  activeFiles: string[];
}

export interface UploadSpeedState {
  ts: number;
  transferredBytes: number;
  emaBytesPerSecond: number;
}

export interface UploadSpeedSample extends UploadSpeedState {
  sampled: boolean;
}

interface UploadWorkerControls {
  markUploading: () => void;
  setLoaded: (loaded: number) => void;
}

interface RunWeightedUploadQueueOptions<TFile extends UploadFileLike> {
  files: readonly TFile[];
  policy: UploadConcurrencyPolicy;
  signal?: AbortSignal;
  isPaused?: () => boolean;
  waitForResume?: (signal?: AbortSignal) => Promise<void>;
  worker: (
    item: UploadQueueItem<TFile>,
    controls: UploadWorkerControls,
  ) => Promise<void>;
  onChange?: (items: readonly UploadQueueItem<TFile>[]) => void;
}

export interface UploadQueueResult<TFile extends UploadFileLike> {
  items: UploadQueueItem<TFile>[];
  succeeded: UploadQueueItem<TFile>[];
  failed: UploadQueueItem<TFile>[];
  cancelled: UploadQueueItem<TFile>[];
}

const LARGE_UPLOAD_BYTES = 20 * 1024 * 1024;

export function getUploadConcurrencyPolicy(
  connection?: NetworkConnectionLike,
): UploadConcurrencyPolicy {
  if (connection?.saveData) return { budget: 1 };
  const effectiveType = connection?.effectiveType?.toLowerCase();
  if (effectiveType === "slow-2g" || effectiveType === "2g") return { budget: 1 };
  if (effectiveType === "4g") return { budget: 3 };
  return { budget: 2 };
}

export function getUploadItemWeight(file: UploadFileLike): number {
  return file.type.startsWith("video/") || file.size > LARGE_UPLOAD_BYTES ? 2 : 1;
}

export function aggregateUploadProgress(
  items: readonly UploadQueueItem[],
): UploadAggregateProgress {
  let bytesLoaded = 0;
  let transferredBytes = 0;
  let filesSettled = 0;
  let succeededCount = 0;
  let failedCount = 0;
  let cancelledCount = 0;
  let activeCount = 0;
  let queuedCount = 0;
  const activeFiles: string[] = [];
  for (const item of items) {
    const observedBytes = Math.min(item.file.size, Math.max(0, item.loaded));
    transferredBytes += Math.max(0, item.transferredBytes);
    if (item.status === "succeeded") {
      bytesLoaded += item.file.size;
      filesSettled += 1;
      succeededCount += 1;
    } else if (item.status === "failed") {
      bytesLoaded += observedBytes;
      filesSettled += 1;
      failedCount += 1;
    } else if (item.status === "cancelled") {
      bytesLoaded += observedBytes;
      filesSettled += 1;
      cancelledCount += 1;
    } else if (item.status === "preparing" || item.status === "uploading") {
      bytesLoaded += observedBytes;
      activeCount += 1;
      activeFiles.push(item.file.name);
    } else if (item.status === "pending") {
      queuedCount += 1;
    }
  }
  return {
    bytesLoaded,
    bytesTotal: items.reduce((sum, item) => sum + item.file.size, 0),
    transferredBytes,
    filesSettled,
    filesTotal: items.length,
    succeededCount,
    failedCount,
    cancelledCount,
    activeCount,
    queuedCount,
    activeFiles,
  };
}

export function getUploadProgressPercent(
  progress: Pick<
    UploadAggregateProgress,
    "bytesLoaded" | "bytesTotal" | "filesTotal" | "succeededCount"
  >,
): number {
  const ratio = progress.bytesTotal > 0
    ? progress.bytesLoaded / progress.bytesTotal
    : progress.filesTotal > 0
      ? progress.succeededCount / progress.filesTotal
      : 0;
  const boundedRatio = Math.min(1, Math.max(0, ratio));
  return boundedRatio === 1 ? 100 : Math.min(99, Math.round(boundedRatio * 100));
}

export function formatUploadResultSummary(
  progress: Pick<
    UploadAggregateProgress,
    "succeededCount" | "failedCount" | "cancelledCount"
  >,
): string {
  const cancelled = progress.cancelledCount > 0
    ? `，取消 ${progress.cancelledCount}`
    : "";
  return `上传结束：成功 ${progress.succeededCount}，失败 ${progress.failedCount}${cancelled}`;
}

export function sampleUploadSpeed(
  previous: UploadSpeedState,
  transferredBytes: number,
  now: number,
  minimumIntervalMs = 500,
): UploadSpeedSample {
  const monotonicBytes = Math.max(
    previous.transferredBytes,
    Number.isFinite(transferredBytes) ? Math.max(0, transferredBytes) : previous.transferredBytes,
  );
  const elapsedMs = Math.max(0, now - previous.ts);
  if (elapsedMs < minimumIntervalMs) {
    return { ...previous, sampled: false };
  }

  const byteDelta = monotonicBytes - previous.transferredBytes;
  const rawBytesPerSecond = elapsedMs > 0 ? byteDelta / (elapsedMs / 1_000) : 0;
  const emaBytesPerSecond = byteDelta === 0
    ? 0
    : previous.emaBytesPerSecond === 0
      ? rawBytesPerSecond
      : previous.emaBytesPerSecond * 0.7 + rawBytesPerSecond * 0.3;
  return {
    ts: now,
    transferredBytes: monotonicBytes,
    emaBytesPerSecond,
    sampled: true,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function runWeightedUploadQueue<TFile extends UploadFileLike>({
  files,
  policy,
  signal,
  isPaused = () => false,
  waitForResume,
  worker,
  onChange,
}: RunWeightedUploadQueueOptions<TFile>): Promise<UploadQueueResult<TFile>> {
  const budget = Math.max(1, Math.floor(policy.budget));
  const items: UploadQueueItem<TFile>[] = files.map((file, index) => ({
    id: `${index}:${file.name}`,
    file,
    weight: getUploadItemWeight(file),
    status: "pending",
    loaded: 0,
    attemptLoaded: 0,
    transferredBytes: 0,
  }));
  let activeWeight = 0;
  let activeCount = 0;
  let resumePending = false;

  const snapshot = () => items.map((item) => ({ ...item }));
  const emit = () => onChange?.(snapshot());
  const result = () => ({
    items: snapshot(),
    succeeded: snapshot().filter((item) => item.status === "succeeded"),
    failed: snapshot().filter((item) => item.status === "failed"),
    cancelled: snapshot().filter((item) => item.status === "cancelled"),
  });

  return new Promise<UploadQueueResult<TFile>>((resolve) => {
    let resolved = false;
    const finishIfSettled = () => {
      if (resolved || activeCount > 0 || items.some((item) => item.status === "pending")) {
        return false;
      }
      resolved = true;
      signal?.removeEventListener("abort", handleAbort);
      resolve(result());
      return true;
    };
    const cancelPending = () => {
      let changed = false;
      for (const item of items) {
        if (item.status !== "pending") continue;
        item.status = "cancelled";
        changed = true;
      }
      if (changed) emit();
    };
    const handleAbort = () => {
      cancelPending();
      finishIfSettled();
    };
    const findDispatchable = () => items.find((item) => (
      item.status === "pending"
      && (
        activeWeight + item.weight <= budget
        || (activeCount === 0 && item.weight > budget)
      )
    ));
    const pump = () => {
      if (resolved) return;
      if (signal?.aborted) {
        handleAbort();
        return;
      }
      if (isPaused()) {
        if (activeCount === 0 && !resumePending && items.some((item) => item.status === "pending")) {
          resumePending = true;
          (waitForResume?.(signal) ?? Promise.resolve()).then(
            () => {
              resumePending = false;
              pump();
            },
            () => {
              resumePending = false;
              cancelPending();
              finishIfSettled();
            },
          );
        }
        finishIfSettled();
        return;
      }

      let next = findDispatchable();
      while (next) {
        const item = next;
        item.status = "preparing";
        activeWeight += item.weight;
        activeCount += 1;
        emit();
        const controls: UploadWorkerControls = {
          markUploading: () => {
            if (item.status !== "preparing" && item.status !== "uploading") return;
            item.status = "uploading";
            item.attemptLoaded = 0;
            emit();
          },
          setLoaded: (loaded) => {
            if (item.status !== "uploading") return;
            const nextAttemptLoaded = Math.min(item.file.size, Math.max(0, loaded));
            item.transferredBytes += nextAttemptLoaded >= item.attemptLoaded
              ? nextAttemptLoaded - item.attemptLoaded
              : nextAttemptLoaded;
            item.attemptLoaded = nextAttemptLoaded;
            item.loaded = Math.max(item.loaded, nextAttemptLoaded);
            emit();
          },
        };
        void worker(item, controls).then(
          () => {
            item.status = signal?.aborted ? "cancelled" : "succeeded";
            if (item.status === "succeeded") {
              item.transferredBytes += Math.max(0, item.file.size - item.attemptLoaded);
              item.attemptLoaded = item.file.size;
              item.loaded = item.file.size;
            }
          },
          (error: unknown) => {
            item.error = error;
            item.status = signal?.aborted || isAbortError(error) ? "cancelled" : "failed";
          },
        ).finally(() => {
          activeWeight -= item.weight;
          activeCount -= 1;
          emit();
          if (!finishIfSettled()) pump();
        });
        next = findDispatchable();
      }
      finishIfSettled();
    };

    signal?.addEventListener("abort", handleAbort, { once: true });
    emit();
    pump();
  });
}
