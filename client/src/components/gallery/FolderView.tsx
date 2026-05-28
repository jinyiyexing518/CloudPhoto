import { useRef, useState, useEffect, useCallback } from "react";
import {
  Photo,
  updatePhotoSubject,
  renamePhoto as apiRenamePhoto,
  downloadPhotoApi,
} from "../../services/photoApi";
import PhotoCard from "./PhotoCard";
import { useToast } from "../../contexts/ToastContext";

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
  onRename,
}: {
  name: string;
  count: number;
  onClick: () => void;
  onDrop?: (photoName: string, fromFolder: string) => void;
  onRename?: (newName: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState(name);
  const dragCount = useRef(0);

  const confirmRename = () => {
    const trimmed = editVal.trim();
    if (trimmed && trimmed !== name && onRename) onRename(trimmed);
    setEditing(false);
  };

  return (
    <div
      className={`folder-card${dragOver ? " folder-card--dragover" : ""}`}
      onClick={() => { if (!editing) onClick(); }}
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
      {editing ? (
        <input
          autoFocus
          className="folder-card-rename-input"
          value={editVal}
          onChange={(e) => setEditVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); confirmRename(); }
            if (e.key === "Escape") { setEditVal(name); setEditing(false); }
          }}
          onBlur={confirmRename}
          onClick={(e) => e.stopPropagation()}
          maxLength={60}
        />
      ) : (
        <div className="folder-card-name">{name || UNCATEGORIZED}</div>
      )}
      <div className="folder-card-count">{count} 张</div>
      {onRename && !editing && (
        <button
          className="folder-card-rename-btn"
          title="重命名文件夹"
          onClick={(e) => { e.stopPropagation(); setEditVal(name); setEditing(true); }}
        >
          ✏️
        </button>
      )}
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
  onMovePhoto: (name: string, toFolder: string) => Promise<boolean>;
  onRenameFolder?: (oldFolder: string, newFolder: string) => Promise<void>;
  userName?: string;
  /** Unique key for localStorage persistence (e.g. groupId or "personal") */
  contextKey?: string;
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
  onRenameFolder,
  userName,
  contextKey = "personal",
}: Props) {
  const showToast = useToast();
  const [currentPath, setCurrentPath] = useState<string | null>(null); // null = root
  const [extraFolders, setExtraFolders] = useState<string[]>([]);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  // Restore extra (empty) folders and last-visited path from localStorage when context changes
  useEffect(() => {
    const stored = localStorage.getItem(`cf_xf_${contextKey}`);
    try { setExtraFolders(stored ? (JSON.parse(stored) as string[]) : []); } catch { setExtraFolders([]); }
    // null = root (key absent), "" = uncategorised, "folderName" = folder
    const storedPath = localStorage.getItem(`cf_path_${contextKey}`);
    setCurrentPath(storedPath !== null ? storedPath : null);
  }, [contextKey]);

  // Persist extra folders whenever they change
  useEffect(() => {
    localStorage.setItem(`cf_xf_${contextKey}`, JSON.stringify(extraFolders));
  }, [extraFolders, contextKey]);

  // Persist current path whenever it changes
  useEffect(() => {
    if (currentPath === null) {
      localStorage.removeItem(`cf_path_${contextKey}`);
    } else {
      localStorage.setItem(`cf_path_${contextKey}`, currentPath);
    }
  }, [currentPath, contextKey]);

  // Remove extra folders that now have real photos (they’re no longer "empty")
  useEffect(() => {
    const photoFolderSet = new Set(photos.map((p) => p.folder?.trim() ?? ""));
    setExtraFolders((prev) => {
      const cleaned = prev.filter((f) => !photoFolderSet.has(f));
      return cleaned.length === prev.length ? prev : cleaned;
    });
  }, [photos]);

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
    if (name.includes("/")) { showToast("文件夹名不能包含 /", "error"); return; }
    const fullPath = currentPath === null ? name : (currentPath === "" ? name : `${currentPath}/${name}`);
    setExtraFolders((prev) => (prev.includes(fullPath) ? prev : [...prev, fullPath]));
    setNewFolderName("");
    setCreatingFolder(false);
  };

  const handleRenameFolder = async (oldName: string, newName: string) => {
    if (!newName.trim() || newName === oldName) return;
    const oldFull = fullFolderPath(oldName);
    const newFull = fullFolderPath(newName.trim());
    // Update localStorage path if we're currently inside (or below) the renamed folder
    try {
      await onRenameFolder?.(oldFull, newFull);
      // Update extraFolders paths
      setExtraFolders((prev) =>
        prev.map((f) =>
          f === oldFull ? newFull :
          f.startsWith(oldFull + "/") ? newFull + f.slice(oldFull.length) : f
        )
      );
      // Navigate to new path if currently inside renamed folder
      if (currentPath !== null && (currentPath === oldFull || currentPath.startsWith(oldFull + "/"))) {
        const newPath = newFull + currentPath.slice(oldFull.length);
        setCurrentPath(newPath);
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : "重命名失败", "error");
    }
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

  const moveByDragWithToast = async (photoName: string, fromFolder: string, toFolder: string) => {
    if (fromFolder === toFolder) return;
    const ok = await onMovePhoto(photoName, toFolder);
    if (ok) {
      showToast(`已移动到「${toFolder || UNCATEGORIZED}」`, "success");
    }
  };

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
              onDrop={(photoName, fromFolder) => {
                void moveByDragWithToast(photoName, fromFolder, "");
              }}
            />
          )}
          {subFolders.map((name) => (
            <FolderCard
              key={name}
              name={name}
              count={countPhotosUnder(photos, name)}
              onClick={() => navigateTo(name)}
              onDrop={(photoName, fromFolder) => {
                void moveByDragWithToast(photoName, fromFolder, name);
              }}
              onRename={onRenameFolder ? (newName) => void handleRenameFolder(name, newName) : undefined}
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
            void moveByDragWithToast(photoName, fromFolder, target);
          }}
          countPhotos={(subName) => countPhotosUnder(photos, fullFolderPath(subName))}
          allFolderPaths={allFolderPaths}
          onDelete={onDelete}
          onSubjectUpdate={onSubjectUpdate}
          onRenamePhoto={onRenamePhoto}
          onUploadToFolder={onUploadToFolder}
          uploadProgress={uploadProgress}
          onMovePhoto={onMovePhoto}
          onRenameSubFolder={onRenameFolder ? (sub, newSub) => void handleRenameFolder(sub, newSub) : undefined}
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
  onMovePhoto: (name: string, toFolder: string) => Promise<boolean>;
  onRenameSubFolder?: (subName: string, newSubName: string) => void;
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
  onRenameSubFolder,
  userName,
}: ContentProps) {
  const showToast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCount = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadSubject, setUploadSubject] = useState("");

  // Modal state
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
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

  // Batch selection
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchMoveTo, setBatchMoveTo] = useState(MOVE_UNSELECTED);
  const exitSelectMode = () => { setSelectMode(false); setSelected(new Set()); setBatchMoveTo(MOVE_UNSELECTED); };
  const allSelected = selected.size > 0 && selected.size === directPhotos.length;
  const toggleSelectAll = () => {
    if (allSelected) { setSelected(new Set()); } else { setSelected(new Set(directPhotos.map((p) => p.name))); }
  };
  const [showBatchConfirm, setShowBatchConfirm] = useState(false);

  // Navigate to a photo by index, resetting all edit state
  const navigateToPhoto = useCallback((idx: number, photoList: Photo[]) => {
    const photo = photoList[idx];
    if (!photo) return;
    setSelectedIdx(idx);
    setSelectedPhoto(photo);
    setEditingSubject(false);
    setSubjectInput(photo.subject ?? "");
    setEditingName(false);
    setNameInput(photo.originalName || (photo.name.split("/").pop() ?? photo.name).replace(/^\d+-/, ""));
    setShowMovePanel(false);
    setMovingTo(MOVE_UNSELECTED);
    setDownloading(false);
  }, []);

  // Keyboard navigation when modal is open
  useEffect(() => {
    if (selectedIdx === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setSelectedIdx(null); setSelectedPhoto(null); }
      if (e.key === "ArrowLeft" && selectedIdx > 0) navigateToPhoto(selectedIdx - 1, directPhotos);
      if (e.key === "ArrowRight" && selectedIdx < directPhotos.length - 1) navigateToPhoto(selectedIdx + 1, directPhotos);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedIdx, directPhotos, navigateToPhoto]);
  const toggleSelect = (name: string) => {
    setSelected((prev) => { const next = new Set(prev); next.has(name) ? next.delete(name) : next.add(name); return next; });
  };
  const handleBatchDelete = () => { for (const name of selected) onDelete(name); showToast(`已删除 ${selected.size} 张照片`, "success"); exitSelectMode(); setShowBatchConfirm(false); };
  const handleBatchMove = async () => {
    if (batchMoveTo === MOVE_UNSELECTED) return;
    const count = selected.size;
    await Promise.all([...selected].map((name) => onMovePhoto(name, batchMoveTo)));
    showToast(`已移动 ${count} 张照片`, "success");
    exitSelectMode();
  };

  const openModal = (photo: Photo) => {
    const idx = directPhotos.findIndex((p) => p.name === photo.name);
    setSelectedIdx(idx >= 0 ? idx : null);
    setSelectedPhoto(photo);
    setEditingSubject(false);
    setSubjectInput(photo.subject ?? "");
    setEditingName(false);
    setNameInput(photo.originalName || (photo.name.split("/").pop() ?? photo.name).replace(/^\d+-/, ""));
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
    setSelectedIdx(null);
    setSelectedPhoto(null);
  };

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    await onUploadToFolder(e.target.files, currentPath, uploadSubject || undefined);
    e.target.value = "";
  };

  const displayName = (p: Photo) => {
    if (p.originalName) return p.originalName;
    const basename = p.name.split("/").pop() ?? p.name;
    return basename.replace(/^\d+-/, "");
  };

  const moveByDragWithToast = async (photoName: string, fromFolder: string, toFolder: string) => {
    if (fromFolder === toFolder) return;
    const ok = await onMovePhoto(photoName, toFolder);
    if (ok) {
      showToast(`已移动到「${toFolder || UNCATEGORIZED}」`, "success");
    }
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
        if (name) void moveByDragWithToast(name, from, currentPath);
      }}
    >
      <div className="photo-grid folder-section-grid">
        {/* Batch toolbar */}
        {directPhotos.length > 0 && (
          <div className="gallery-batch-toolbar" style={{ gridColumn: "1 / -1" }}>
            <button
              className={`batch-select-btn${selectMode ? " active" : ""}`}
              onClick={() => { setSelectMode((v) => !v); setSelected(new Set()); }}
            >
              {selectMode ? `取消选择` : "批量选择"}
            </button>
            {selectMode && (
              <button className="batch-select-btn" onClick={toggleSelectAll}>
                {allSelected ? "取消全选" : "全选"}
              </button>
            )}
            {selectMode && <span className="batch-count">已选 {selected.size} 张</span>}
            {selectMode && selected.size > 0 && (
              <>
                <button className="batch-delete-btn" onClick={() => setShowBatchConfirm(true)}>删除 ({selected.size})</button>
                <select
                  className="modal-move-select"
                  value={batchMoveTo}
                  onChange={(e) => setBatchMoveTo(e.target.value)}
                >
                  <option value={MOVE_UNSELECTED}>移动到…</option>
                  {allFolderPaths.map((f) => (
                    <option key={f} value={f}>{f === "" ? "(未分类)" : f}</option>
                  ))}
                </select>
                {batchMoveTo !== MOVE_UNSELECTED && (
                  <button className="batch-select-btn" onClick={() => void handleBatchMove()}>确认移动</button>
                )}
              </>
            )}
            {/* Quick upload button — always visible in toolbar so user doesn't need to scroll */}
            <button
              className="batch-select-btn"
              style={{ marginLeft: "auto", opacity: anyUploading ? 0.5 : 1 }}
              onClick={() => !anyUploading && inputRef.current?.click()}
              title="上传照片到当前文件夹"
            >
              {isMyUpload && uploadProgress
                ? `⏳ ${uploadProgress.done}/${uploadProgress.total}`
                : "+ 添加照片"}
            </button>
          </div>
        )}
        {/* Sub-folder cards first */}
        {subFolders.map((sub) => (
          <FolderCard
            key={sub}
            name={sub}
            count={countPhotos(sub)}
            onClick={() => onNavigate(sub)}
            onDrop={(photoName, fromFolder) => onDropToSubFolder(photoName, fromFolder, sub)}
            onRename={onRenameSubFolder ? (newSub) => onRenameSubFolder(sub, newSub) : undefined}
          />
        ))}

        {/* Photos */}
        {directPhotos.map((photo) => (
          <PhotoCard
            key={photo.name}
            photo={photo}
            onClick={() => !selectMode && openModal(photo)}
            onDelete={() => onDelete(photo.name)}
            selected={selectMode ? selected.has(photo.name) : undefined}
            onSelect={selectMode ? (e) => { e.stopPropagation(); toggleSelect(photo.name); } : undefined}
            draggable={!selectMode}
            onDragStart={(e) => {
              e.dataTransfer.setData("photoName", photo.name);
              e.dataTransfer.setData("fromFolder", currentPath);
              e.dataTransfer.effectAllowed = "move";
            }}
          />
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
        <div className="modal-overlay" onClick={() => { setSelectedIdx(null); setSelectedPhoto(null); }}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => { setSelectedIdx(null); setSelectedPhoto(null); }}>✕</button>
            {/* Prev / Next navigation */}
            {selectedIdx !== null && selectedIdx > 0 && (
              <button
                className="modal-nav modal-nav--prev"
                onClick={() => navigateToPhoto(selectedIdx - 1, directPhotos)}
                title="上一张 (←)"
              >
                ‹
              </button>
            )}
            {selectedIdx !== null && selectedIdx < directPhotos.length - 1 && (
              <button
                className="modal-nav modal-nav--next"
                onClick={() => navigateToPhoto(selectedIdx + 1, directPhotos)}
                title="下一张 (→)"
              >
                ›
              </button>
            )}
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
                    <button className="modal-rename-btn" title="重命名" onClick={() => setEditingName(true)}>✏ 重命名</button>
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
            {directPhotos.length > 1 && (
              <div className="modal-nav-hint">\u2190 \u2192 \u952e\u5207\u6362 \u00b7 Esc \u5173\u95ed</div>
            )}
          </div>
        </div>
      )}

      {/* Batch delete confirmation */}
      {showBatchConfirm && (
        <div className="confirm-overlay" onClick={() => setShowBatchConfirm(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-title">确认删除 {selected.size} 张照片？</p>
            <p className="confirm-filename">此操作不可撤销</p>
            <div className="confirm-actions">
              <button className="confirm-cancel-btn" onClick={() => setShowBatchConfirm(false)}>取消</button>
              <button className="confirm-delete-btn" onClick={handleBatchDelete}>删除</button>
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

