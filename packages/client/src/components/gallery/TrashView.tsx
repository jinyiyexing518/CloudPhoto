import { useCallback, useEffect, useRef, useState } from "react";
import { Photo, listTrashPhotos, restorePhoto, permanentlyDeletePhoto } from "../../services/photoApi";
import MediaThumb from "../shared/MediaThumb";
import { useToast } from "../../contexts/ToastContext";
import { useAuth } from "../../contexts/AuthContext";
import { formatPhotoDate } from "../../utils/dateFormat";
import {
  createTrashMutation,
  getTrashMutationBannerText,
  getTrashMutationPercent,
  isTrashMutationActive,
  reduceTrashMutationEvent,
  runTrashMutationBoundary,
  trashMutationWorkspaceMatches,
  type TrashMutationEvent,
  type TrashMutationGate,
  type TrashMutationKind,
  type TrashMutationResult,
  type TrashMutationState,
} from "../../transfer/trashMutationState";

interface Props {
  groupId: string;
  onRestored?: () => void;
  onMutationStateChange?: (event: TrashMutationEvent) => void;
  blocked?: boolean;
}

interface ReconciledTrashMutationResult extends TrashMutationResult {
  reconciled: boolean;
}

function operationId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function stopReason(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

export default function TrashView({ groupId, onRestored, onMutationStateChange, blocked = false }: Props) {
  const { user } = useAuth();
  const showToast = useToast();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [trashMutation, setTrashMutation] = useState<TrashMutationState | null>(null);
  const mutationRef = useRef<TrashMutationState | null>(null);
  const mutationGateRef = useRef<TrashMutationGate>({ current: null });
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const groupIdRef = useRef(groupId);
  const onMutationStateChangeRef = useRef(onMutationStateChange);
  const onRestoredRef = useRef(onRestored);
  groupIdRef.current = groupId;
  onMutationStateChangeRef.current = onMutationStateChange;
  onRestoredRef.current = onRestored;
  const mutationActive = blocked || isTrashMutationActive(trashMutation);

  const applyMutationEvent = useCallback((event: TrashMutationEvent) => {
    const next = reduceTrashMutationEvent(mutationRef.current, event);
    mutationRef.current = next;
    if (mountedRef.current) setTrashMutation(next);
    onMutationStateChangeRef.current?.(event);
  }, []);

  const loadWorkspace = useCallback(async (
    workspaceId: string,
    token?: string,
    reportFailure = true,
  ): Promise<boolean> => {
    if (mountedRef.current) setLoading(true);
    try {
      const list = await listTrashPhotos(workspaceId);
      const tokenIsCurrent = !token || mutationRef.current?.token === token;
      if (mountedRef.current && groupIdRef.current === workspaceId && tokenIsCurrent) {
        setPhotos(list);
      }
      return true;
    } catch {
      if (reportFailure && mountedRef.current && groupIdRef.current === workspaceId) {
        showToast("加载回收站失败", "error");
      }
      return false;
    } finally {
      if (mountedRef.current && groupIdRef.current === workspaceId) setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadWorkspace(groupId);
  }, [groupId, loadWorkspace]);

  const runMutation = async (
    kind: TrashMutationKind,
    items: readonly Photo[],
    worker: (photo: Photo, signal: AbortSignal) => Promise<void>,
    label?: string,
  ): Promise<ReconciledTrashMutationResult | null> => {
    if (blocked) {
      showToast("维护任务运行中，请先停止维护任务", "info");
      return null;
    }
    const workspaceId = groupIdRef.current;
    const snapshot = [...items];
    const operation = createTrashMutation(operationId(), kind, workspaceId, snapshot.length, label);
    const controller = new AbortController();
    let reconciled = false;

    const result = await runTrashMutationBoundary({
      gate: mutationGateRef.current,
      operation,
      items: snapshot,
      signal: controller.signal,
      onEvent: applyMutationEvent,
      onAcquired: () => {
        controllerRef.current = controller;
      },
      beforeFinish: async () => {
        reconciled = await loadWorkspace(workspaceId, operation.token, false);
        if (reconciled) {
          return { message: "远端状态已重新对账；已完成操作不会回滚。" };
        }
        return {
          message: "远端对账失败，请刷新后重试；已完成操作不会回滚。",
        };
      },
      worker: async (photo, _index, signal) => {
        if (groupIdRef.current !== workspaceId) {
          controller.abort(stopReason("工作空间已变更，回收站任务已停止。"));
          signal.throwIfAborted();
        }
        await worker(photo, signal);
      },
    });

    if (controllerRef.current === controller) controllerRef.current = null;
    if (!result) return null;
    return { ...result, reconciled };
  };

  const reportResult = (
    result: ReconciledTrashMutationResult | null,
    successMessage: string,
    failureAction: string,
    restored = false,
  ) => {
    if (!result || !mountedRef.current) return;
    if (!result.reconciled) {
      showToast("操作已停止或完成，但远端对账失败，请刷新后重试", "error");
    } else if (result.stopped) {
      showToast("任务已停止，已重新加载远端回收站；已完成操作不会回滚", "info");
    } else if (result.failed > 0) {
      showToast(`${result.failed} 张${failureAction}失败`, "error");
    } else {
      showToast(successMessage, "success");
    }
    if (restored && (result.stopped || result.done > result.failed)) onRestoredRef.current?.();
  };

  const handleRestore = async (photo: Photo) => {
    const result = await runMutation(
      "item-restore",
      [photo],
      (item, signal) => restorePhoto(item.name, signal),
    );
    reportResult(result, "照片已恢复", "恢复", true);
  };

  const handlePermanentDelete = async (photo: Photo, displayName: string) => {
    if (!confirm(`「${displayName}」将被彻底删除，无法恢复。确认删除？`)) return;
    const result = await runMutation(
      "item-delete",
      [photo],
      (item, signal) => permanentlyDeletePhoto(item.name, signal),
    );
    reportResult(result, "已彻底删除", "删除");
  };

  const handleEmptyTrash = async () => {
    if (!confirm(`回收站中 ${photos.length} 张照片将被彻底删除，无法恢复。确认清空？`)) return;
    const snapshot = [...photos];
    const result = await runMutation(
      "empty-trash",
      snapshot,
      (photo, signal) => permanentlyDeletePhoto(photo.name, signal),
    );
    reportResult(result, "回收站已清空", "删除");
  };

  const handleRestoreAll = async () => {
    if (!confirm(`将恢复回收站中全部 ${photos.length} 张照片，确认？`)) return;
    const snapshot = [...photos];
    const result = await runMutation(
      "restore-all",
      snapshot,
      (photo, signal) => restorePhoto(photo.name, signal),
    );
    reportResult(result, `已全部恢复 ${snapshot.length} 张照片`, "恢复", true);
  };

  const grouped = new Map<string, Photo[]>();
  for (const photo of photos) {
    const key = photo.folder?.trim() ?? "";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(photo);
  }

  const handleRestoreFolder = async (folderKey: string) => {
    const folderPhotos = grouped.get(folderKey) ?? [];
    const snapshot = [...folderPhotos];
    const displayName = folderKey || "（未分类）";
    if (!confirm(`恢复文件夹「${displayName}」的 ${snapshot.length} 张照片？`)) return;
    const result = await runMutation(
      "restore-folder",
      snapshot,
      (photo, signal) => restorePhoto(photo.name, signal),
      `恢复文件夹「${displayName}」`,
    );
    reportResult(result, `文件夹「${displayName}」已恢复`, "恢复", true);
  };

  const handleDeleteFolder = async (folderKey: string) => {
    const folderPhotos = grouped.get(folderKey) ?? [];
    const snapshot = [...folderPhotos];
    const displayName = folderKey || "（未分类）";
    if (!confirm(`彻底删除文件夹「${displayName}」的 ${snapshot.length} 张照片？此操作不可撤销。`)) return;
    const result = await runMutation(
      "delete-folder",
      snapshot,
      (photo, signal) => permanentlyDeletePhoto(photo.name, signal),
      `彻底删除文件夹「${displayName}」`,
    );
    reportResult(result, `文件夹「${displayName}」已彻底删除`, "删除");
  };

  const stopMutation = () => {
    const current = mutationRef.current;
    const controller = controllerRef.current;
    if (!current || !isTrashMutationActive(current) || !controller || controller.signal.aborted) return;
    applyMutationEvent({
      type: "request-stop",
      token: current.token,
      message: "正在停止任务，已完成操作不会回滚。",
    });
    controller.abort(stopReason("任务已停止，远端状态将重新对账。"));
  };

  useEffect(() => {
    const current = mutationRef.current;
    if (!current || !isTrashMutationActive(current) || trashMutationWorkspaceMatches(current, groupId)) return;
    const message = "工作空间已变更，回收站任务已停止。";
    applyMutationEvent({ type: "request-stop", token: current.token, message });
    controllerRef.current?.abort(stopReason(message));
    showToast(message, "error");
  }, [applyMutationEvent, groupId, showToast]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const current = mutationRef.current;
      if (current && isTrashMutationActive(current)) {
        controllerRef.current?.abort(stopReason("回收站已卸载，任务已停止。"));
        onMutationStateChangeRef.current?.({
          type: "stop",
          token: current.token,
          done: current.done,
          failed: current.failed,
          message: "回收站已卸载，任务已停止。",
        });
      }
    };
  }, []);

  const folderGroups = Array.from(grouped.entries()).sort(([a], [b]) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b, "zh-CN");
  });

  if (loading && photos.length === 0) {
    return (
      <div className="loading">
        <div className="loading-spinner" />
        <span>加载中…</span>
      </div>
    );
  }

  if (photos.length === 0 && !trashMutation) {
    return (
      <div className="trash-empty-state">
        <div className="trash-empty-icon">🗑️</div>
        <div className="trash-empty-title">回收站为空</div>
        <div className="trash-empty-sub">删除的照片会在这里保留，随时可以恢复</div>
      </div>
    );
  }

  return (
    <div className="trash-view">
      <div className="trash-toolbar">
        <span className="trash-toolbar-count">{photos.length} 张照片</span>
        <div className="trash-toolbar-actions">
          <button className="trash-restore-all-btn" onClick={() => void handleRestoreAll()} disabled={mutationActive}>
            全部恢复
          </button>
          <button className="trash-empty-all-btn" onClick={() => void handleEmptyTrash()} disabled={mutationActive}>
            清空回收站
          </button>
        </div>
      </div>

      {trashMutation && (
        <div className="trash-empty-progress" role="status" aria-live="polite">
          <div className="transfer-banner-row">
            <span className="transfer-banner-icon">🗑️</span>
            <div className="transfer-banner-body">
              <span className="transfer-banner-text">{getTrashMutationBannerText(trashMutation)}</span>
              {trashMutation.message && <span className="transfer-banner-size">{trashMutation.message}</span>}
            </div>
            {mutationActive && (
              <button
                type="button"
                className="maintenance-stop-btn"
                onClick={stopMutation}
                disabled={trashMutation?.phase === "stopping"}
              >
                {trashMutation.phase === "stopping" ? "正在停止…" : "停止任务"}
              </button>
            )}
            <span className="transfer-banner-pct">{getTrashMutationPercent(trashMutation)}%</span>
          </div>
          <div className="transfer-banner-track">
            <div
              className="transfer-banner-fill"
              style={{ width: `${getTrashMutationPercent(trashMutation)}%` }}
            />
          </div>
        </div>
      )}

      <div className="trash-groups">
        {folderGroups.map(([folderKey, folderPhotos]) => {
          const folderLabel = folderKey || "（未分类）";
          return (
            <div key={folderKey} className="trash-folder-group">
              <div className="trash-folder-header">
                <span className="trash-folder-name">📁 {folderLabel}</span>
                <span className="trash-folder-count">{folderPhotos.length} 张</span>
                <div className="trash-folder-actions">
                  <button
                    className="trash-folder-restore-btn"
                    onClick={() => void handleRestoreFolder(folderKey)}
                    disabled={mutationActive}
                  >
                    恢复文件夹
                  </button>
                  <button
                    className="trash-folder-delete-btn"
                    onClick={() => void handleDeleteFolder(folderKey)}
                    disabled={mutationActive}
                  >
                    彻底删除
                  </button>
                </div>
              </div>
              <div className="trash-grid">
                {folderPhotos.map((photo) => {
                  const displayName = photo.originalName || photo.name.split("/").pop() || photo.name;
                  const deletedDate = photo.deletedAt
                    ? formatPhotoDate(photo.deletedAt)
                    : "未知";
                  const deletedBy = photo.deletedByName
                    ? photo.deletedBy === user?.id
                      ? `${photo.deletedByName}（我）`
                      : photo.deletedByName
                    : photo.deletedBy
                      ? photo.deletedBy === user?.id
                        ? `${user?.displayName ?? "我"}（我）`
                        : photo.deletedBy
                      : "未知用户";
                  return (
                    <div key={photo.name} className="trash-card">
                      <div className="trash-card-thumb">
                        <MediaThumb
                          blobName={photo.name}
                          url={photo.url}
                          thumbnailUrl={photo.thumbnailUrl}
                          previewUrl={photo.previewUrl}
                          alt={displayName}
                          contentType={photo.contentType}
                          loading="lazy"
                        />
                      </div>
                      <div className="trash-card-body">
                        <div className="trash-card-name" title={displayName}>{displayName}</div>
                        <div className="trash-card-meta">
                          <span>🗑 {deletedDate}</span>
                          <span>👤 删除人：{deletedBy}</span>
                        </div>
                      </div>
                      <div className="trash-card-actions">
                        <button
                          className="trash-restore-btn"
                          onClick={() => void handleRestore(photo)}
                          disabled={mutationActive}
                          title="恢复到原位置"
                        >
                          恢复
                        </button>
                        <button
                          className="trash-delete-btn"
                          onClick={() => void handlePermanentDelete(photo, displayName)}
                          disabled={mutationActive}
                          title="彻底删除，不可恢复"
                        >
                          彻底删除
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="trash-sticky-actions">
        <button className="trash-restore-all-btn" onClick={() => void handleRestoreAll()} disabled={mutationActive}>
          全部恢复
        </button>
        <button className="trash-empty-all-btn" onClick={() => void handleEmptyTrash()} disabled={mutationActive}>
          清空回收站
        </button>
      </div>
    </div>
  );
}
