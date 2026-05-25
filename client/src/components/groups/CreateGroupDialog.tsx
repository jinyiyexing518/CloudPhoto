import { useState, FormEvent } from "react";
import { createGroupApi } from "../../services/groupApi";

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

export default function CreateGroupDialog({ onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError("请输入群组名称"); return; }
    setLoading(true);
    setError("");
    try {
      await createGroupApi({ name: name.trim(), description: description.trim() || undefined });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="add-admin-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="add-admin-header">
          <span>新建群组</span>
          <button className="dialog-close-btn" onClick={onClose}>✕</button>
        </div>

        {error && <div className="auth-error">{error}</div>}

        <form className="add-admin-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label>群组名称 <span className="required">*</span></label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：家庭相册、旅行日记…"
              autoFocus
              maxLength={60}
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
            />
          </div>
          <div className="add-admin-actions">
            <button type="button" className="add-admin-cancel" onClick={onClose}>取消</button>
            <button type="submit" className="add-admin-submit" disabled={loading}>
              {loading ? "创建中…" : "创建"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
