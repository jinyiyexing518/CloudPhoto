import { useState } from "react";
import { Photo } from "../services/photoApi";
import PhotoCard from "./PhotoCard";

interface Props {
  photos: Photo[];
  onDelete: (name: string) => void;
}

export default function PhotoGallery({ photos, onDelete }: Props) {
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);

  if (photos.length === 0) {
    return (
      <div className="empty-gallery">
        <p>No photos yet. Upload some photos to get started!</p>
      </div>
    );
  }

  return (
    <>
      <div className="photo-grid">
        {photos.map((photo) => (
          <PhotoCard
            key={photo.name}
            photo={photo}
            onClick={() => setSelectedPhoto(photo)}
            onDelete={() => onDelete(photo.name)}
          />
        ))}
      </div>

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
              <span className="modal-filename">
                {selectedPhoto.name.replace(/^\d+-/, "")}
              </span>
              <span>{formatSize(selectedPhoto.size)}</span>
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
