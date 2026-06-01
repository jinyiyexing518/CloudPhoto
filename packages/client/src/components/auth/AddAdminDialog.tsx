import { useState, FormEvent } from "react";
import { addAdminApi } from "../../services/photoApi";

interface Props {
  onClose: () => void;
}

export default function AddAdminDialog({ onClose }: Props) {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
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

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="add-admin-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="add-admin-header">
          <span>添加 Admin</span>
          <button className="dialog-close-btn" onClick={onClose}>✕</button>
        </div>

        <p className="add-admin-hint">邮箱或用户名填一项即可，两项都填更精准</p>

        {error && <div className="auth-error">{error}</div>}
        {success && <div className="add-admin-success">{success}</div>}

        <form className="add-admin-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label>用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="要添加的用户名"
              autoFocus
            />
          </div>
          <div className="auth-field">
            <label>邮箱</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="要添加的邮箱"
            />
          </div>
          <div className="add-admin-actions">
            <button type="button" className="add-admin-cancel" onClick={onClose}>取消</button>
            <button type="submit" className="add-admin-submit" disabled={loading}>
              {loading ? "添加中…" : "确认添加"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
