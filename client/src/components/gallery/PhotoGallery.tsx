import { useState } from "react";
import { Photo, updatePhotoSubject } from "../../services/photoApi";
import PhotoCard from "./PhotoCard";

interface Props {
  photos: Photo[];
  onDelete: (name: string) => void;
  onSubjectUpdate: (name: string, subject: string) => void;
  userName?: string;
}

interface DateGroup {
  key: string;       // YYYY-MM-DD
  label: string;     // "May 25, 2026"
  photos: Photo[];
}

function groupByDate(photos: Photo[]): DateGroup[] {
  const map = new Map<string, Photo[]>();

  for (const photo of photos) {
    const raw = photo.createdAt ?? photo.lastModified;
    const date = raw ? new Date(raw) : new Date(0);
    const key = date.toISOString().slice(0, 10); // YYYY-MM-DD
    const bucket = map.get(key) ?? [];
    bucket.push(photo);
    map.set(key, bucket);
  }

  // Sort groups newest first
  const groups: DateGroup[] = Array.from(map.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, groupPhotos]) => ({
      key,
      label: new Date(key + "T12:00:00").toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
      photos: groupPhotos,
    }));

  return groups;
}

export default function PhotoGallery({ photos, onDelete, onSubjectUpdate, userName }: Props) {
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [editingSubject, setEditingSubject] = useState(false);
  const [subjectInput, setSubjectInput] = useState("");
  const [savingSubject, setSavingSubject] = useState(false);

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

  if (photos.length === 0) {
    return (
      <div className="empty-gallery">
        <p>No photos yet. Upload some photos to get started!</p>
      </div>
    );
  }

  const groups = groupByDate(photos);

  return (
    <>
      {groups.map((group) => (
        <section key={group.key} className="date-group">
          <h2 className="date-group-label">
            <span className="date-group-dot" />
            {group.label}
            <span className="date-group-count">{group.photos.length}</span>
          </h2>
          <div className="photo-grid">
            {group.photos.map((photo) => (
              <PhotoCard
                key={photo.name}
                photo={photo}
                onClick={() => openModal(photo)}
                onDelete={() => onDelete(photo.name)}
              />
            ))}
          </div>
        </section>
      ))}

      {selectedPhoto && (
        <div
          className="modal-overlay"
          onClick={() => setSelectedPhoto(null)}
        >
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close"
              onClick={() => setSelectedPhoto(null)}
            >
              ✕
            </button>
            <img src={selectedPhoto.url} alt={selectedPhoto.name} />
            <div className="modal-info">
              <div className="modal-info-row">
                <span className="modal-filename">
                  {selectedPhoto.originalName || selectedPhoto.name.replace(/^\d+-/, "")}
                </span>
                <span className="modal-size">{formatSize(selectedPhoto.size)}</span>
              </div>
              <div className="modal-detail-grid">
                <span className="modal-detail-label">Subject</span>
                <span className="modal-detail-value modal-subject-cell">
                  {editingSubject ? (
                    <>
                      <input
                        autoFocus
                        className="modal-subject-input"
                        value={subjectInput}
                        onChange={(e) => setSubjectInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void saveSubject(); if (e.key === "Escape") setEditingSubject(false); }}
                        placeholder="Add subject..."
                        maxLength={80}
                      />
                      <button className="modal-subject-save" onClick={() => void saveSubject()} disabled={savingSubject}>
                        {savingSubject ? "..." : "Save"}
                      </button>
                      <button className="modal-subject-cancel" onClick={() => setEditingSubject(false)}>✕</button>
                    </>
                  ) : (
                    <>
                      <span>{selectedPhoto.subject || <em className="modal-empty">None</em>}</span>
                      <button className="modal-edit-btn" onClick={() => setEditingSubject(true)}>✏</button>
                    </>
                  )}
                </span>

                <span className="modal-detail-label">Created by</span>
                <span className="modal-detail-value">{selectedPhoto.createdBy ?? "—"}</span>

                <span className="modal-detail-label">Uploaded at</span>
                <span className="modal-detail-value">{selectedPhoto.createdAt ? formatDate(selectedPhoto.createdAt) : "—"}</span>

                <span className="modal-detail-label">Last modified by</span>
                <span className="modal-detail-value">{selectedPhoto.lastModifiedBy ?? "—"}</span>

                <span className="modal-detail-label">Last modified at</span>
                <span className="modal-detail-value">
                  {selectedPhoto.lastModifiedAt
                    ? formatDate(selectedPhoto.lastModifiedAt)
                    : selectedPhoto.lastModified
                    ? formatDate(selectedPhoto.lastModified)
                    : "—"}
                </span>

                <span className="modal-detail-label">Type</span>
                <span className="modal-detail-value">{selectedPhoto.contentType ?? "—"}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function formatSize(bytes: number): string {
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
