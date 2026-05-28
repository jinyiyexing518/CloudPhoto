import { useState, useMemo, useCallback, useEffect, FormEvent } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { useGroup } from "../../contexts/GroupContext";
import {
  updateProfileApi,
  changePasswordApi,
  saveStoredAuth,
  listManagedShareLinks,
  updateManagedShareLink,
  ManagedShareLink,
} from "../../services/photoApi";
import { listRecentShareLinks, removeRecentShareLink, clearRecentShareLinks } from "../../features/share/shareLinksStore";
import { copyText } from "../../features/share/clipboard";
import { useToast } from "../../contexts/ToastContext";
import TrashView from "../gallery/TrashView";

type SettingsTab = "profile" | "security" | "trash";

interface Props {
  onClose: () => void;
  onPhotosRestored?: () => void;
  canInstall?: boolean;
  isStandalone?: boolean;
  onInstallApp?: () => void;
  onOpenInstallGuide?: () => void;
}

export default function SettingsDialog({
  onClose,
  onPhotosRestored,
  canInstall = false,
  isStandalone = false,
  onInstallApp,
  onOpenInstallGuide,
}: Props) {
  const { user, updateUser } = useAuth();
  const { currentGroupId } = useGroup();
  const showToast = useToast();
  const [tab, setTab] = useState<SettingsTab | "app">("profile");

  // Profile tab
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState("");

  // Security tab
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwError, setPwError] = useState("");

  const [managedShareLinks, setManagedShareLinks] = useState<ManagedShareLink[]>([]);
  const [managedLoading, setManagedLoading] = useState(false);
  const [managedError, setManagedError] = useState("");
  const [linkBusyId, setLinkBusyId] = useState<string | null>(null);
  const [shareStatusFilter, setShareStatusFilter] = useState<"all" | "active" | "revoked" | "expired">("all");
  const [shareSearch, setShareSearch] = useState("");
  const [extendHours, setExtendHours] = useState("24");

  const [shareLinksVersion, setShareLinksVersion] = useState(0);
  const shareLinks = useMemo(() => {
    const links = listRecentShareLinks();
    return Array.isArray(links) ? links : [];
  }, [shareLinksVersion]);

  const loadManagedShareLinks = useCallback(async () => {
    setManagedLoading(true);
    setManagedError("");
    try {
      const links = await listManagedShareLinks({
        status: shareStatusFilter,
        q: shareSearch,
      });
      setManagedShareLinks(Array.isArray(links) ? links : []);
    } catch (e) {
      setManagedError(e instanceof Error ? e.message : "加载分享链接失败");
      setManagedShareLinks([]);
    } finally {
      setManagedLoading(false);
    }
  }, [shareSearch, shareStatusFilter]);

  useEffect(() => {
    if (tab !== "app") return;
    void loadManagedShareLinks();
  }, [tab, loadManagedShareLinks]);

  const handleSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) return;
    setProfileSaving(true);
    setProfileError("");
    try {
      const resp = await updateProfileApi({ displayName: displayName.trim() });
      saveStoredAuth(resp.token, resp.refreshToken);
      updateUser(resp.user);
      showToast("昵称已更新", "success");
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setProfileSaving(false);
    }
  };

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPwError("");
    if (newPw !== confirmPw) { setPwError("两次输入的新密码不一致"); return; }
    if (newPw.length < 6) { setPwError("新密码至少 6 位"); return; }
    setPwSaving(true);
    try {
      await changePasswordApi({ currentPassword: currentPw, newPassword: newPw });
      setCurrentPw(""); setNewPw(""); setConfirmPw("");
      showToast("密码已更新", "success");
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "修改失败");
    } finally {
      setPwSaving(false);
    }
  };

  const refreshShareLinks = () => setShareLinksVersion((v) => v + 1);

  const copyShareLink = async (url: string) => {
    const copied = await copyText(url);
    if (copied) {
      showToast("链接已复制", "success");
    } else {
      window.prompt("复制分享链接", url);
      showToast("已生成链接，请手动复制", "info");
    }
  };

  const handleManagedAction = async (item: ManagedShareLink, action: "revoke" | "extend") => {
    if (action === "revoke" && !confirm("确认让这个分享链接立即失效吗？")) return;
    setLinkBusyId(item.id);
    try {
      const duration = Math.max(1, Math.min(24 * 30, Number.parseInt(extendHours, 10) || 24));
      await updateManagedShareLink(item.id, action, action === "extend" ? duration : undefined);
      showToast(action === "revoke" ? "分享链接已失效" : `已延长 ${duration} 小时`, "success");
      await loadManagedShareLinks();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "更新分享链接失败", "error");
    } finally {
      setLinkBusyId(null);
    }
  };

  const safeManagedShareLinks = Array.isArray(managedShareLinks)
    ? managedShareLinks.filter((item): item is ManagedShareLink => !!item && typeof item.id === "string")
    : [];
  const safeShareLinks = Array.isArray(shareLinks)
    ? shareLinks.filter((item) => !!item && typeof item.id === "string" && typeof item.url === "string")
    : [];

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="settings-header">
          <span>设置</span>
          <button className="dialog-close-btn" onClick={onClose}>✕</button>
        </div>

        {/* Tab bar */}
        <div className="settings-tabs">
          <button className={`settings-tab${tab === "profile" ? " active" : ""}`} onClick={() => setTab("profile")}>👤 个人信息</button>
          <button className={`settings-tab${tab === "security" ? " active" : ""}`} onClick={() => setTab("security")}>🔒 安全</button>
          <button className={`settings-tab${tab === "app" ? " active" : ""}`} onClick={() => setTab("app")}>📱 应用</button>
          <button className={`settings-tab${tab === "trash" ? " active" : ""}`} onClick={() => setTab("trash")}>🗑️ 回收站</button>
        </div>

        {/* Tab content */}
        <div className="settings-body" style={{ textAlign: "left" }}>

          {/* ── 个人信息 ── */}
          {tab === "profile" && (
            <div className="settings-section" style={{ textAlign: "left", alignItems: "stretch" }}>
              {/* Read-only info */}
              <div className="settings-info-row">
                <span className="settings-info-label">用户名</span>
                <span className="settings-info-value">@{user?.username}</span>
              </div>
              <div className="settings-info-row">
                <span className="settings-info-label">邮箱</span>
                <span className="settings-info-value">{user?.email}</span>
              </div>
              <div className="settings-info-row">
                <span className="settings-info-label">角色</span>
                <span className="settings-info-value">{user?.role === "admin" ? "管理员" : "普通用户"}</span>
              </div>

              <div className="settings-divider" />

              {/* Editable */}
              <form onSubmit={handleSaveProfile} className="settings-form">
                <div className="auth-field">
                  <label>昵称（显示名）</label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    maxLength={40}
                    placeholder="修改昵称"
                  />
                </div>
                {profileError && <div className="auth-error">{profileError}</div>}
                <button
                  type="submit"
                  className="settings-save-btn"
                  disabled={profileSaving || !displayName.trim() || displayName.trim() === user?.displayName}
                >
                  {profileSaving ? "保存中…" : "保存昵称"}
                </button>
              </form>
            </div>
          )}

          {/* ── 安全 ── */}
          {tab === "security" && (
            <div className="settings-section" style={{ textAlign: "left", alignItems: "stretch" }}>
              <form onSubmit={handleChangePassword} className="settings-form">
                <div className="auth-field">
                  <label>当前密码</label>
                  <input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} autoComplete="current-password" />
                </div>
                <div className="auth-field">
                  <label>新密码</label>
                  <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" placeholder="至少 6 位" />
                </div>
                <div className="auth-field">
                  <label>确认新密码</label>
                  <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" />
                </div>
                {pwError && <div className="auth-error">{pwError}</div>}
                <button
                  type="submit"
                  className="settings-save-btn"
                  disabled={pwSaving || !currentPw || !newPw || !confirmPw}
                >
                  {pwSaving ? "修改中…" : "修改密码"}
                </button>
              </form>
            </div>
          )}

          {/* ── 应用 ── */}
          {tab === "app" && (
            <div className="settings-section">
              <div className="settings-info-row">
                <span className="settings-info-label">当前模式</span>
                <span className="settings-info-value">{isStandalone ? "App 模式" : "网页模式"}</span>
              </div>
              <div className="settings-info-row">
                <span className="settings-info-label">一键安装</span>
                <span className="settings-info-value">{canInstall ? "当前浏览器支持" : "当前浏览器可能不支持"}</span>
              </div>
              <div className="settings-divider" />
              <div className="settings-form" style={{ gap: 10 }}>
                {!isStandalone && canInstall && (
                  <button type="button" className="settings-save-btn" onClick={onInstallApp}>立即安装 App</button>
                )}
                {!isStandalone && (
                  <button type="button" className="settings-save-btn" onClick={onOpenInstallGuide}>查看安装指引</button>
                )}
                <p className="add-admin-hint" style={{ marginTop: 4 }}>
                  说明：并非所有浏览器都支持一键安装。如果按钮不可用，请按安装指引手动添加到主屏幕。
                </p>
              </div>

              <div className="settings-divider" />

              <div className="settings-share-header">
                <span className="settings-info-label">云端分享链接（可维护）</span>
                <button type="button" className="settings-share-clear" onClick={() => void loadManagedShareLinks()}>
                  刷新
                </button>
              </div>

              <div className="settings-share-toolbar">
                <input
                  className="settings-share-search"
                  type="text"
                  placeholder="按文件名搜索"
                  value={shareSearch}
                  onChange={(e) => setShareSearch(e.target.value)}
                />
                <select
                  className="settings-share-filter"
                  value={shareStatusFilter}
                  onChange={(e) => setShareStatusFilter(e.target.value as "all" | "active" | "revoked" | "expired")}
                >
                  <option value="all">全部状态</option>
                  <option value="active">有效</option>
                  <option value="expired">已过期</option>
                  <option value="revoked">已失效</option>
                </select>
                <button type="button" className="settings-share-apply" onClick={() => void loadManagedShareLinks()}>
                  应用筛选
                </button>
              </div>

              <div className="settings-share-extend-row">
                <span className="settings-share-extend-label">默认延长：</span>
                <select className="settings-share-filter" value={extendHours} onChange={(e) => setExtendHours(e.target.value)}>
                  <option value="1">1 小时</option>
                  <option value="24">24 小时</option>
                  <option value="72">3 天</option>
                  <option value="168">7 天</option>
                  <option value="720">30 天</option>
                </select>
              </div>

              {managedLoading ? (
                <p className="add-admin-hint">正在加载分享链接…</p>
              ) : managedError ? (
                <p className="auth-error">{managedError}</p>
              ) : safeManagedShareLinks.length === 0 ? (
                <p className="add-admin-hint">暂无云端分享记录，先从照片详情创建一个分享链接。</p>
              ) : (
                <div className="settings-share-list">
                  {safeManagedShareLinks.map((item) => {
                    const statusText = item.status === "active" ? "有效" : item.status === "revoked" ? "已失效" : "已过期";
                    const busy = linkBusyId === item.id;
                    const publicUrl = item.url ?? `${window.location.origin}/api/photos/share/open/${encodeURIComponent(item.id)}`;
                    return (
                      <div key={item.id} className="settings-share-item settings-share-item--managed">
                        <div className="settings-share-meta">
                          <div className="settings-share-name" title={item.displayName}>{item.displayName}</div>
                          <div className="settings-share-expire">创建：{new Date(item.createdAt).toLocaleString()}</div>
                          <div className="settings-share-expire">到期：{new Date(item.expiresAt).toLocaleString()} · 状态：{statusText}</div>
                          <div className="settings-share-expire">浏览量：{item.viewCount} · 最近访问：{item.lastViewedAt ? new Date(item.lastViewedAt).toLocaleString() : "暂无"}</div>
                        </div>
                        <div className="settings-share-actions">
                          <button type="button" onClick={() => void copyShareLink(publicUrl)}>复制</button>
                          <button type="button" onClick={() => window.open(publicUrl, "_blank", "noopener,noreferrer")}>打开</button>
                          <button type="button" onClick={() => void handleManagedAction(item, "extend")} disabled={busy || item.status !== "active"}>延长</button>
                          <button type="button" onClick={() => void handleManagedAction(item, "revoke")} disabled={busy || item.status !== "active"}>立即失效</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="settings-divider" />

              <div className="settings-share-header">
                <span className="settings-info-label">本地分享记录（仅当前浏览器）</span>
                {safeShareLinks.length > 0 && (
                  <button
                    type="button"
                    className="settings-share-clear"
                    onClick={() => {
                      clearRecentShareLinks();
                      refreshShareLinks();
                      showToast("已清空本地分享记录", "success");
                    }}
                  >
                    清空记录
                  </button>
                )}
              </div>

              {safeShareLinks.length === 0 ? (
                <p className="add-admin-hint">暂无本机生成的有效分享链接。</p>
              ) : (
                <div className="settings-share-list">
                  {safeShareLinks.map((item) => (
                    <div key={item.id} className="settings-share-item">
                      <div className="settings-share-meta">
                        <div className="settings-share-name" title={item.displayName}>{item.displayName}</div>
                        <div className="settings-share-expire">到期：{new Date(item.expiresAt).toLocaleString()}</div>
                      </div>
                      <div className="settings-share-actions">
                        <button type="button" onClick={() => void copyShareLink(item.url)}>复制</button>
                        <button type="button" onClick={() => window.open(item.url, "_blank", "noopener,noreferrer")}>打开</button>
                        <button
                          type="button"
                          onClick={() => {
                            removeRecentShareLink(item.id);
                            refreshShareLinks();
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── 回收站 ── */}
          {tab === "trash" && (
            <div className="settings-section settings-trash">
              <TrashView groupId={currentGroupId} onRestored={onPhotosRestored} />
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
