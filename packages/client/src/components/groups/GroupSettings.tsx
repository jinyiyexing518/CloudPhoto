import { useState, useEffect, useRef, FormEvent } from "react";
import {
  GroupDetail, GroupMember, PendingInvite,
  getGroupApi, updateGroupApi, deleteGroupApi,
  addMemberApi, removeMemberApi,
  createInviteApi, listGroupInvitesApi, cancelInviteApi,
} from "../../services/groupApi";
import { useAuth } from "../../contexts/AuthContext";
import { useModalFocusBoundary } from "../shared/useModalFocusBoundary";
import { formatPhotoLongDate } from "../../utils/dateFormat";

interface Props {
  groupId: string;
  onClose: () => void;
  onDeleted: () => void;
  onUpdated: () => void;
}

export default function GroupSettings({ groupId, onClose, onDeleted, onUpdated }: Props) {
  const { user } = useAuth();
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Edit name/desc
  const [editingInfo, setEditingInfo] = useState(false);
  const [savingInfo, setSavingInfo] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
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
  const mutationPending = savingInfo
    || removingMemberId !== null
    || inviting
    || cancellingId !== null
    || deleting;

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
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载邀请失败");
    }
  };

  useEffect(() => {
    void loadGroup();
    void loadInvites();
  }, [groupId]);

  const saveInfo = async (e: FormEvent) => {
    e.preventDefault();
    if (mutationPending) return;
    if (!nameInput.trim()) {
      setError("请输入群组名称");
      return;
    }
    setSavingInfo(true);
    setError("");
    try {
      await updateGroupApi(groupId, { name: nameInput.trim(), description: descInput.trim() });
      setEditingInfo(false);
      onUpdated();
      await loadGroup();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSavingInfo(false);
    }
  };

  const handleRemove = async (member: GroupMember) => {
    if (mutationPending) return;
    if (!confirm(`确认移除 ${member.displayName}？`)) return;
    setRemovingMemberId(member.userId);
    setError("");
    try {
      await removeMemberApi(groupId, member.userId);
      await loadGroup();
    } catch (err) {
      setError(err instanceof Error ? err.message : "移除失败");
    } finally {
      setRemovingMemberId(null);
    }
  };

  const handleInvite = async (e: FormEvent) => {
    e.preventDefault();
    if (mutationPending) return;
    const val = inviteInput.trim();
    if (!val) {
      setInviteMsg("请输入用户名或邮箱地址");
      return;
    }
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
    if (mutationPending) return;
    setCancellingId(inviteId);
    setError("");
    try {
      await cancelInviteApi(inviteId);
      await loadInvites();
    } catch (err) {
      setError(err instanceof Error ? err.message : "撤销邀请失败");
    } finally {
      setCancellingId(null);
    }
  };

  const handleDelete = async () => {
    if (mutationPending) return;
    setDeleting(true);
    setError("");
    try {
      await deleteGroupApi(groupId);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
      setDeleting(false);
    }
  };

  const requestClose = () => {
    if (mutationPending) return;
    onClose();
  };

  useModalFocusBoundary({
    active: true,
    layerRef,
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
    onEscape: () => {
      if (mutationPending) return false;
      onClose();
      return true;
    },
  });

  return (
    <div ref={layerRef} className="dialog-overlay" data-modal-layer onClick={requestClose}>
      <div
        ref={dialogRef}
        className="group-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-settings-dialog-title"
        aria-busy={loading || mutationPending}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="add-admin-header">
          <span id="group-settings-dialog-title">群组设置</span>
          <button ref={closeButtonRef} type="button" className="dialog-close-btn" onClick={requestClose} disabled={mutationPending} aria-label="关闭群组设置">✕</button>
        </div>

        {error && <div className="auth-error" role="alert">{error}</div>}
        {loading && <div className="group-settings-loading" role="status">加载中…</div>}

        {group && (
          <>
            {/* ─── Group Info ─── */}
            <section className="group-settings-section">
              {editingInfo ? (
                <form onSubmit={saveInfo} className="group-info-form">
                  <div className="auth-field">
                    <label>群组名称</label>
                    <input type="text" value={nameInput} onChange={(e) => setNameInput(e.target.value)} maxLength={60} autoFocus disabled={savingInfo} />
                  </div>
                  <div className="auth-field">
                    <label>简介</label>
                    <input type="text" value={descInput} onChange={(e) => setDescInput(e.target.value)} maxLength={120} disabled={savingInfo} />
                  </div>
                  <div className="group-info-actions">
                    <button type="submit" className="add-admin-submit" disabled={savingInfo}>{savingInfo ? "保存中…" : "保存"}</button>
                    <button type="button" className="add-admin-cancel" onClick={() => setEditingInfo(false)} disabled={savingInfo}>取消</button>
                  </div>
                </form>
              ) : (
                <div className="group-info-row">
                  <div>
                    <div className="group-info-name">{group.name}</div>
                    {group.description && <div className="group-info-desc">{group.description}</div>}
                  </div>
                  <button type="button" className="group-edit-btn" onClick={() => setEditingInfo(true)} disabled={mutationPending}>编辑</button>
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
                      <button
                        type="button"
                        className="group-remove-btn"
                        onClick={() => handleRemove(m)}
                        disabled={mutationPending}
                        aria-label={`移除成员${m.displayName}`}
                        title="移除"
                      >✕</button>
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
                  disabled={mutationPending}
                />
                <button type="submit" className="group-add-btn" disabled={mutationPending}>
                  {inviting ? "…" : "发送邀请"}
                </button>
              </form>
              {inviteMsg && (
                <div
                  className={inviteMsg.startsWith("✅") ? "group-add-success" : "auth-error"}
                  role={inviteMsg.startsWith("✅") ? "status" : "alert"}
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
                            {formatPhotoLongDate(inv.expiresAt)} 到期
                          </span>
                        </div>
                        <button
                          className="group-remove-btn"
                          type="button"
                          disabled={mutationPending}
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
                    <button type="button" className="confirm-delete-btn" onClick={handleDelete} disabled={deleting}>
                      {deleting ? "删除中…" : "确认解散"}
                    </button>
                    <button type="button" className="add-admin-cancel" onClick={() => setConfirmDelete(false)} disabled={deleting}>取消</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="group-dissolve-btn" onClick={() => setConfirmDelete(true)} disabled={mutationPending}>解散群组</button>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
