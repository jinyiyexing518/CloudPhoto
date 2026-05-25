import { useState } from "react";
import { Photo } from "../../services/photoApi";

interface Props {
  photo: Photo;
  onClick: () => void;
  onDelete: () => void;
}

export default function PhotoCard({ photo, onClick, onDelete }: Props) {
  const [showConfirm, setShowConfirm] = useState(false);
  const displayName = photo.originalName || photo.name.replace(/^\d+-/, "");
  const uploadTime = photo.createdAt
    ? new Date(photo.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : photo.lastModified
    ? new Date(photo.lastModified).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : null;

  return (
    <>
      <div className="photo-card">
        <div className="photo-thumbnail" onClick={onClick}>
          <img src={photo.url} alt={displayName} loading="lazy" />
        </div>
        <div className="photo-info">
          <span className="photo-name" title={displayName}>
            {displayName}
          </span>
          <button
            className="delete-btn"
            title="Delete photo"
            onClick={(e) => {
              e.stopPropagation();
              setShowConfirm(true);
            }}
          >
            🗑
          </button>
        </div>
        {(uploadTime || photo.createdBy || photo.subject) && (
          <div className="photo-meta">
            {photo.subject && <span className="photo-subject-tag">{photo.subject}</span>}
            {photo.createdBy && <span className="photo-meta-by">👤 {photo.createdBy}</span>}
            {uploadTime && <span className="photo-meta-date">{uploadTime}</span>}
          </div>
        )}
      </div>

      {showConfirm && (
        <div className="confirm-overlay" onClick={() => setShowConfirm(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-title">Delete photo?</p>
            <p className="confirm-filename">{displayName}</p>
            <div className="confirm-actions">
              <button className="confirm-cancel-btn" onClick={() => setShowConfirm(false)}>
                Cancel
              </button>
              <button
                className="confirm-delete-btn"
                onClick={() => {
                  setShowConfirm(false);
                  onDelete();
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
