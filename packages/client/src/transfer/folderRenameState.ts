export type FolderRenamePhase = "requesting" | "reconciling";

export interface FolderRenameOperation {
  operationId: string;
  workspaceId: string;
  oldLabel: string;
  newLabel: string;
  phase: FolderRenamePhase;
}

export type FolderRenameEvent =
  | { type: "start"; operation: FolderRenameOperation }
  | { type: "phase"; operationId: string; phase: FolderRenamePhase }
  | { type: "finish"; operationId: string };

export interface FolderRenameGate {
  current: {
    operationId: string;
    workspaceId: string;
    controller: AbortController;
  } | null;
}

export type FolderRenameValidation =
  | {
      ok: true;
      oldFolder: string;
      newFolder: string;
      oldLabel: string;
      newLabel: string;
    }
  | { ok: false; error: string };

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export class FolderRenameWorkspaceChangedError extends DOMException {
  constructor() {
    super("工作空间已变更；客户端已停止等待，服务端可能仍在处理，正在重新对账。", "AbortError");
  }
}

export function createFolderRenameOperation(
  operationId: string,
  workspaceId: string,
  oldLabel: string,
  newLabel: string,
): FolderRenameOperation {
  return {
    operationId,
    workspaceId,
    oldLabel,
    newLabel,
    phase: "requesting",
  };
}

export function reduceFolderRenameEvent(
  state: FolderRenameOperation | null,
  event: FolderRenameEvent,
): FolderRenameOperation | null {
  if (event.type === "start") return { ...event.operation };
  if (!state || state.operationId !== event.operationId) return state;
  if (event.type === "finish") return null;
  return { ...state, phase: event.phase };
}

export function beginFolderRename(
  gate: FolderRenameGate,
  operation: FolderRenameOperation,
  controller: AbortController,
): boolean {
  if (gate.current) return false;
  gate.current = {
    operationId: operation.operationId,
    workspaceId: operation.workspaceId,
    controller,
  };
  return true;
}

export function finishFolderRename(gate: FolderRenameGate, operationId: string): void {
  if (gate.current?.operationId === operationId) gate.current = null;
}

export function abortFolderRenameForWorkspaceDrift(
  gate: FolderRenameGate,
  workspaceId: string,
): boolean {
  const active = gate.current;
  if (!active || active.workspaceId === workspaceId || active.controller.signal.aborted) {
    return false;
  }
  active.controller.abort(new FolderRenameWorkspaceChangedError());
  return true;
}

export function validateFolderRenameInput(
  oldFolder: string,
  newLabelInput: string,
  siblingLabels: readonly string[],
): FolderRenameValidation {
  const oldSegments = oldFolder.split("/");
  const oldLabel = oldSegments[oldSegments.length - 1] ?? "";
  const normalizedOldLabel = oldLabel.normalize("NFC");
  const newLabel = newLabelInput.trim().normalize("NFC");
  if (!newLabel) return { ok: false, error: "请输入新的文件夹名称" };
  if (
    newLabel === "."
    || newLabel === ".."
    || newLabel.includes("/")
    || newLabel.includes("\\")
    || CONTROL_CHARACTERS.test(newLabel)
  ) {
    return { ok: false, error: "文件夹名不能包含 /、\\、.、.. 或控制字符" };
  }
  if (newLabel === normalizedOldLabel) {
    return { ok: false, error: "新文件夹名与当前名称相同" };
  }
  if (siblingLabels.some((label) => label.normalize("NFC") === newLabel && label.normalize("NFC") !== normalizedOldLabel)) {
    return { ok: false, error: `同级文件夹「${newLabel}」已存在` };
  }

  return {
    ok: true,
    oldFolder: oldSegments.join("/"),
    newFolder: [...oldSegments.slice(0, -1), newLabel].join("/"),
    oldLabel,
    newLabel,
  };
}
