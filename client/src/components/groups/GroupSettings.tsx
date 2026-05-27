import { useState, useEffect, FormEvent } from "react";
import {
  GroupDetail, GroupMember,
  getGroupApi, updateGroupApi, deleteGroupApi,
  addMemberApi, removeMemberApi,
} from "../../services/groupApi";
import { useAuth } from "../../contexts/AuthContext";

interface Props {
  groupId: string;
  onClose: () => void;
  onDeleted: () => void;
  onUpdated: () => void;
}

export default function GroupSettings({ groupId, onClose, onDeleted, onUpdated }: Props) {
  const { user } = useAuth();
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Edit name/desc
  const [editingInfo, setEditingInfo] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [descInput, setDescInput] = useState("");

  // Add member by username
  const [addUsername, setAddUsername] = useState("");
  const [addingMember, setAddingMember] = useState(false);
  const [addError, setAddError] = useState("");

  // Delete confirm
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadGroup = async () => {
    setLoading(true);
    setError("");
    try {
      const g = await getGroupApi(groupId);
      setGroup(g);
      setNameInput(g.name);
      setDescInput(g.description ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadGroup(); }, [groupId]);

  const saveInfo = async (e: FormEvent) => {
    e.preventDefault();
    if (!nameInput.trim()) return;
    try {
      await updateGroupApi(groupId, { name: nameInput.trim(), description: descInput.trim() });
      setEditingInfo(false);
      onUpdated();
      await loadGroup();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    }
  };

  const handleAddMember = async (e: FormEvent) => {
    e.preventDefault();
    if (!addUsername.trim()) return;
    setAddingMember(true);
    setAddError("");
    try {
      const result = await addMemberApi(groupId, addUsername.trim());
      setAddUsername("");
      // 202 = pre-invite sent (email not registered yet)
      if (result.message) {
        setAddError(`✅ ${result.message}`);
      } else {
        await loadGroup();
        setAddError(`✅ 已添加 ${result.displayName}（@${result.username}）${result.email ? `，邀请邮件已发送至 ${result.email}` : ""}`);
      }
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "添加失败");
    } finally {
      setAddingMember(false);
    }
  };

  const handleRemove = async (member: GroupMember) => {
    if (!confirm(`确认移除 ${member.displayName}？`)) return;
    try {
      await removeMemberApi(groupId, member.userId);
      await loadGroup();
    } catch (err) {
      setError(err instanceof Error ? err.message : "移除失败");
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteGroupApi(groupId);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="group-settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="add-admin-header">
          <span>群组设置</span>
          <button className="dialog-close-btn" onClick={onClose}>✕</button>
        </div>

        {error && <div className="auth-error">{error}</div>}
        {loading && <div className="group-settings-loading">加载中…</div>}

        {group && (
          <>
            {/* ─── Group Info ─── */}
            <section className="group-settings-section">
              {editingInfo ? (
                <form onSubmit={saveInfo} className="group-info-form">
                  <div className="auth-field">
                    <label>群组名称</label>
                    <input type="text" value={nameInput} onChange={(e) => setNameInput(e.target.value)} maxLength={60} autoFocus />
                  </div>
                  <div className="auth-field">
                    <label>简介</label>
                    <input type="text" value={descInput} onChange={(e) => setDescInput(e.target.value)} maxLength={120} />
                  </div>
                  <div className="group-info-actions">
                    <button type="submit" className="add-admin-submit">保存</button>
                    <button type="button" className="add-admin-cancel" onClick={() => setEditingInfo(false)}>取消</button>
                  </div>
                </form>
              ) : (
                <div className="group-info-row">
                  <div>
                    <div className="group-info-name">{group.name}</div>
                    {group.description && <div className="group-info-desc">{group.description}</div>}
                  </div>
                  <button className="group-edit-btn" onClick={() => setEditingInfo(true)}>编辑</button>
                </div>
              )}
            </section>

            {/* ─── Members ─── */}
            <section className="group-settings-section">
              <div className="group-section-title">成员（{group.members.length}）</div>
              <ul className="group-members-list">
                {group.members.map((m) => (
                  <li key={m.userId} className="group-member-item">
                    <span className="group-member-name">{m.displayName}</span>
                    <span className="group-member-username">@{m.username}</span>
                    <span className={`group-member-role ${m.role === "admin" ? "admin" : ""}`}>
                      {m.role === "admin" ? "管理员" : "成员"}
                    </span>
                    {m.userId !== user?.id && (
                      <button className="group-remove-btn" onClick={() => handleRemove(m)} title="移除">✕</button>
                    )}
                  </li>
                ))}
              </ul>

              {/* Add existing user */}
              <form className="group-add-row" onSubmit={handleAddMember}>
                <input
                  type="text"
                  className="group-add-input"
                  placeholder="用户名或邮箱地址"
                  value={addUsername}
                  onChange={(e) => setAddUsername(e.target.value)}
                  maxLength={40}
                />
                <button type="submit" className="group-add-btn" disabled={addingMember}>
                  {addingMember ? "…" : "添加"}
                </button>
              </form>
              {addError && (
                <div
                  className={addError.startsWith("✅") ? "group-add-success" : "auth-error"}
                  style={{ marginTop: 6 }}
                >
                  {addError}
                </div>
              )}
            </section>

            {/* ─── Danger zone ─── */}
            <section className="group-settings-section group-danger-zone">
              {confirmDelete ? (
                <div className="group-delete-confirm">
                  <span>确认解散群组「{group.name}」？此操作不可撤销。</span>
                  <div className="group-info-actions">
                    <button className="confirm-delete-btn" onClick={handleDelete} disabled={deleting}>
                      {deleting ? "删除中…" : "确认解散"}
                    </button>
                    <button className="add-admin-cancel" onClick={() => setConfirmDelete(false)}>取消</button>
                  </div>
                </div>
              ) : (
                <button className="group-dissolve-btn" onClick={() => setConfirmDelete(true)}>解散群组</button>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
