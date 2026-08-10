export type MaintenanceTaskKind = "thumbnails" | "metadata";
export type MaintenanceTaskPhase = "running" | "stopping" | "completed" | "stopped" | "failed";

export interface MaintenanceTaskState {
  operationId: string;
  kind: MaintenanceTaskKind;
  workspaceId: string;
  processed: number;
  changed: number;
  skipped: number;
  failed: number;
  hasMore: boolean;
  phase: MaintenanceTaskPhase;
  message?: string;
}

export type MaintenanceTaskEvent =
  | { type: "start"; operation: MaintenanceTaskState }
  | {
    type: "progress";
    operationId: string;
    processed: number;
    changed: number;
    skipped: number;
    failed: number;
    hasMore: boolean;
  }
  | { type: "complete"; operationId: string }
  | { type: "request-stop"; operationId: string; message: string }
  | { type: "stop"; operationId: string; message: string }
  | { type: "fail"; operationId: string; message: string }
  | { type: "clear"; operationId: string };

export interface MaintenanceTaskGate {
  current: {
    operationId: string;
    kind: MaintenanceTaskKind;
  } | null;
}

const LABELS: Record<MaintenanceTaskKind, string> = {
  thumbnails: "生成历史缩略图",
  metadata: "回填照片元数据",
};

export function createMaintenanceTask(
  operationId: string,
  kind: MaintenanceTaskKind,
  workspaceId: string,
): MaintenanceTaskState {
  return {
    operationId,
    kind,
    workspaceId,
    processed: 0,
    changed: 0,
    skipped: 0,
    failed: 0,
    hasMore: true,
    phase: "running",
  };
}

export function reduceMaintenanceTaskEvent(
  state: MaintenanceTaskState | null,
  event: MaintenanceTaskEvent,
): MaintenanceTaskState | null {
  if (event.type === "start") return { ...event.operation };
  if (!state || state.operationId !== event.operationId) return state;
  if (event.type === "clear") return null;
  if (event.type === "complete") {
    return { ...state, phase: "completed", hasMore: false, message: undefined };
  }
  if (event.type === "request-stop") {
    return { ...state, phase: "stopping", message: event.message };
  }
  if (event.type === "stop") {
    return { ...state, phase: "stopped", message: event.message };
  }
  if (event.type === "fail") {
    return { ...state, phase: "failed", message: event.message };
  }
  return {
    ...state,
    processed: event.processed,
    changed: event.changed,
    skipped: event.skipped,
    failed: event.failed,
    hasMore: event.hasMore,
  };
}

export function beginMaintenanceTask(
  gate: MaintenanceTaskGate,
  operationId: string,
  kind: MaintenanceTaskKind,
): boolean {
  if (gate.current) return false;
  gate.current = { operationId, kind };
  return true;
}

export function finishMaintenanceTask(gate: MaintenanceTaskGate, operationId: string): void {
  if (gate.current?.operationId === operationId) gate.current = null;
}

export function isMaintenanceTaskActive(state: MaintenanceTaskState | null): boolean {
  return state?.phase === "running" || state?.phase === "stopping";
}

export function maintenanceWorkspaceMatches(
  state: MaintenanceTaskState,
  workspaceId: string,
): boolean {
  return state.workspaceId === workspaceId;
}

export function getMaintenanceTaskLabel(kind: MaintenanceTaskKind): string {
  return LABELS[kind];
}

export function getMaintenanceBannerText(state: MaintenanceTaskState): string {
  const changedLabel = state.kind === "thumbnails" ? "生成" : "更新";
  const skipped = state.kind === "thumbnails" ? `，跳过 ${state.skipped} 张` : "";
  return `${LABELS[state.kind]}：已处理 ${state.processed} 张，${changedLabel} ${state.changed} 张${skipped}，失败 ${state.failed} 张`;
}

export function getMaintenanceGuardMessage(state: MaintenanceTaskState): string {
  const changedLabel = state.kind === "thumbnails" ? "生成" : "更新";
  return `${LABELS[state.kind]}进行中（已处理 ${state.processed} 张，${changedLabel} ${state.changed} 张，失败 ${state.failed} 张），请勿离开当前页面`;
}
