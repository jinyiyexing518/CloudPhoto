import { useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  /** Currently stored ISO datetime string, e.g. "2024-06-03T14:30:00" */
  currentIso?: string;
  saving: boolean;
  onSave: (isoNaive: string) => void;
  onClose: () => void;
}

/**
 * A portal-rendered dialog for editing a photo's taken-at time.
 * Renders two focused inputs (date + time) for a cleaner UX than datetime-local.
 */
export default function PhotoTimeEditDialog({ currentIso, saving, onSave, onClose }: Props) {
  const initial = currentIso ? currentIso.slice(0, 16) : "";
  const [dateVal, setDateVal] = useState(initial.slice(0, 10));
  const [timeVal, setTimeVal] = useState(initial.slice(11) || "12:00");

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const handleSave = () => {
    if (!dateVal) return;
    const iso = `${dateVal}T${timeVal || "00:00"}:00`;
    onSave(iso);
  };

  return createPortal(
    <div className="confirm-overlay" onClick={onClose}>
      <div className="time-edit-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="time-edit-header">
          <span className="time-edit-title">修改拍摄时间</span>
          <button type="button" className="time-edit-close" onClick={onClose} disabled={saving} aria-label="关闭拍摄时间编辑">✕</button>
        </div>

        <div className="time-edit-shortcuts">
          <button
            className="time-edit-chip"
            onClick={() => setDateVal(fmt(today))}
            disabled={saving}
          >今天</button>
          <button
            className="time-edit-chip"
            onClick={() => setDateVal(fmt(yesterday))}
            disabled={saving}
          >昨天</button>
        </div>

        <div className="time-edit-fields">
          <label className="time-edit-field">
            <span className="time-edit-label">日期</span>
            <input
              type="date"
              className="time-edit-input"
              value={dateVal}
              onChange={(e) => setDateVal(e.target.value)}
              disabled={saving}
              autoFocus
            />
          </label>
          <label className="time-edit-field">
            <span className="time-edit-label">时间</span>
            <input
              type="time"
              className="time-edit-input"
              value={timeVal}
              onChange={(e) => setTimeVal(e.target.value)}
              disabled={saving}
            />
          </label>
        </div>

        <div className="confirm-actions">
          <button className="confirm-cancel-btn" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            className="time-edit-save-btn"
            onClick={handleSave}
            disabled={!dateVal || saving}
          >
            {saving ? "保存中…" : "确认"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
