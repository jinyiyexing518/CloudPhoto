import { useRef, useState } from "react";
import { Photo, updatePhotoSubject } from "../../services/photoApi";
import PhotoCard from "./PhotoCard";

const UNCATEGORIZED = "(未分类)";

interface Props {
  photos: Photo[];
  onDelete: (name: string) => void;
  onSubjectUpdate: (name: string, subject: string) => void;
  onUploadToFolder: (files: FileList, folder: string, subject?: string) => Promise<void>;
  uploadProgress: { done: number; total: number; folder: string } | null;
  onMovePhoto: (name: string, toFolder: string) => Promise<void>;
  userName?: string;
}

export default function FolderView({
  photos,
  onDelete,
  onSubjectUpdate,
  onUploadToFolder,
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

