import { useState, useEffect, useCallback, useMemo } from "react";
import { listPhotos, uploadPhoto, deletePhoto, movePhotoToFolder, renameFolderApi, Photo } from "./services/photoApi";
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
type ViewTab = "timeline" | "folder";

function AppContent() {
  const { user, logout } = useAuth();
  const { currentGroupId } = useGroup();
  const showToast = useToast();
  const [showAddAdmin, setShowAddAdmin] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

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
    return stored === "folder" ? "folder" : "timeline";
  });
  const switchTab = (tab: ViewTab) => {
    setActiveTab(tab);
    localStorage.setItem(tabKey, tab);
  };
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number; folder: string } | null>(null);
  const [filters, setFilters] = useState<FilterState>(emptyFilter);

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
      return true;
    });
  }, [photos, filters]);

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

  const handleMovePhoto = async (name: string, toFolder: string) => {
    // Optimistic update (folder display only; name updated after server confirms)
    setPhotos((prev) => prev.map((p) => p.name === name ? { ...p, folder: toFolder } : p));
    try {
      const { newName } = await movePhotoToFolder(name, toFolder, user?.displayName || undefined);
      setPhotos((prev) => prev.map((p) => p.name === name ? { ...p, name: newName, folder: toFolder } : p));
    } catch {
      showToast("移动照片失败", "error");
      await fetchPhotos();
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

  return (
    <div className="app">
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
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {inviteToken && <InviteAcceptPage token={inviteToken} onDone={dismissInvite} />}

      <main className="app-main">
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
        </div>

        {/* Timeline hint */}
        {activeTab === "timeline" && (
          <div className="timeline-upload-hint">
            📁 请切换到「<button className="hint-tab-link" onClick={() => switchTab("folder")}>文件夹</button>」视图来添加照片
          </div>
        )}

        {activeTab === "timeline" && (
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
            <span>Loading photos…</span>
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
            userName={user?.displayName}
          />
        ) : (
          <FolderView
            photos={photos}
            onDelete={handleDelete}
            onSubjectUpdate={handleSubjectUpdate}
            onRenamePhoto={handleRenamePhoto}
            onUploadToFolder={handleUploadToFolder}
            uploadProgress={uploadProgress}
            onMovePhoto={handleMovePhoto}
            onRenameFolder={handleRenameFolder}
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
    return <div className="auth-page"><div className="auth-card"><div className="loading">Loading…</div></div></div>;
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
