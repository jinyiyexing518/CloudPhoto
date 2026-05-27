import { useState, useEffect, useCallback, useMemo } from "react";
import { listPhotos, uploadPhoto, deletePhoto, movePhotoToFolder, Photo } from "./services/photoApi";
import PhotoGallery from "./components/gallery/PhotoGallery";
import FolderView from "./components/gallery/FolderView";
import FilterBar, { FilterState, emptyFilter } from "./components/gallery/FilterBar";
import GroupSwitcher from "./components/groups/GroupSwitcher";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { GroupProvider, useGroup } from "./contexts/GroupContext";
import AuthPage from "./components/auth/AuthPage";
import AddAdminDialog from "./components/auth/AddAdminDialog";

const SUPER_ADMIN = "zhangchi";
type ViewTab = "timeline" | "folder";

function AppContent() {
  const { user, logout } = useAuth();
  const { currentGroupId } = useGroup();
  const [showAddAdmin, setShowAddAdmin] = useState(false);
  const [activeTab, setActiveTab] = useState<ViewTab>("timeline");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
      setError(null);
      const data = await listPhotos(currentGroupId);
      setPhotos(data);
    } catch {
      setError("Failed to load photos. Make sure the server is running.");
    } finally {
      setLoading(false);
    }
  }, [currentGroupId]);

  useEffect(() => { void fetchPhotos(); }, [fetchPhotos]);

  const handleUploadToFolder = async (files: FileList, folder: string, subject?: string) => {
    const fileArray = Array.from(files);
    setUploadProgress({ done: 0, total: fileArray.length, folder });
    const failed: string[] = [];
    for (let i = 0; i < fileArray.length; i++) {
      try {
        await uploadPhoto(fileArray[i], user?.displayName || undefined, subject || undefined, folder || undefined, currentGroupId || undefined);
      } catch {
        failed.push(fileArray[i].name);
      }
      setUploadProgress({ done: i + 1, total: fileArray.length, folder });
    }
    await fetchPhotos();
    setUploadProgress(null);
    if (failed.length > 0) {
      setError(`上传失败 (${failed.length}/${fileArray.length}): ${failed.join(", ")}`);
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await deletePhoto(name);
      setPhotos((prev) => prev.filter((p) => p.name !== name));
    } catch {
      setError("Failed to delete photo");
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
      // Sync state with actual new blob path
      setPhotos((prev) => prev.map((p) => p.name === name ? { ...p, name: newName, folder: toFolder } : p));
    } catch {
      setError("移动照片失败");
      await fetchPhotos(); // revert on failure
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
        </div>
      </header>

      {showAddAdmin && <AddAdminDialog onClose={() => setShowAddAdmin(false)} />}

      <main className="app-main">
        {/* Tab bar */}
        <div className="view-tabs">
          <button
            className={`view-tab${activeTab === "timeline" ? " active" : ""}`}
            onClick={() => setActiveTab("timeline")}
          >
            🕐 时间线
          </button>
          <button
            className={`view-tab${activeTab === "folder" ? " active" : ""}`}
            onClick={() => setActiveTab("folder")}
          >
            📁 文件夹
          </button>
        </div>

        {/* Timeline hint */}
        {activeTab === "timeline" && (
          <div className="timeline-upload-hint">
            📁 请切换到「<button className="hint-tab-link" onClick={() => setActiveTab("folder")}>文件夹</button>」视图来添加照片
          </div>
        )}

        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => setError(null)}>✕</button>
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
          <div className="loading">Loading photos...</div>
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
            userName={user?.displayName}
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
    <AuthProvider>
      <GroupProvider>
        <App />
      </GroupProvider>
    </AuthProvider>
  );
}

export default AppWithProvider;
