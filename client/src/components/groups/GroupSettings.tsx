import { useState, useEffect, FormEvent } from "react";
import {
  GroupDetail, GroupMember, PendingInvite,
  getGroupApi, updateGroupApi, deleteGroupApi,
  addMemberApi, removeMemberApi,
  createInviteApi, listGroupInvitesApi, cancelInviteApi,
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

  // Unified invite (username or email)
  const [inviteInput, setInviteInput] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState("");
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

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

  const loadInvites = async () => {
    try {
      const invs = await listGroupInvitesApi(groupId);
      setPendingInvites(invs);
    } catch { /* non-critical */ }
  };

  useEffect(() => {
    void loadGroup();
    void loadInvites();
  }, [groupId]);

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

  const handleRemove = async (member: GroupMember) => {
    if (!confirm(`确认移除 ${member.displayName}？`)) return;
    try {
      await removeMemberApi(groupId, member.userId);
      await loadGroup();
    } catch (err) {
      setError(err instanceof Error ? err.message : "移除失败");
    }
  };

  const handleInvite = async (e: FormEvent) => {
    e.preventDefault();
    const val = inviteInput.trim();
    if (!val) return;
    setInviting(true);
    setInviteMsg("");
    try {
      const isEmail = val.includes("@");
      if (isEmail) {
        const res = await createInviteApi(groupId, val.toLowerCase());
        setInviteInput("");
        setInviteMsg(`✅ 邀请已发送至 ${res.email}，等待对方接受`);
      } else {
        const res = await addMemberApi(groupId, val);
        setInviteInput("");
        setInviteMsg(`✅ 邀请已发送至 ${res.email}（${res.displayName}），等待对方接受`);
      }
      await loadInvites();
    } catch (err) {
      setInviteMsg(err instanceof Error ? err.message : "发送失败");
    } finally {
      setInviting(false);
    }
  };

  const handleCancelInvite = async (inviteId: string) => {
    setCancellingId(inviteId);
    try {
      await cancelInviteApi(inviteId);
      await loadInvites();
    } catch { /* ignore */ } finally {
      setCancellingId(null);
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

            </section>

            {/* ─── Invite section (username or email) ─── */}
            <section className="group-settings-section">
              <h4 className="group-section-label">邀请成员</h4>
              <p className="invite-hint" style={{ marginBottom: 8 }}>
                输入用户名或邮箱，邀请邮件将发送给对方。对方点击链接并接受后才会加入群组。
              </p>
              <form className="group-add-form" onSubmit={handleInvite}>
                <input
                  type="text"
                  className="group-add-input"
                  placeholder="用户名 或 邮箱地址"
                  value={inviteInput}
                  onChange={(e) => setInviteInput(e.target.value)}
                  maxLength={120}
                />
                <button type="submit" className="group-add-btn" disabled={inviting}>
                  {inviting ? "…" : "发送邀请"}
                </button>
              </form>
              {inviteMsg && (
                <div
                  className={inviteMsg.startsWith("✅") ? "group-add-success" : "auth-error"}
                  style={{ marginTop: 6 }}
                >
                  {inviteMsg}
                </div>
              )}

              {pendingInvites.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <p className="group-section-label" style={{ marginBottom: 6 }}>待接受邀请</p>
                  <ul className="group-members-list">
                    {pendingInvites.map((inv) => (
                      <li key={inv.id} className="group-member-item">
                        <div className="group-member-info">
                          <span className="group-member-name">{inv.email}</span>
                          <span className="group-member-role">
                            {new Date(inv.expiresAt).toLocaleDateString("zh-CN")} 到期
                          </span>
                        </div>
                        <button
                          className="group-remove-btn"
                          disabled={cancellingId === inv.id}
                          onClick={() => handleCancelInvite(inv.id)}
                        >
                          {cancellingId === inv.id ? "…" : "撤销"}
                        </button>
                      </li>
                    ))}
                  </ul>
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
