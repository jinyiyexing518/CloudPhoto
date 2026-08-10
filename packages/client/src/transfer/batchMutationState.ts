export const BATCH_MUTATION_SOURCES = ["timeline", "moments", "folder"] as const;

export type BatchMutationSource = typeof BATCH_MUTATION_SOURCES[number];
export type BatchMutationKind = "rename" | "time" | "location" | "move";

export interface BatchMutationOperation {
  id: string;
  kind: BatchMutationKind;
  done: number;
  total: number;
  failed: number;
}

export type BatchMutationStates = Record<BatchMutationSource, BatchMutationOperation | null>;

export type BatchMutationEvent =
  | { type: "start"; operation: BatchMutationOperation }
  | { type: "progress"; operationId: string; done: number; failed: number }
  | { type: "finish"; operationId: string };

export interface BatchMutationGate {
  current: string | null;
}

export interface BatchMutationResult {
  done: number;
  total: number;
  failed: number;
}

interface RunBatchMutationOptions<T> {
  gate: BatchMutationGate;
  operation: BatchMutationOperation;
  items: readonly T[];
  worker: (item: T, index: number) => Promise<boolean | void>;
  concurrency?: number;
  onEvent?: (event: BatchMutationEvent) => void;
}

const BATCH_MUTATION_LABELS: Record<BatchMutationKind, string> = {
  rename: "批量重命名",
  time: "批量修改时间",
  location: "批量修改位置",
  move: "批量移动",
};

export function createInitialBatchMutationStates(): BatchMutationStates {
  return {
    timeline: null,
    moments: null,
    folder: null,
  };
}

export function reduceBatchMutationEvent(
  states: BatchMutationStates,
  source: BatchMutationSource,
  event: BatchMutationEvent,
): BatchMutationStates {
  if (event.type === "start") {
    return {
      ...states,
      [source]: { ...event.operation },
    };
  }

  const current = states[source];
  if (!current || current.id !== event.operationId) return states;

  if (event.type === "finish") {
    return {
      ...states,
      [source]: null,
    };
  }

  if (current.done === event.done && current.failed === event.failed) return states;
  return {
    ...states,
    [source]: {
      ...current,
      done: event.done,
      failed: event.failed,
    },
  };
}

export function getActiveBatchMutation(states: BatchMutationStates): BatchMutationOperation | null {
  for (const source of BATCH_MUTATION_SOURCES) {
    const operation = states[source];
    if (operation) return operation;
  }
  return null;
}

export function getBatchMutationPercent(operation: BatchMutationOperation): number {
  if (operation.total === 0) return 100;
  return Math.round((operation.done / operation.total) * 100);
}

export function getBatchMutationLabel(kind: BatchMutationKind): string {
  return BATCH_MUTATION_LABELS[kind];
}

export async function runBatchMutationBoundary<T>({
  gate,
  operation,
  items,
  worker,
  concurrency = 1,
  onEvent,
}: RunBatchMutationOptions<T>): Promise<BatchMutationResult | null> {
  if (gate.current !== null) return null;
  if (operation.total !== items.length) {
    throw new Error(`Batch mutation total ${operation.total} does not match ${items.length} items`);
  }

  gate.current = operation.id;
  let nextIndex = 0;
  let done = 0;
  let failed = 0;

  try {
    onEvent?.({ type: "start", operation: { ...operation } });
    const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
    const runWorker = async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          const result = await worker(items[index], index);
          if (result === false) failed += 1;
        } catch {
          failed += 1;
        }
        done += 1;
        onEvent?.({
          type: "progress",
          operationId: operation.id,
          done,
          failed,
        });
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return { done, total: items.length, failed };
  } finally {
    if (gate.current === operation.id) {
      gate.current = null;
    }
    onEvent?.({ type: "finish", operationId: operation.id });
  }
}
