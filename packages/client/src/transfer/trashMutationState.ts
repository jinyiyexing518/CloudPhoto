export const TRASH_MUTATION_KINDS = [
  "item-restore",
  "item-delete",
  "restore-all",
  "empty-trash",
  "restore-folder",
  "delete-folder",
] as const;

export type TrashMutationKind = typeof TRASH_MUTATION_KINDS[number];
export type TrashMutationPhase = "running" | "stopping" | "stopped" | "completed";

export interface TrashMutationState {
  operationId: string;
  token: string;
  kind: TrashMutationKind;
  workspaceId: string;
  label: string;
  done: number;
  total: number;
  failed: number;
  phase: TrashMutationPhase;
  message?: string;
}

export type TrashMutationEvent =
  | { type: "start"; operation: TrashMutationState }
  | { type: "progress"; token: string; done: number; failed: number }
  | { type: "request-stop"; token: string; message: string }
  | { type: "stop"; token: string; done: number; failed: number; message: string }
  | { type: "complete"; token: string; message?: string }
  | { type: "clear"; token: string };

export interface TrashMutationGate {
  current: {
    operationId: string;
    token: string;
    kind: TrashMutationKind;
  } | null;
}

export interface TrashMutationResult {
  done: number;
  total: number;
  failed: number;
  stopped: boolean;
}

interface TrashMutationFinalization {
  message?: string;
}

interface RunTrashMutationOptions<T> {
  gate: TrashMutationGate;
  operation: TrashMutationState;
  items: readonly T[];
  signal?: AbortSignal;
  worker: (item: T, index: number, signal: AbortSignal) => Promise<void>;
  onEvent?: (event: TrashMutationEvent) => void;
  onAcquired?: () => void;
  beforeFinish?: (result: TrashMutationResult) => Promise<TrashMutationFinalization | void>;
}

const LABELS: Record<TrashMutationKind, string> = {
  "item-restore": "恢复照片",
  "item-delete": "彻底删除照片",
  "restore-all": "全部恢复",
  "empty-trash": "清空回收站",
  "restore-folder": "恢复文件夹",
  "delete-folder": "彻底删除文件夹",
};

export function createTrashMutation(
  operationId: string,
  kind: TrashMutationKind,
  workspaceId: string,
  total: number,
  label = LABELS[kind],
): TrashMutationState {
  return {
    operationId,
    token: operationId,
    kind,
    workspaceId,
    label,
    done: 0,
    total,
    failed: 0,
    phase: "running",
  };
}

export function reduceTrashMutationEvent(
  state: TrashMutationState | null,
  event: TrashMutationEvent,
): TrashMutationState | null {
  if (event.type === "start") return { ...event.operation };
  if (!state || state.token !== event.token) return state;
  if (event.type === "clear") return null;
  if (event.type === "request-stop") {
    return { ...state, phase: "stopping", message: event.message };
  }
  if (event.type === "stop") {
    return {
      ...state,
      done: event.done,
      failed: event.failed,
      phase: "stopped",
      message: event.message,
    };
  }
  if (event.type === "complete") {
    return { ...state, phase: "completed", message: event.message };
  }
  return { ...state, done: event.done, failed: event.failed };
}

export function beginTrashMutation(
  gate: TrashMutationGate,
  operation: TrashMutationState,
): boolean {
  if (gate.current) return false;
  gate.current = {
    operationId: operation.operationId,
    token: operation.token,
    kind: operation.kind,
  };
  return true;
}

export function finishTrashMutation(gate: TrashMutationGate, token: string): void {
  if (gate.current?.token === token) gate.current = null;
}

export function isTrashMutationActive(state: TrashMutationState | null): boolean {
  return state?.phase === "running" || state?.phase === "stopping";
}

export function trashMutationWorkspaceMatches(
  state: TrashMutationState,
  workspaceId: string,
): boolean {
  return state.workspaceId === workspaceId;
}

export function getTrashMutationPercent(state: TrashMutationState): number {
  if (state.total === 0) return 100;
  return Math.round((state.done / state.total) * 100);
}

export function getTrashMutationGuardMessage(state: TrashMutationState): string {
  const failed = state.failed > 0 ? `，失败 ${state.failed} 张` : "";
  return `${state.label}进行中（${state.done}/${state.total}${failed}），请先停止任务再离开`;
}

export function getTrashMutationBannerText(state: TrashMutationState): string {
  const phase = state.phase === "stopping"
    ? "正在停止"
    : state.phase === "stopped"
      ? "已停止"
      : state.phase === "completed"
        ? "已完成"
        : "进行中";
  const failed = state.failed > 0 ? `，失败 ${state.failed} 张` : "";
  return `${state.label}${phase}：${state.done}/${state.total}${failed}`;
}

function abortMessage(signal: AbortSignal): string {
  const reason = signal.reason;
  if (reason instanceof Error && reason.message) return reason.message;
  return "任务已停止，已完成操作不会回滚。";
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

export async function runTrashMutationBoundary<T>({
  gate,
  operation,
  items,
  signal,
  worker,
  onEvent,
  onAcquired,
  beforeFinish,
}: RunTrashMutationOptions<T>): Promise<TrashMutationResult | null> {
  if (operation.total !== items.length) {
    throw new Error(`Trash mutation total ${operation.total} does not match ${items.length} items`);
  }
  if (!beginTrashMutation(gate, operation)) return null;
  onAcquired?.();

  const snapshot = [...items];
  const fallbackController = signal ? null : new AbortController();
  const operationSignal = signal ?? fallbackController!.signal;
  let done = 0;
  let failed = 0;
  let stopped = false;

  try {
    onEvent?.({ type: "start", operation: { ...operation } });
    for (let index = 0; index < snapshot.length; index += 1) {
      if (operationSignal.aborted) {
        stopped = true;
        break;
      }
      try {
        await worker(snapshot[index], index, operationSignal);
      } catch (error) {
        if (isAbortError(error, operationSignal)) {
          stopped = true;
          break;
        }
        failed += 1;
      }
      done += 1;
      onEvent?.({ type: "progress", token: operation.token, done, failed });
    }

    stopped = stopped || operationSignal.aborted;
    if (stopped) {
      onEvent?.({
        type: "request-stop",
        token: operation.token,
        message: abortMessage(operationSignal),
      });
    }
    let result: TrashMutationResult = { done, total: snapshot.length, failed, stopped };
    const finalization = await beforeFinish?.(result);
    if (!result.stopped && operationSignal.aborted) {
      result = { ...result, stopped: true };
    }

    if (result.stopped) {
      onEvent?.({
        type: "stop",
        token: operation.token,
        done,
        failed,
        message: finalization?.message ?? abortMessage(operationSignal),
      });
    } else {
      onEvent?.({ type: "complete", token: operation.token, message: finalization?.message });
    }
    return result;
  } finally {
    finishTrashMutation(gate, operation.token);
  }
}
