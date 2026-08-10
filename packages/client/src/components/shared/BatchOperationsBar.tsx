import { createPortal } from "react-dom";
import LocationSearchPanel from "./LocationSearchPanel";

export interface BatchOperationsBarProps {
  /** A batch mutation is running and conflicting controls must stay inert. */
  busy: boolean;

  /** Whether batch-select mode is active */
  selectMode: boolean;
  onToggleSelectMode: () => void;

  /** Currently-selected count + display size */
  selectedCount: number;
  selectedTotalSize?: string;

  /** Select-all toggle */
  allSelected: boolean;
  onToggleSelectAll: () => void;

  /** Rename */
  onBatchRename?: () => void;

  /** Time-edit panel */
  showBatchTimeEdit: boolean;
  onToggleBatchTimeEdit: () => void;
  batchTimeInput: string;
  onBatchTimeInputChange: (v: string) => void;
  onApplyBatchTime: () => void;
  onCancelBatchTime: () => void;

  /** GPS-edit panel */
  showBatchGpsEdit: boolean;
  onToggleBatchGpsEdit: () => void;
  onApplyBatchGps: (lat: string, lon: string) => void;
  onCancelBatchGpsEdit: () => void;

  /** Delete */
  showBatchConfirm: boolean;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;

  /**
   * Slot for view-specific extra toolbar actions.
   * Rendered after the common actions inside the toolbar row.
   * FolderView uses this for the "移动到…" dropdown + "添加原图" button.
   */
  extraToolbarActions?: React.ReactNode;

  /** Extra CSS class on the outer toolbar div */
  className?: string;
}

/**
 * Shared batch-operations bar used by both TimelineGallery (PhotoGallery)
 * and FolderView.  All state lives in the parent; this component is pure UI.
 */
export default function BatchOperationsBar({
  busy,
  selectMode,
  onToggleSelectMode,
  selectedCount,
  selectedTotalSize,
  allSelected,
  onToggleSelectAll,
  onBatchRename,
  showBatchTimeEdit,
  onToggleBatchTimeEdit,
  batchTimeInput,
  onBatchTimeInputChange,
  onApplyBatchTime,
  onCancelBatchTime,
  showBatchGpsEdit,
  onToggleBatchGpsEdit,
  onApplyBatchGps,
  onCancelBatchGpsEdit,
  showBatchConfirm,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  extraToolbarActions,
  className,
}: BatchOperationsBarProps) {
  return (
    <>
      {/* ── Toolbar row ── */}
      <div
        className={`gallery-batch-toolbar${className ? ` ${className}` : ""}`}
        aria-busy={busy}
      >
        <button
          className={`batch-select-btn${selectMode ? " active" : ""}`}
          onClick={onToggleSelectMode}
          disabled={busy}
        >
          {selectMode ? "取消选择" : "批量选择"}
        </button>

        {selectMode && (
          <button className="batch-select-btn" onClick={onToggleSelectAll} disabled={busy}>
            {allSelected ? "取消全选" : "全选"}
          </button>
        )}

        {selectMode && (
          <span className="batch-count">
            {busy ? "批量操作进行中…" : `已选 ${selectedCount} 张${selectedTotalSize ? ` · ${selectedTotalSize}` : ""}`}
          </span>
        )}

        {selectMode && selectedCount > 0 && (
          <>
            {onBatchRename && (
              <button className="batch-select-btn" onClick={onBatchRename} disabled={busy}>
                重命名 ({selectedCount})
              </button>
            )}
            <button
              className={`batch-select-btn${showBatchTimeEdit ? " active" : ""}`}
              onClick={onToggleBatchTimeEdit}
              disabled={busy}
            >
              修改时间 ({selectedCount})
            </button>
            <button
              className={`batch-select-btn${showBatchGpsEdit ? " active" : ""}`}
              onClick={onToggleBatchGpsEdit}
              disabled={busy}
            >
              修改位置 ({selectedCount})
            </button>
            <button className="batch-delete-btn" onClick={onRequestDelete} disabled={busy}>
              删除 ({selectedCount})
            </button>
          </>
        )}

        {/* View-specific slot (e.g. move-to dropdown + upload button in FolderView) */}
        {extraToolbarActions}
      </div>

      {/* ── Time-edit expandable ── */}
      {selectMode && showBatchTimeEdit && (
        <div className="batch-edit-form">
          <span className="batch-edit-label">统一拍摄时间</span>
          <input
            type="datetime-local"
            className="batch-edit-input"
            value={batchTimeInput}
            onChange={(e) => onBatchTimeInputChange(e.target.value)}
            disabled={busy}
          />
          <button
            className="batch-select-btn"
            onClick={onApplyBatchTime}
            disabled={busy || !batchTimeInput}
          >
            应用
          </button>
          <button className="batch-select-btn" onClick={onCancelBatchTime} disabled={busy}>
            取消
          </button>
        </div>
      )}

      {/* ── GPS-edit expandable ── */}
      {selectMode && showBatchGpsEdit && (
        <div className="batch-edit-form batch-edit-form--gps">
          <span className="batch-edit-label">统一位置（搜索地名）</span>
          <LocationSearchPanel
            saving={busy}
            onSelect={(lat, lon) => onApplyBatchGps(lat, lon)}
            onClose={onCancelBatchGpsEdit}
          />
        </div>
      )}

      {/* ── Delete confirmation dialog (portal) ── */}
      {showBatchConfirm &&
        createPortal(
          <div className="confirm-overlay" onClick={onCancelDelete}>
            <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
              <p className="confirm-title">确认删除 {selectedCount} 张照片？</p>
              <p className="confirm-filename">此操作不可撤销</p>
              <div className="confirm-actions">
                <button className="confirm-cancel-btn" onClick={onCancelDelete} disabled={busy}>
                  取消
                </button>
                <button className="confirm-delete-btn" onClick={onConfirmDelete} disabled={busy}>
                  删除
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
