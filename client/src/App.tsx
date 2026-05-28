import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { listPhotos, uploadPhoto, deletePhoto, movePhotoToFolder, renameFolderApi, setPhotoFavorite, Photo } from "./services/photoApi";
import PhotoGallery from "./components/gallery/PhotoGallery";
import FolderView from "./components/gallery/FolderView";
import FilterBar, { FilterState, emptyFilter } from "./components/gallery/FilterBar";
import GroupSwitcher from "./components/groups/GroupSwitcher";
import SettingsDialog from "./components/settings/SettingsDialog";
import InviteAcceptPage from "./components/invites/InviteAcceptPage";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { GroupProvider, useGroup } from "./contexts/GroupContext";
import { ToastProvider, useToast } from "./contexts/ToastContext";
import AuthPage from "./components/auth/AuthPage";
import AddAdminDialog from "./components/auth/AddAdminDialog";

const SUPER_ADMIN = "zhangchi";
const INSTALL_BANNER_DISMISSED_KEY = "cf_install_banner_dismissed";
const UPDATE_PROMPT_DISMISS_UNTIL_KEY = "cf_update_prompt_dismiss_until";
type ViewTab = "timeline" | "folder" | "moments";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function AppContent() {
  const { user, logout } = useAuth();
  const { currentGroupId, groups, groupsLoaded } = useGroup();
  const showToast = useToast();
  const [showAddAdmin, setShowAddAdmin] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [installBannerDismissed, setInstallBannerDismissed] = useState<boolean>(() => localStorage.getItem(INSTALL_BANNER_DISMISSED_KEY) === "1");
  const deferredInstallPrompt = useRef<BeforeInstallPromptEvent | null>(null);
  const ua = navigator.userAgent.toLowerCase();
  const isIOS = /iphone|ipad|ipod/.test(ua);
  const isAndroid = /android/.test(ua);

  // Location banner: shown briefly when entering a group or personal space
  const [locationBanner, setLocationBanner] = useState<string | null>(null);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!groupsLoaded) return;
    const group = groups.find((g) => g.id === currentGroupId);
    const label = currentGroupId === "" ? "📷 个人空间" : `👥 ${group?.name ?? "群组"}`;
    setLocationBanner(label);
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    bannerTimer.current = setTimeout(() => setLocationBanner(null), 2200);
    return () => { if (bannerTimer.current) clearTimeout(bannerTimer.current); };
  }, [currentGroupId, groupsLoaded]); // groups intentionally omitted — only care when user switches

  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)").matches
      || ((navigator as Navigator & { standalone?: boolean }).standalone === true);
    setIsStandalone(standalone);

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      deferredInstallPrompt.current = event as BeforeInstallPromptEvent;
      setCanInstall(true);
    };
    const onAppInstalled = () => {
      deferredInstallPrompt.current = null;
      setCanInstall(false);
      setIsStandalone(true);
      showToast("Cloud Photo 已安装到设备", "success");
    };
    const onUpdateReady = () => {
      const suppressUntil = Number(localStorage.getItem(UPDATE_PROMPT_DISMISS_UNTIL_KEY) ?? "0");
      if (suppressUntil > Date.now()) return;
      setUpdateReady(true);
    };
    const onOfflineReady = () => showToast("已启用离线基础访问", "success");

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt as EventListener);
    window.addEventListener("appinstalled", onAppInstalled);
    window.addEventListener("cloudphoto-pwa-update-ready", onUpdateReady as EventListener);
    window.addEventListener("cloudphoto-pwa-offline-ready", onOfflineReady as EventListener);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt as EventListener);
      window.removeEventListener("appinstalled", onAppInstalled);
      window.removeEventListener("cloudphoto-pwa-update-ready", onUpdateReady as EventListener);
      window.removeEventListener("cloudphoto-pwa-offline-ready", onOfflineReady as EventListener);
    };
  }, [showToast]);

  // Invite token from URL ?invite=<token>
  const [inviteToken, setInviteToken] = useState<string | null>(() => {
    const p = new URLSearchParams(window.location.search);
    return p.get("invite");
  });
  const dismissInvite = () => {
    setInviteToken(null);
    // Remove ?invite= from URL without reload
    const url = new URL(window.location.href);
    url.searchParams.delete("invite");
    window.history.replaceState({}, "", url.toString());
  };

  // Persist active tab per user across refreshes
  const tabKey = `cf_tab_${user?.username ?? "guest"}`;
  const [activeTab, setActiveTab] = useState<ViewTab>(() => {
    const stored = localStorage.getItem(tabKey);
    if (stored === "folder" || stored === "timeline" || stored === "moments") return stored;
    return "timeline";
  });
  const switchTab = (tab: ViewTab) => {
    if (transferring) {
      showToast("传输进行中，请等待上传/下载完成后再切换页面", "error");
      return;
    }
    setActiveTab(tab);
    localStorage.setItem(tabKey, tab);
  };
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number; folder: string } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [filters, setFilters] = useState<FilterState>(emptyFilter);
  const transferring = uploadProgress !== null || downloading;

  // Derived lists for filter dropdowns
  const uploaders = useMemo(
    () => [...new Set(photos.map((p) => p.createdBy).filter(Boolean) as string[])].sort(),
    [photos]
  );
  const subjects = useMemo(
    () => [...new Set(photos.map((p) => p.subject).filter(Boolean) as string[])].sort(),
    [photos]
  );

  const filteredPhotos = useMemo(() => {
    return photos.filter((p) => {
      const name = (p.originalName || p.name.replace(/^\d+-/, "")).toLowerCase();
      const date = p.createdAt ?? p.lastModified;

      if (filters.name && !name.includes(filters.name.toLowerCase())) return false;
      if (filters.subject && !(p.subject ?? "").toLowerCase().includes(filters.subject.toLowerCase())) return false;
      if (filters.uploader && p.createdBy !== filters.uploader) return false;
      if (filters.dateFrom && date && date.slice(0, 10) < filters.dateFrom) return false;
      if (filters.dateTo && date && date.slice(0, 10) > filters.dateTo) return false;
      if (filters.favoriteOnly && !p.favorite) return false;
      return true;
    });
  }, [photos, filters]);

  const importantPhotos = useMemo(() => {
    const scored = [...filteredPhotos].map((p) => {
      const ts = new Date(p.createdAt ?? p.lastModified ?? 0).getTime();
      const recencyDays = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
      const score = (p.favorite ? 120 : 0) + (p.subject ? 20 : 0) + Math.max(0, 40 - recencyDays);
      return { p, score };
    });
    return scored.sort((a, b) => b.score - a.score).map((x) => x.p).slice(0, 120);
  }, [filteredPhotos]);

  const fetchPhotos = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(false);
      const data = await listPhotos(currentGroupId);
      setPhotos(data);
    } catch {
      showToast("加载照片失败，请检查网络或服务器状态", "error");
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [currentGroupId, showToast]);

  useEffect(() => { void fetchPhotos(); }, [fetchPhotos]);

  useEffect(() => {
    if (!transferring) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [transferring]);

  const handleUploadToFolder = async (files: FileList, folder: string, subject?: string) => {
    const ALLOWED_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif", "image/bmp", "image/tiff"]);
    const MAX_SIZE_BYTES = 20 * 1024 * 1024;
    const fileArray = Array.from(files);
    const invalidType = fileArray.filter((f) => !ALLOWED_TYPES.has(f.type));
    const oversized = fileArray.filter((f) => ALLOWED_TYPES.has(f.type) && f.size > MAX_SIZE_BYTES);
    if (invalidType.length > 0 || oversized.length > 0) {
      const msgs: string[] = [];
      if (invalidType.length) msgs.push(`非图片文件: ${invalidType.map((f) => f.name).join(", ")}`);
      if (oversized.length) msgs.push(`文件过大(>20MB): ${oversized.map((f) => f.name).join(", ")}`);
      showToast(msgs.join("; "), "error");
    }
    const valid = fileArray.filter((f) => ALLOWED_TYPES.has(f.type) && f.size <= MAX_SIZE_BYTES);
    if (valid.length === 0) return;
    setUploadProgress({ done: 0, total: valid.length, folder });
    const failed: string[] = [];
    for (let i = 0; i < valid.length; i++) {
      try {
        await uploadPhoto(valid[i], user?.displayName || undefined, subject || undefined, folder || undefined, currentGroupId || undefined);
      } catch {
        failed.push(valid[i].name);
      }
      setUploadProgress({ done: i + 1, total: valid.length, folder });
    }
    await fetchPhotos();
    setUploadProgress(null);
    if (failed.length > 0) {
      showToast(`上传失败 (${failed.length}/${valid.length}): ${failed.join(", ")}`, "error");
    } else {
      showToast(`成功上传 ${valid.length} 张照片`, "success");
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await deletePhoto(name);
      setPhotos((prev) => prev.filter((p) => p.name !== name));
      showToast("照片已删除", "success");
    } catch {
      showToast("删除失败，请重试", "error");
    }
  };

  const handleSubjectUpdate = (name: string, subject: string) => {
    setPhotos((prev) =>
      prev.map((p) => (p.name === name ? { ...p, subject } : p))
    );
  };

  const handleRenamePhoto = (name: string, newOriginalName: string) => {
    setPhotos((prev) =>
      prev.map((p) => (p.name === name ? { ...p, originalName: newOriginalName } : p))
    );
  };

  const handleToggleFavorite = async (name: string, favorite: boolean): Promise<boolean> => {
    setPhotos((prev) => prev.map((p) => (p.name === name ? { ...p, favorite } : p)));
    try {
      await setPhotoFavorite(name, favorite, user?.displayName || undefined);
      return true;
    } catch {
      showToast(favorite ? "收藏失败" : "取消收藏失败", "error");
      await fetchPhotos();
      return false;
    }
  };

  const handleMovePhoto = async (name: string, toFolder: string): Promise<boolean> => {
    // Optimistic update (folder display only; name updated after server confirms)
    setPhotos((prev) => prev.map((p) => p.name === name ? { ...p, folder: toFolder } : p));
    try {
      const { newName } = await movePhotoToFolder(name, toFolder, user?.displayName || undefined);
      setPhotos((prev) => prev.map((p) => p.name === name ? { ...p, name: newName, folder: toFolder } : p));
      return true;
    } catch {
      showToast("移动照片失败", "error");
      await fetchPhotos();
      return false;
    }
  };

  const handleRenameFolder = async (oldFolder: string, newFolder: string) => {
    try {
      const res = await renameFolderApi(oldFolder, newFolder, currentGroupId || undefined);
      showToast(`文件夹已重命名（${res.renamed} 张照片已更新）`, "success");
      await fetchPhotos();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "重命名失败", "error");
      throw e; // Let FolderView know it failed
    }
  };

  const handleInstallApp = async () => {
    const promptEvent = deferredInstallPrompt.current;
    if (!promptEvent) return;
    await promptEvent.prompt();
    const result = await promptEvent.userChoice;
    if (result.outcome === "accepted") {
      showToast("正在安装 Cloud Photo", "success");
    }
  };

  const handleRefreshToUpdate = async () => {
    const updateSW = (window as Window & { __CF_UPDATE_SW__?: (reloadPage?: boolean) => Promise<void> }).__CF_UPDATE_SW__;
    if (!updateSW) {
      window.location.reload();
      return;
    }
    await updateSW(true);
  };

  const handleLaterUpdate = () => {
    // Snooze update reminder for 6 hours.
    localStorage.setItem(UPDATE_PROMPT_DISMISS_UNTIL_KEY, String(Date.now() + 6 * 60 * 60 * 1000));
    setUpdateReady(false);
  };

  const dismissInstallBanner = () => {
    setInstallBannerDismissed(true);
    localStorage.setItem(INSTALL_BANNER_DISMISSED_KEY, "1");
  };

  const installGuideText = useMemo(() => {
    if (isIOS) {
      return [
        "使用 Safari 打开本网站",
        "点击底部分享按钮",
        "选择“添加到主屏幕”",
        "返回桌面后从图标启动",
      ];
    }
    if (isAndroid) {
      return [
        "使用 Chrome/Edge 打开本网站",
        "点击地址栏安装图标，或菜单里的“安装应用”",
        "安装后可从桌面图标启动",
      ];
    }
    return [
      "使用 Chrome 或 Edge 打开本网站",
      "点击地址栏安装图标，或菜单里的“安装应用”",
      "安装后可在桌面/开始菜单启动",
    ];
  }, [isAndroid, isIOS]);

  const installBannerText = useMemo(() => {
    if (isIOS) return "可安装为 App：在 Safari 中点“分享 -> 添加到主屏幕”。";
    if (canInstall) return "可安装为 App：点击“立即安装”后，可从桌面图标直接打开。";
    return "可安装为 App：打开安装指引，按设备步骤安装到桌面/主屏幕。";
  }, [canInstall, isIOS]);

  return (
    <div className="app">
      {locationBanner && (
        <div className="location-banner" key={locationBanner}>
          {locationBanner}
        </div>
      )}
      <header className="app-header">
        <h1>Cloud Photo</h1>
        <GroupSwitcher />
        <span className="photo-count">{photos.length} photos</span>
        <div className="user-badge">
          <span className="user-name-btn">
            👤 {user?.displayName}
            {user?.role === "admin" && <span className="role-badge">Admin</span>}
          </span>
          {user?.username === SUPER_ADMIN && (
            <button className="add-admin-btn" onClick={() => setShowAddAdmin(true)} title="添加 Admin">
              + Admin
            </button>
          )}
          <button className="logout-btn" onClick={logout} title="退出登录">退出</button>
          <button className="settings-btn" onClick={() => setShowSettings(true)} title="设置">⚙️</button>
        </div>
      </header>

      {showAddAdmin && <AddAdminDialog onClose={() => setShowAddAdmin(false)} />}
      {showSettings && (
        <SettingsDialog
          onClose={() => setShowSettings(false)}
          onPhotosRestored={fetchPhotos}
          canInstall={canInstall}
          isStandalone={isStandalone}
          onInstallApp={() => void handleInstallApp()}
          onOpenInstallGuide={() => setShowInstallGuide(true)}
        />
      )}
      {inviteToken && <InviteAcceptPage token={inviteToken} onDone={dismissInvite} />}
      {showInstallGuide && (
        <div className="dialog-overlay" onClick={() => setShowInstallGuide(false)}>
          <div className="add-admin-dialog install-guide-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="add-admin-header">
              <span>安装使用指引</span>
              <button className="dialog-close-btn" onClick={() => setShowInstallGuide(false)}>✕</button>
            </div>
            <p className="add-admin-hint">{isStandalone ? "当前已是 App 模式" : "可同时作为网站和 App 使用"}</p>
            <ol className="install-guide-list">
              {installGuideText.map((item) => <li key={item}>{item}</li>)}
            </ol>
            <p className="install-guide-note">提示：上传或下载过程中，请不要刷新页面或关闭应用窗口。</p>
          </div>
        </div>
      )}

      <main className="app-main">
        {updateReady && (
          <div className="pwa-update-banner">
            <span>检测到新版本，点击即可更新。</span>
            <div className="pwa-install-actions">
              <button onClick={() => void handleRefreshToUpdate()}>立即更新</button>
              <button className="pwa-install-later" onClick={handleLaterUpdate}>稍后提醒</button>
            </div>
          </div>
        )}

        {!isStandalone && !installBannerDismissed && (
          <div className="pwa-install-banner">
            <span>{installBannerText}</span>
            <div className="pwa-install-actions">
              {canInstall ? (
                <button onClick={() => void handleInstallApp()}>立即安装</button>
              ) : (
                <button onClick={() => setShowInstallGuide(true)}>查看安装指引</button>
              )}
              <button className="pwa-install-later" onClick={dismissInstallBanner}>稍后</button>
            </div>
          </div>
        )}

        {/* Tab bar */}
        <div className="view-tabs">
          <button
            className={`view-tab${activeTab === "timeline" ? " active" : ""}`}
            onClick={() => switchTab("timeline")}
          >
            🕐 时间线
          </button>
          <button
            className={`view-tab${activeTab === "folder" ? " active" : ""}`}
            onClick={() => switchTab("folder")}
          >
            📁 文件夹
          </button>
          <button
            className={`view-tab${activeTab === "moments" ? " active" : ""}`}
            onClick={() => switchTab("moments")}
          >
            ⭐ 重要片段
          </button>
        </div>

        {/* Timeline hint */}
        {activeTab === "timeline" && (
          <div className="timeline-upload-hint">
            📁 请切换到「<button className="hint-tab-link" onClick={() => switchTab("folder")}>文件夹</button>」视图来添加照片
          </div>
        )}

        {activeTab === "moments" && (
          <div className="timeline-upload-hint">
            ⭐ 这里展示按收藏、主题与近期权重排序的重点照片
          </div>
        )}

        {(activeTab === "timeline" || activeTab === "moments") && (
          <FilterBar
            filters={filters}
            onChange={setFilters}
            uploaders={uploaders}
            subjects={subjects}
            total={photos.length}
            filtered={filteredPhotos.length}
          />
        )}

        {loading ? (
          <div className="loading">
            <div className="loading-spinner" />
            <span>加载中…</span>
          </div>
        ) : loadError ? (
          <div className="load-error">
            <p>加载照片失败</p>
            <button className="retry-btn" onClick={() => void fetchPhotos()}>重试</button>
          </div>
        ) : activeTab === "timeline" ? (
          <PhotoGallery
            photos={filteredPhotos}
            onDelete={handleDelete}
            onSubjectUpdate={handleSubjectUpdate}
            onRenamePhoto={handleRenamePhoto}
            onToggleFavorite={handleToggleFavorite}
            onDownloadStateChange={setDownloading}
            userName={user?.displayName}
            showImportantMoments={false}
          />
        ) : activeTab === "moments" ? (
          <PhotoGallery
            photos={importantPhotos}
            onDelete={handleDelete}
            onSubjectUpdate={handleSubjectUpdate}
            onRenamePhoto={handleRenamePhoto}
            onToggleFavorite={handleToggleFavorite}
            onDownloadStateChange={setDownloading}
            userName={user?.displayName}
            showMemoryHighlights={false}
            showImportantMoments={false}
          />
        ) : (
          <FolderView
            key={currentGroupId || "personal"}
            photos={photos}
            onDelete={handleDelete}
            onSubjectUpdate={handleSubjectUpdate}
            onRenamePhoto={handleRenamePhoto}
            onToggleFavorite={handleToggleFavorite}
            onUploadToFolder={handleUploadToFolder}
            uploadProgress={uploadProgress}
            onMovePhoto={handleMovePhoto}
            onRenameFolder={handleRenameFolder}
            onDownloadStateChange={setDownloading}
            userName={user?.displayName}
            contextKey={currentGroupId || "personal"}
          />
        )}
      </main>
    </div>
  );
}

function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="app-splash">
        <div className="app-splash-icon">📷</div>
        <div className="app-splash-title">Cloud Photo</div>
        <div className="app-splash-dots">
          <span /><span /><span />
        </div>
      </div>
    );
  }

  return user ? <AppContent /> : <AuthPage />;
}

function AppWithProvider() {
  return (
    <ToastProvider>
      <AuthProvider>
        <GroupProvider>
          <App />
        </GroupProvider>
      </AuthProvider>
    </ToastProvider>
  );
}

export default AppWithProvider;
