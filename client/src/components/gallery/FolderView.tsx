import { useRef, useState } from "react";
import {
  Photo,
  updatePhotoSubject,
  renamePhoto as apiRenamePhoto,
  downloadPhotoApi,
} from "../../services/photoApi";
import PhotoCard from "./PhotoCard";

const UNCATEGORIZED = "(未分类)";
const MOVE_UNSELECTED = "__UNSEL__";

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Returns immediate child sub-folder names at the given path level. */
function getImmediateSubFolders(
  photos: Photo[],
  extraFolders: string[],
  currentPath: string | null,
): string[] {
  const set = new Set<string>();
  const allPaths = [
    ...photos.map((p) => p.folder?.trim() ?? ""),
    ...extraFolders,
  ];
  for (const f of allPaths) {
    if (currentPath === null) {
      if (f !== "") set.add(f.split("/")[0]);
    } else if (currentPath !== "" && f.startsWith(currentPath + "/")) {
      const next = f.slice(currentPath.length + 1).split("/")[0];
      if (next) set.add(next);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Count photos directly or recursively under folderPath. */
function countPhotosUnder(photos: Photo[], folderPath: string): number {
  if (folderPath === "") {
    return photos.filter((p) => (p.folder?.trim() ?? "") === "").length;
  }
  return photos.filter((p) => {
    const f = p.folder?.trim() ?? "";
    return f === folderPath || f.startsWith(folderPath + "/");
  }).length;
}

// ─── FolderCard ───────────────────────────────────────────────────────────────

function FolderCard({
  name,
  count,
  onClick,
  onDrop,
}: {
  name: string;
  count: number;
  onClick: () => void;
  onDrop?: (photoName: string, fromFolder: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const dragCount = useRef(0);
  return (
    <div
      className={`folder-card${dragOver ? " folder-card--dragover" : ""}`}
      onClick={onClick}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
      onDragEnter={(e) => { e.preventDefault(); dragCount.current++; setDragOver(true); }}
      onDragLeave={() => { dragCount.current--; if (dragCount.current === 0) setDragOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCount.current = 0;
        setDragOver(false);
        const photoName = e.dataTransfer.getData("photoName");
        const fromFolder = e.dataTransfer.getData("fromFolder");
        if (photoName && onDrop) onDrop(photoName, fromFolder);
      }}
    >
      <div className="folder-card-icon">📁</div>
      <div className="folder-card-name">{name || UNCATEGORIZED}</div>
      <div className="folder-card-count">{count} 张</div>
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  photos: Photo[];
  onDelete: (name: string) => void;
  onSubjectUpdate: (name: string, subject: string) => void;
  onRenamePhoto: (name: string, newOriginalName: string) => void;
  onUploadToFolder: (files: FileList, folder: string, subject?: string) => Promise<void>;
  uploadProgress: { done: number; total: number; folder: string } | null;
  onMovePhoto: (name: string, toFolder: string) => Promise<void>;
  userName?: string;
}

// ─── FolderView (root navigator) ─────────────────────────────────────────────

export default function FolderView({
  photos,
  onDelete,
  onSubjectUpdate,
  onRenamePhoto,
  onUploadToFolder,
  uploadProgress,
  onMovePhoto,
  userName,
}: Props) {
  const [currentPath, setCurrentPath] = useState<string | null>(null); // null = root
  const [extraFolders, setExtraFolders] = useState<string[]>([]);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const subFolders = getImmediateSubFolders(photos, extraFolders, currentPath);
  const hasUncategorized =
    currentPath === null && photos.some((p) => (p.folder?.trim() ?? "") === "");

  // Breadcrumb
  const crumbs: Array<{ label: string; path: string | null }> = [
    { label: "根目录", path: null },
  ];
  if (currentPath !== null) {
    if (currentPath === "") {
      crumbs.push({ label: UNCATEGORIZED, path: "" });
    } else {
      currentPath.split("/").forEach((seg, i, arr) => {
        crumbs.push({ label: seg, path: arr.slice(0, i + 1).join("/") });
      });
    }
  }

  const createFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    if (name.includes("/")) { alert("文件夹名不能包含 /"); return; }
    const fullPath = currentPath === null ? name : (currentPath === "" ? name : `${currentPath}/${name}`);
    setExtraFolders((prev) => (prev.includes(fullPath) ? prev : [...prev, fullPath]));
    setNewFolderName("");
    setCreatingFolder(false);
  };

  const navigateTo = (folderName: string) => {
    if (currentPath === null) {
      setCurrentPath(folderName); // folderName="" for uncategorized
    } else if (currentPath === "") {
      setCurrentPath(folderName);
    } else {
      setCurrentPath(`${currentPath}/${folderName}`);
    }
  };

  const fullFolderPath = (subName: string): string => {
    if (currentPath === null || currentPath === "") return subName;
    return `${currentPath}/${subName}`;
  };

  // All unique folder paths for the "move to" dropdown in the modal
  const allFolderPaths = [
    ...new Set(photos.map((p) => p.folder?.trim() ?? "")),
  ].sort((a, b) => {
    if (a === "") return -1;
    if (b === "") return 1;
    return a.localeCompare(b);
  });

  return (
    <div className="folder-view">
      {/* Breadcrumb */}
      <nav className="folder-breadcrumb" aria-label="folder navigation">
        {crumbs.map((crumb, i) => (
          <span key={i} className="folder-breadcrumb-item">
            {i > 0 && <span className="folder-breadcrumb-sep">›</span>}
            {i < crumbs.length - 1 ? (
              <button
                className="folder-breadcrumb-btn"
                onClick={() => setCurrentPath(crumb.path)}
              >
                {crumb.label}
              </button>
            ) : (
              <span className="folder-breadcrumb-current">{crumb.label}</span>
            )}
          </span>
        ))}
      </nav>

      {/* Toolbar */}
      <div className="folder-view-toolbar">
        {creatingFolder ? (
          <span className="folder-create-row">
            <input
              autoFocus
              className="folder-name-input"
              type="text"
              placeholder="文件夹名称"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createFolder();
                if (e.key === "Escape") setCreatingFolder(false);
              }}
              maxLength={60}
            />
            <button className="folder-create-confirm" onClick={createFolder}>确认</button>
            <button className="folder-create-cancel" onClick={() => setCreatingFolder(false)}>取消</button>
          </span>
        ) : (
          <button className="folder-new-btn" onClick={() => setCreatingFolder(true)}>
            {currentPath === null ? "+ 新建文件夹" : "+ 新建子文件夹"}
          </button>
        )}
      </div>

      {/* Root view: folder cards */}
      {currentPath === null ? (
        <div className="photo-grid folder-section-grid">
          {hasUncategorized && (
            <FolderCard
              name={UNCATEGORIZED}
              count={countPhotosUnder(photos, "")}
              onClick={() => setCurrentPath("")}
            />
          )}
          {subFolders.map((name) => (
            <FolderCard
              key={name}
              name={name}
              count={countPhotosUnder(photos, name)}
              onClick={() => navigateTo(name)}
              onDrop={(photoName, fromFolder) => {
                if (fromFolder !== name) void onMovePhoto(photoName, name);
              }}
            />
          ))}
          {!hasUncategorized && subFolders.length === 0 && (
            <div className="empty-gallery" style={{ gridColumn: "1 / -1" }}>
              还没有文件夹，点击「+ 新建文件夹」开始吧
            </div>
          )}
        </div>
      ) : (
        /* Inside a folder */
        <FolderContent
          currentPath={currentPath}
          subFolders={subFolders}
          directPhotos={photos.filter((p) => (p.folder?.trim() ?? "") === currentPath)}
          onNavigate={navigateTo}
          onDropToSubFolder={(photoName, fromFolder, subFolderName) => {
            const target = fullFolderPath(subFolderName);
            if (fromFolder !== target) void onMovePhoto(photoName, target);
          }}
          countPhotos={(subName) => countPhotosUnder(photos, fullFolderPath(subName))}
          allFolderPaths={allFolderPaths}
          onDelete={onDelete}
          onSubjectUpdate={onSubjectUpdate}
          onRenamePhoto={onRenamePhoto}
          onUploadToFolder={onUploadToFolder}
          uploadProgress={uploadProgress}
          onMovePhoto={onMovePhoto}
          userName={userName}
        />
      )}
    </div>
  );
}

// ─── FolderContent (view inside a single folder) ──────────────────────────────

interface ContentProps {
  currentPath: string;
  subFolders: string[];
  directPhotos: Photo[];
  onNavigate: (subFolderName: string) => void;
  onDropToSubFolder: (photoName: string, fromFolder: string, subFolderName: string) => void;
  countPhotos: (subFolderName: string) => number;
  allFolderPaths: string[];
  onDelete: (name: string) => void;
  onSubjectUpdate: (name: string, subject: string) => void;
  onRenamePhoto: (name: string, newOriginalName: string) => void;
  onUploadToFolder: (files: FileList, folder: string, subject?: string) => Promise<void>;
  uploadProgress: { done: number; total: number; folder: string } | null;
  onMovePhoto: (name: string, toFolder: string) => Promise<void>;
  userName?: string;
}

function FolderContent({
  currentPath,
  subFolders,
  directPhotos,
  onNavigate,
  onDropToSubFolder,
  countPhotos,
  allFolderPaths,
  onDelete,
  onSubjectUpdate,
  onRenamePhoto,
  onUploadToFolder,
  uploadProgress,
  onMovePhoto,
  userName,
}: ContentProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCount = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadSubject, setUploadSubject] = useState("");

  // Modal state
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [editingSubject, setEditingSubject] = useState(false);
  const [subjectInput, setSubjectInput] = useState("");
  const [savingSubject, setSavingSubject] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [showMovePanel, setShowMovePanel] = useState(false);
  const [movingTo, setMovingTo] = useState(MOVE_UNSELECTED);

  const isMyUpload = uploadProgress?.folder === currentPath;
  const anyUploading = uploadProgress !== null;

  const openModal = (photo: Photo) => {
    setSelectedPhoto(photo);
    setEditingSubject(false);
    setSubjectInput(photo.subject ?? "");
    setEditingName(false);
    setNameInput(photo.originalName || photo.name.replace(/^\d+-/, ""));
    setShowMovePanel(false);
    setMovingTo(MOVE_UNSELECTED);
    setDownloading(false);
  };

  const saveSubject = async () => {
    if (!selectedPhoto) return;
    setSavingSubject(true);
    try {
      await updatePhotoSubject(selectedPhoto.name, subjectInput.trim(), userName);
      onSubjectUpdate(selectedPhoto.name, subjectInput.trim());
      setSelectedPhoto({ ...selectedPhoto, subject: subjectInput.trim() });
      setEditingSubject(false);
    } finally {
      setSavingSubject(false);
    }
  };

  const saveName = async () => {
    if (!selectedPhoto) return;
    const trimmed = nameInput.trim();
    if (!trimmed) return;
    setSavingName(true);
    try {
      await apiRenamePhoto(selectedPhoto.name, trimmed, userName);
      onRenamePhoto(selectedPhoto.name, trimmed);
      setSelectedPhoto({ ...selectedPhoto, originalName: trimmed });
      setEditingName(false);
    } finally {
      setSavingName(false);
    }
  };

  const handleDownload = async () => {
    if (!selectedPhoto) return;
    setDownloading(true);
    try {
      const filename = selectedPhoto.originalName || selectedPhoto.name.replace(/^\d+-/, "");
      await downloadPhotoApi(selectedPhoto.name, filename);
    } finally {
      setDownloading(false);
    }
  };

  const handleMove = async () => {
    if (!selectedPhoto || movingTo === MOVE_UNSELECTED) return;
    await onMovePhoto(selectedPhoto.name, movingTo);
    setSelectedPhoto(null);
  };

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    await onUploadToFolder(e.target.files, currentPath, uploadSubject || undefined);
    e.target.value = "";
  };

  const displayName = (p: Photo) => p.originalName || p.name.replace(/^\d+-/, "");

  return (
    <section
      className={`folder-section${isDragOver ? " folder-drag-over" : ""}`}
      style={isDragOver ? { outline: "2px dashed #4a90e2", borderRadius: "8px" } : undefined}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
      onDragEnter={(e) => { e.preventDefault(); dragCount.current++; setIsDragOver(true); }}
      onDragLeave={() => { dragCount.current--; if (dragCount.current === 0) setIsDragOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        dragCount.current = 0;
        setIsDragOver(false);
        const name = e.dataTransfer.getData("photoName");
        const from = e.dataTransfer.getData("fromFolder");
        if (name && from !== currentPath) void onMovePhoto(name, currentPath);
      }}
    >
      <div className="photo-grid folder-section-grid">
        {/* Sub-folder cards first */}
        {subFolders.map((sub) => (
          <FolderCard
            key={sub}
            name={sub}
            count={countPhotos(sub)}
            onClick={() => onNavigate(sub)}
            onDrop={(photoName, fromFolder) => onDropToSubFolder(photoName, fromFolder, sub)}
          />
        ))}

        {/* Photos */}
        {directPhotos.map((photo) => (
          <div
            key={photo.name}
            draggable
            style={{ cursor: "grab" }}
            onDragStart={(e) => {
              e.dataTransfer.setData("photoName", photo.name);
              e.dataTransfer.setData("fromFolder", currentPath);
              e.dataTransfer.effectAllowed = "move";
            }}
          >
            <PhotoCard
              photo={photo}
              onClick={() => openModal(photo)}
              onDelete={() => onDelete(photo.name)}
            />
          </div>
        ))}

        {/* Upload group */}
        <div className="folder-upload-group">
          <input
            className="folder-upload-subject"
            type="text"
            placeholder="主题（可选）"
            value={uploadSubject}
            onChange={(e) => setUploadSubject(e.target.value)}
            maxLength={80}
          />
          <div
            className={`folder-upload-card${anyUploading ? " folder-upload-card--loading" : ""}`}
            onClick={() => !anyUploading && inputRef.current?.click()}
            title="上传到当前文件夹"
            role="button"
          >
            {isMyUpload && uploadProgress ? (
              <>
                <span className="folder-upload-icon">⏳</span>
                <span className="folder-upload-label">{uploadProgress.done}/{uploadProgress.total}</span>
              </>
            ) : (
              <>
                <span className="folder-upload-icon">{anyUploading ? "⏳" : "+"}</span>
                <span className="folder-upload-label">添加照片</span>
              </>
            )}
            <input ref={inputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleFiles} />
          </div>
        </div>

        {subFolders.length === 0 && directPhotos.length === 0 && (
          <div className="empty-gallery" style={{ gridColumn: "1 / -1" }}>
            空文件夹 — 上传照片或创建子文件夹
          </div>
        )}
      </div>

      {/* ── Modal ── */}
      {selectedPhoto && (
        <div className="modal-overlay" onClick={() => setSelectedPhoto(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setSelectedPhoto(null)}>✕</button>
            <img src={selectedPhoto.url} alt={displayName(selectedPhoto)} />
            <div className="modal-info">

              {/* Filename row with rename */}
              <div className="modal-info-row">
                {editingName ? (
                  <span className="modal-subject-cell" style={{ flex: 1 }}>
                    <input
                      autoFocus
                      className="modal-subject-input"
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveName();
                        if (e.key === "Escape") setEditingName(false);
                      }}
                      maxLength={120}
                    />
                    <button className="modal-subject-save" onClick={() => void saveName()} disabled={savingName}>
                      {savingName ? "..." : "保存"}
                    </button>
                    <button className="modal-subject-cancel" onClick={() => setEditingName(false)}>✕</button>
                  </span>
                ) : (
                  <span className="modal-filename">
                    {displayName(selectedPhoto)}
                    <button className="modal-edit-btn" title="重命名" onClick={() => setEditingName(true)}>✏</button>
                  </span>
                )}
                <span className="modal-size">{formatSize(selectedPhoto.size)}</span>
              </div>

              {/* Download button */}
              <button
                className="modal-download-btn"
                onClick={() => void handleDownload()}
                disabled={downloading}
              >
                {downloading ? "⏳ 下载中…" : "⬇ 下载照片"}
              </button>

              <div className="modal-detail-grid">
                {/* Subject */}
                <span className="modal-detail-label">主题</span>
                <span className="modal-detail-value modal-subject-cell">
                  {editingSubject ? (
                    <>
                      <input
                        autoFocus
                        className="modal-subject-input"
                        value={subjectInput}
                        onChange={(e) => setSubjectInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveSubject();
                          if (e.key === "Escape") setEditingSubject(false);
                        }}
                        placeholder="添加主题..."
                        maxLength={80}
                      />
                      <button className="modal-subject-save" onClick={() => void saveSubject()} disabled={savingSubject}>
                        {savingSubject ? "..." : "保存"}
                      </button>
                      <button className="modal-subject-cancel" onClick={() => setEditingSubject(false)}>✕</button>
                    </>
                  ) : (
                    <>
                      <span>{selectedPhoto.subject || <em className="modal-empty">无</em>}</span>
                      <button className="modal-edit-btn" onClick={() => setEditingSubject(true)}>✏</button>
                    </>
                  )}
                </span>

                {/* Folder + move */}
                <span className="modal-detail-label">文件夹</span>
                <span className="modal-detail-value modal-subject-cell">
                  {showMovePanel ? (
                    <>
                      <select
                        className="modal-move-select"
                        value={movingTo}
                        onChange={(e) => setMovingTo(e.target.value)}
                      >
                        <option value={MOVE_UNSELECTED} disabled>— 选择目标文件夹 —</option>
                        <option value="">{UNCATEGORIZED}</option>
                        {allFolderPaths.filter((fp) => fp !== "" && fp !== currentPath).map((fp) => (
                          <option key={fp} value={fp}>{fp}</option>
                        ))}
                      </select>
                      <button
                        className="modal-subject-save"
                        onClick={() => void handleMove()}
                        disabled={movingTo === MOVE_UNSELECTED}
                      >
                        移动
                      </button>
                      <button className="modal-subject-cancel" onClick={() => setShowMovePanel(false)}>✕</button>
                    </>
                  ) : (
                    <>
                      <span>{selectedPhoto.folder || UNCATEGORIZED}</span>
                      <button className="modal-edit-btn" title="移动到其他文件夹" onClick={() => setShowMovePanel(true)}>→</button>
                    </>
                  )}
                </span>

                <span className="modal-detail-label">上传者</span>
                <span className="modal-detail-value">{selectedPhoto.createdBy ?? "—"}</span>
                <span className="modal-detail-label">上传时间</span>
                <span className="modal-detail-value">{selectedPhoto.createdAt ? formatDate(selectedPhoto.createdAt) : "—"}</span>
                <span className="modal-detail-label">最后修改者</span>
                <span className="modal-detail-value">{selectedPhoto.lastModifiedBy ?? "—"}</span>
                <span className="modal-detail-label">最后修改时间</span>
                <span className="modal-detail-value">
                  {selectedPhoto.lastModifiedAt
                    ? formatDate(selectedPhoto.lastModifiedAt)
                    : selectedPhoto.lastModified
                    ? formatDate(selectedPhoto.lastModified)
                    : "—"}
                </span>
                <span className="modal-detail-label">格式</span>
                <span className="modal-detail-value">{selectedPhoto.contentType ?? "—"}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatSize(bytes: number | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string | Date): string {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

  uploadProgress,
  onMovePhoto,
  userName,
}: Props) {
  const fromPhotos = [...new Set(photos.map((p) => p.folder?.trim() || ""))];
  const [extraFolders, setExtraFolders] = useState<string[]>([]);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const allFolderNames = [...new Set([...fromPhotos, ...extraFolders])].sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });

  const createFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    if (!allFolderNames.includes(name)) setExtraFolders((prev) => [...prev, name]);
    setNewFolderName("");
    setCreatingFolder(false);
  };

  return (
    <div className="folder-view">
      <div className="folder-view-toolbar">
        {creatingFolder ? (
          <span className="folder-create-row">
            <input
              autoFocus
              className="folder-name-input"
              type="text"
              placeholder="文件夹名称"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createFolder();
                if (e.key === "Escape") setCreatingFolder(false);
              }}
              maxLength={60}
            />
            <button className="folder-create-confirm" onClick={createFolder}>确认</button>
            <button className="folder-create-cancel" onClick={() => setCreatingFolder(false)}>取消</button>
          </span>
        ) : (
          <button className="folder-new-btn" onClick={() => setCreatingFolder(true)}>+ 新建文件夹</button>
        )}
      </div>

      {allFolderNames.length === 0 && (
        <div className="empty-gallery">还没有文件夹，点击「+ 新建文件夹」开始吧</div>
      )}

      {allFolderNames.map((folder) => (
        <FolderSection
          key={folder || UNCATEGORIZED}
          folderName={folder || UNCATEGORIZED}
          folderKey={folder}
          photos={photos.filter((p) => (p.folder?.trim() || "") === folder)}
          onDelete={onDelete}
          onSubjectUpdate={onSubjectUpdate}
          onUploadToFolder={onUploadToFolder}
          uploadProgress={uploadProgress}
          onMovePhoto={onMovePhoto}
          userName={userName}
        />
      ))}
    </div>
  );
}

