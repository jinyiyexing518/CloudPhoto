import { Photo } from "../services/photoApi";

interface Props {
  photo: Photo;
  onClick: () => void;
  onDelete: () => void;
}

export default function PhotoCard({ photo, onClick, onDelete }: Props) {
  const displayName = photo.name.replace(/^\d+-/, "");

  return (
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
            if (window.confirm(`Delete "${displayName}"?`)) {
              onDelete();
            }
          }}
        >
          🗑
        </button>
      </div>
    </div>
  );
}
