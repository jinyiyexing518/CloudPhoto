import { useRef, useState, FormEvent } from "react";
import { createGroupApi } from "../../services/groupApi";
import { useModalFocusBoundary } from "../shared/useModalFocusBoundary";

interface Props {
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}

export default function CreateGroupDialog({ onClose, onCreated }: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (loading) return;
    if (!name.trim()) { setError("请输入群组名称"); return; }
    setLoading(true);
    setError("");
    try {
      await createGroupApi({ name: name.trim(), description: description.trim() || undefined });
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setLoading(false);
    }
  };

  const requestClose = () => {
    if (loading) return;
    onClose();
  };

  useModalFocusBoundary({
    active: true,
    layerRef,
    containerRef: dialogRef,
    initialFocusRef: nameInputRef,
    onEscape: () => {
      if (loading) return false;
      onClose();
      return true;
    },
  });

  return (
    <div ref={layerRef} className="dialog-overlay" data-modal-layer onClick={requestClose}>
      <div
        ref={dialogRef}
        className="add-admin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-group-dialog-title"
        aria-busy={loading}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="add-admin-header">
          <span id="create-group-dialog-title">新建群组</span>
          <button type="button" className="dialog-close-btn" onClick={requestClose} disabled={loading} aria-label="关闭新建群组">✕</button>
        </div>

        {error && <div className="auth-error" role="alert">{error}</div>}

        <form className="add-admin-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label>群组名称 <span className="required">*</span></label>
            <input
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：家庭相册、旅行日记…"
              maxLength={60}
              disabled={loading}
            />
          </div>
          <div className="auth-field">
            <label>简介（可选）</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="一句话描述这个群组"
              maxLength={120}
              disabled={loading}
            />
          </div>
          <div className="add-admin-actions">
            <button type="button" className="add-admin-cancel" onClick={requestClose} disabled={loading}>取消</button>
            <button type="submit" className="add-admin-submit" disabled={loading}>
              {loading ? "创建中…" : "创建"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
