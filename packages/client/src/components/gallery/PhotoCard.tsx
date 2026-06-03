import { memo, useRef, useState } from "react";

// 1×1 transparent GIF — used as src placeholder when animation is paused
const BLANK_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
import { createPortal } from "react-dom";
import { Photo } from "../../services/photoApi";

interface Props {
  photo: Photo;
  onClick: () => void;
  onDelete: () => void;
  onMoveRequest?: () => void;
  onToggleFavorite?: (next: boolean) => void;
  /** When defined, card is in selection mode: clicking selects/deselects */
  selected?: boolean;
  onSelect?: (e: React.MouseEvent) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd?: (e: React.DragEvent<HTMLDivElement>) => void;
}

function PhotoCard({
  photo,
  onClick,
  onDelete,
  onMoveRequest,
  onToggleFavorite,
  selected,
  onSelect,
  draggable,
  onDragStart,
  onDragEnd,
}: Props) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [gifPaused, setGifPaused] = useState(false);
  const [videoDuration, setVideoDuration] = useState<string | null>(null);
  const isVideo = photo.contentType?.startsWith("video/") ?? false;
  const isGif = photo.contentType === "image/gif";
  const isAnimated = photo.isAnimated || isGif;
  // Motion photo = animated JPEG (Android/Google Motion Photo) — browser can't play the video part
  const isMotionPhoto = isAnimated && !isGif &&
    (photo.contentType === "image/jpeg" || photo.contentType === "image/jpg");
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleVideoMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    // Seek to 10% of duration (max 2 s) to get a representative thumbnail frame
    v.currentTime = Math.min(2, v.duration * 0.1);
    // Format duration
    const secs = Math.round(v.duration);
    if (isFinite(secs)) {
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      setVideoDuration(`${m}:${String(s).padStart(2, "0")}`);
    }
  };
  const handleVideoSeeked = () => setImgLoaded(true);

  // Toggle play/pause for animated images. Uses src-swap instead of canvas
  // to avoid cross-origin (CORS) security errors on Azure SAS URLs.
  const toggleGifPause = (e: React.MouseEvent) => {
    e.stopPropagation();
    setGifPaused(prev => !prev);
  };
  const basename = photo.name.split("/").pop() ?? photo.name;
  const displayName = photo.originalName || basename.replace(/^\d+-/, "");
  const uploadTime = photo.createdAt
    ? new Date(photo.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : null;
  const takenTime = photo.takenAt
    ? new Date(photo.takenAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : null;
  // Show taken date if it's different from upload date (or if upload date unknown)
  const showTakenDate = takenTime && takenTime !== uploadTime;

  return (
    <>
      <div
        className={`photo-card${selected ? " photo-card--selected" : ""}${draggable ? " photo-card--draggable" : ""}`}
        onClick={onSelect}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        title={displayName}
      >
        {onSelect !== undefined && (
          <div className={`photo-select-badge${selected ? " photo-select-badge--on" : ""}`}>
            {selected ? "✓" : ""}
          </div>
        )}
        <div className="photo-thumbnail" onClick={onSelect ?? onClick}>
          {!imgLoaded && <div className="photo-skeleton" />}
          {isVideo ? (
            <video
              ref={videoRef}
              src={photo.url}
              className={imgLoaded ? "img-loaded" : "img-loading"}
              preload="metadata"
              muted
              playsInline
              onLoadedMetadata={handleVideoMetadata}
              onSeeked={handleVideoSeeked}
            />
          ) : isAnimated ? (
            <img
              src={gifPaused ? BLANK_GIF : photo.url}
              alt={displayName}
              loading="eager"
              decoding="async"
              className={imgLoaded ? "img-loaded" : "img-loading"}
              onLoad={() => setImgLoaded(true)}
            />
          ) : (
            <img
              src={photo.url}
              alt={displayName}
              loading="lazy"
              decoding="async"
              className={imgLoaded ? "img-loaded" : "img-loading"}
              onLoad={() => setImgLoaded(true)}
            />
          )}
          {isVideo && <div className="photo-video-badge">▶{videoDuration ? ` ${videoDuration}` : ""}</div>}
          {isAnimated && isMotionPhoto && (
            <div className="photo-video-badge">动态照片 📱</div>
          )}
          {isAnimated && !isMotionPhoto && (
            gifPaused ? (
              <>
                <div className="photo-gif-paused-overlay" />
                <div className="gif-play-center">
                  <button className="gif-play-center-btn" onClick={toggleGifPause} title="继续播放">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="gif-animated-badge">GIF</span>
                <button className="gif-pause-corner-btn" onClick={toggleGifPause} title="暂停动图">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                  </svg>
                </button>
              </>
            )
          )}
        </div>
        <div className="photo-info">
          <span className="photo-name" title={displayName}>
            {displayName}
          </span>
          {!onSelect && (
            <>
              {onMoveRequest && (
                <button
                  className="move-btn"
                  title="移动照片"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMoveRequest();
                  }}
                >
                  →
                </button>
              )}
              {onToggleFavorite && (
                <button
                  className={`favorite-btn${photo.favorite ? " favorite-btn--on" : ""}`}
                  title={photo.favorite ? "取消收藏" : "收藏"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFavorite(!photo.favorite);
                  }}
                >
                  ★
                </button>
              )}
              <button
                className="delete-btn"
                title="删除照片"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowConfirm(true);
                }}
              >
                🗑
              </button>
            </>
          )}
        </div>
        {(uploadTime || takenTime || photo.createdBy || photo.subject) && (
          <div className="photo-meta">
            {photo.subject && <span className="photo-subject-tag">{photo.subject}</span>}
            {photo.createdBy && <span className="photo-meta-by">👤 {photo.createdBy}</span>}
            {showTakenDate && <span className="photo-meta-taken" title="拍摄时间">📷 {takenTime}</span>}
            {uploadTime && !showTakenDate && <span className="photo-meta-date">{uploadTime}</span>}
          </div>
        )}
      </div>

      {showConfirm && createPortal(
        <div className="confirm-overlay" onClick={() => setShowConfirm(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-title">删除照片？</p>
            <p className="confirm-filename">{displayName}</p>
            <div className="confirm-actions">
              <button className="confirm-cancel-btn" onClick={() => setShowConfirm(false)}>
                取消
              </button>
              <button
                className="confirm-delete-btn"
                onClick={() => {
                  setShowConfirm(false);
                  onDelete();
                }}
              >
                删除
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

export default memo(PhotoCard);
