export interface MaintenanceBackfillPage {
  processed: number;
  changed: number;
  skipped: number;
  indexReconciled: number;
  failed: number;
  hasMore: boolean;
  cursor?: string;
}

export interface MaintenanceBackfillProgress {
  processed: number;
  changed: number;
  skipped: number;
  indexReconciled: number;
  failed: number;
  hasMore: boolean;
}

export type MaintenanceBackfillTotals = Omit<MaintenanceBackfillProgress, "hasMore">;

interface RunMaintenanceBackfillPagesOptions {
  requestPage: (cursor: string, signal?: AbortSignal) => Promise<unknown>;
  signal?: AbortSignal;
  onProgress?: (progress: MaintenanceBackfillProgress) => void;
  paginationError: string;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("任务已停止", "AbortError");
}

function requireCounter(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`维护任务返回了无效的 ${field}`);
  }
  return value;
}

function parsePage(value: unknown): MaintenanceBackfillPage {
  if (!value || typeof value !== "object") throw new Error("维护任务返回了无效结果");
  const page = value as Record<string, unknown>;
  if (typeof page.hasMore !== "boolean") throw new Error("维护任务返回了无效的 hasMore");
  if (page.cursor !== undefined && typeof page.cursor !== "string") {
    throw new Error("维护任务返回了无效的 cursor");
  }
  return {
    processed: requireCounter(page.processed, "processed"),
    changed: requireCounter(page.changed, "changed"),
    skipped: requireCounter(page.skipped, "skipped"),
    indexReconciled: page.indexReconciled === undefined
      ? 0
      : requireCounter(page.indexReconciled, "indexReconciled"),
    failed: requireCounter(page.failed, "failed"),
    hasMore: page.hasMore,
    cursor: page.cursor,
  };
}

export async function runMaintenanceBackfillPages({
  requestPage,
  signal,
  onProgress,
  paginationError,
}: RunMaintenanceBackfillPagesOptions): Promise<MaintenanceBackfillTotals> {
  const totals: MaintenanceBackfillTotals = {
    processed: 0,
    changed: 0,
    skipped: 0,
    indexReconciled: 0,
    failed: 0,
  };
  let cursor = "";

  while (true) {
    throwIfAborted(signal);
    const page = parsePage(await requestPage(cursor, signal));
    totals.processed += page.processed;
    totals.changed += page.changed;
    totals.skipped += page.skipped;
    totals.indexReconciled += page.indexReconciled;
    totals.failed += page.failed;
    onProgress?.({ ...totals, hasMore: page.hasMore });
    if (!page.hasMore) return totals;
    throwIfAborted(signal);
    if (!page.cursor || page.cursor === cursor) throw new Error(paginationError);
    cursor = page.cursor;
  }
}
