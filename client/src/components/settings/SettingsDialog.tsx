import { useState, FormEvent } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { useGroup } from "../../contexts/GroupContext";
import { updateProfileApi, changePasswordApi, saveStoredAuth } from "../../services/photoApi";
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
        <div className="settings-body">

          {/* ── 个人信息 ── */}
          {tab === "profile" && (
            <div className="settings-section">
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
            <div className="settings-section">
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
                  <button className="settings-save-btn" onClick={onInstallApp}>立即安装 App</button>
                )}
                {!isStandalone && (
                  <button className="settings-save-btn" onClick={onOpenInstallGuide}>查看安装指引</button>
                )}
                <p className="add-admin-hint" style={{ marginTop: 4 }}>
                  说明：并非所有浏览器都支持一键安装。如果按钮不可用，请按安装指引手动添加到主屏幕。
                </p>
              </div>
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
