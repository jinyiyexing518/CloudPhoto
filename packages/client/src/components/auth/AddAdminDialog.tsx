import { useEffect, useRef, useState, FormEvent } from "react";
import { createPortal } from "react-dom";
import { addAdminApi } from "../../services/photoApi";
import { useModalFocusBoundary } from "../shared/useModalFocusBoundary";

interface Props {
  onClose: () => void;
}

export default function AddAdminDialog({ onClose }: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const usernameInputRef = useRef<HTMLInputElement | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (loading) return;
    if (!email.trim() && !username.trim()) {
      setError("请至少填写邮箱或用户名");
      return;
    }
    setError("");
    setLoading(true);
    try {
      await addAdminApi({
        email: email.trim() || undefined,
        username: username.trim() || undefined,
      });
      setSuccess(`已添加${username || email}为 Admin`);
      setEmail("");
      setUsername("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加失败");
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
    initialFocusRef: usernameInputRef,
    onEscape: () => {
      if (loading) return false;
      onClose();
      return true;
    },
  });

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  return createPortal(
    <div ref={layerRef} className="dialog-overlay" data-modal-layer onClick={requestClose}>
      <div
        ref={dialogRef}
        className="add-admin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-admin-dialog-title"
        aria-describedby="add-admin-dialog-description"
        aria-busy={loading}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="add-admin-header">
          <span id="add-admin-dialog-title">添加 Admin</span>
          <button type="button" className="dialog-close-btn" onClick={requestClose} disabled={loading} aria-label="关闭添加管理员">✕</button>
        </div>

        <p id="add-admin-dialog-description" className="add-admin-hint">邮箱或用户名填一项即可，两项都填更精准</p>

        {error && <div ref={errorRef} className="auth-error" role="alert" tabIndex={-1}>{error}</div>}
        {success && <div className="add-admin-success" role="status">{success}</div>}

        <form className="add-admin-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="add-admin-username">用户名</label>
            <input
              ref={usernameInputRef}
              id="add-admin-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="要添加的用户名"
              disabled={loading}
            />
          </div>
          <div className="auth-field">
            <label htmlFor="add-admin-email">邮箱</label>
            <input
              id="add-admin-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="要添加的邮箱"
              disabled={loading}
            />
          </div>
          <div className="add-admin-actions">
            <button type="button" className="add-admin-cancel" onClick={requestClose} disabled={loading}>取消</button>
            <button type="submit" className="add-admin-submit" disabled={loading}>
              {loading ? "添加中…" : "确认添加"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