/* ─── Folder Section ─── */

interface SectionProps {
  folderName: string;
  folderKey: string;
  photos: Photo[];
  onDelete: (name: string) => void;
  onSubjectUpdate: (name: string, subject: string) => void;
  onUploadToFolder: (files: FileList, folder: string, subject?: string) => Promise<void>;
  uploadProgress: { done: number; total: number; folder: string } | null;
  onMovePhoto: (name: string, toFolder: string) => Promise<void>;
  userName?: string;
}

function FolderSection({
  folderName, folderKey, photos,
  onDelete, onSubjectUpdate, onUploadToFolder, uploadProgress, onMovePhoto, userName,
}: SectionProps) {
  const isMyUpload = uploadProgress?.folder === folderKey;
  const anyUploading = uploadProgress !== null;
  const dragCount = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [editingSubject, setEditingSubject] = useState(false);
  const [subjectInput, setSubjectInput] = useState("");
  const [savingSubject, setSavingSubject] = useState(false);
  const [uploadSubject, setUploadSubject] = useState("");

  const openModal = (photo: Photo) => {
    setSelectedPhoto(photo);
    setEditingSubject(false);
    setSubjectInput(photo.subject ?? "");
  };

  const saveSubject = async () => {
    if (!selectedPhoto) return;
    setSavingSubject(true);
    try {
      await updatePhotoSubject(selectedPhoto.name, subjectInput.trim(), userName);
      onSubjectUpdate(selectedPhoto.name, subjectInput.trim());
      setSelectedPhoto({ ...selectedPhoto, subject: subjectInput.trim() });
      setEditingSubject(false);
    } finally {
      setSavingSubject(false);
    }
  };

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    await onUploadToFolder(e.target.files, folderKey, uploadSubject || undefined);
    e.target.value = "";
  };

  return (
    <section
      className={`folder-section${isDragOver ? " folder-drag-over" : ""}`}
      style={isDragOver ? { outline: "2px dashed #4a90e2", borderRadius: "8px" } : undefined}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
      onDragEnter={(e) => { e.preventDefault(); dragCount.current++; setIsDragOver(true); }}
      onDragLeave={() => { dragCount.current--; if (dragCount.current === 0) setIsDragOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        dragCount.current = 0;
        setIsDragOver(false);
        const name = e.dataTransfer.getData("photoName");
        const from = e.dataTransfer.getData("fromFolder");
        if (name && from !== folderKey) void onMovePhoto(name, folderKey);
      }}
    >
      <div className="folder-section-header" onClick={() => setCollapsed((v) => !v)}>
        <span className="folder-icon">{collapsed ? "📁" : "📂"}</span>
        <span className="folder-section-name">{folderName}</span>
        <span className="folder-section-count">{photos.length} 张</span>
        <span className="folder-chevron">{collapsed ? "▶" : "▼"}</span>
      </div>

      {!collapsed && (
        <div className="photo-grid folder-section-grid">
          {photos.map((photo) => (
            <div
              key={photo.name}
              draggable
              style={{ cursor: "grab" }}
              onDragStart={(e) => {
                e.dataTransfer.setData("photoName", photo.name);
                e.dataTransfer.setData("fromFolder", folderKey);
                e.dataTransfer.effectAllowed = "move";
              }}
            >
              <PhotoCard
                photo={photo}
                onClick={() => openModal(photo)}
                onDelete={() => onDelete(photo.name)}
              />
            </div>
          ))}

          {/* Subject input + upload card */}
          <div className="folder-upload-group">
            <input
              className="folder-upload-subject"
              type="text"
              placeholder="主题（可选）"
              value={uploadSubject}
              onChange={(e) => setUploadSubject(e.target.value)}
              maxLength={80}
            />
            <div
              className={`folder-upload-card${anyUploading ? " folder-upload-card--loading" : ""}`}
              onClick={() => !anyUploading && inputRef.current?.click()}
              title={`上传到 ${folderName}`}
              role="button"
            >
              {isMyUpload && uploadProgress ? (
                <>
                  <span className="folder-upload-icon">⏳</span>
                  <span className="folder-upload-label">{uploadProgress.done}/{uploadProgress.total}</span>
                </>
              ) : (
                <>
                  <span className="folder-upload-icon">{anyUploading ? "⏳" : "+"}</span>
                  <span className="folder-upload-label">添加照片</span>
                </>
              )}
              <input ref={inputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleFiles} />
            </div>
          </div>
        </div>
      )}

      {/* Modal (same as PhotoGallery) */}
      {selectedPhoto && (
        <div className="modal-overlay" onClick={() => setSelectedPhoto(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setSelectedPhoto(null)}>✕</button>
            <img src={selectedPhoto.url} alt={selectedPhoto.originalName ?? selectedPhoto.name} />
            <div className="modal-info">
              <div className="modal-info-row">
                <span className="modal-filename">{selectedPhoto.originalName || selectedPhoto.name.replace(/^\d+-/, "")}</span>
                <span className="modal-size">{formatSize(selectedPhoto.size)}</span>
              </div>
              <div className="modal-detail-grid">
                <span className="modal-detail-label">Subject</span>
                <span className="modal-detail-value modal-subject-cell">
                  {editingSubject ? (
                    <>
                      <input autoFocus className="modal-subject-input" value={subjectInput}
                        onChange={(e) => setSubjectInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void saveSubject(); if (e.key === "Escape") setEditingSubject(false); }}
                        placeholder="Add subject..." maxLength={80} />
                      <button className="modal-subject-save" onClick={() => void saveSubject()} disabled={savingSubject}>{savingSubject ? "..." : "Save"}</button>
                      <button className="modal-subject-cancel" onClick={() => setEditingSubject(false)}>✕</button>
                    </>
                  ) : (
                    <>
                      <span>{selectedPhoto.subject || <em className="modal-empty">None</em>}</span>
                      <button className="modal-edit-btn" onClick={() => setEditingSubject(true)}>✏</button>
                    </>
                  )}
                </span>
                <span className="modal-detail-label">Folder</span>
                <span className="modal-detail-value">{folderName}</span>
                <span className="modal-detail-label">Created by</span>
                <span className="modal-detail-value">{selectedPhoto.createdBy ?? "—"}</span>
                <span className="modal-detail-label">Uploaded at</span>
                <span className="modal-detail-value">{selectedPhoto.createdAt ? formatDate(selectedPhoto.createdAt) : "—"}</span>
                <span className="modal-detail-label">Last modified by</span>
                <span className="modal-detail-value">{selectedPhoto.lastModifiedBy ?? "—"}</span>
                <span className="modal-detail-label">Last modified at</span>
                <span className="modal-detail-value">{selectedPhoto.lastModifiedAt ? formatDate(selectedPhoto.lastModifiedAt) : selectedPhoto.lastModified ? formatDate(selectedPhoto.lastModified) : "—"}</span>
                <span className="modal-detail-label">Type</span>
                <span className="modal-detail-value">{selectedPhoto.contentType ?? "—"}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function formatSize(bytes: number | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string | Date): string {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

