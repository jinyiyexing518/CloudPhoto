import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Photo } from "../../services/photoApi";
import { BLANK_GIF } from "@cloudphoto/algorithm";
import { fallbackMediaSource } from "../../services/mediaRoute";

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
  const isVideo = photo.contentType?.startsWith("video/") ?? false;
  const isGif = photo.contentType === "image/gif";
  const isAnimated = photo.isAnimated || isGif;
  // Motion photo = animated JPEG (Android/Google Motion Photo) — browser can't play the video part
  const isMotionPhoto = isAnimated && !isGif &&
    (photo.contentType === "image/jpeg" || photo.contentType === "image/jpg");
  const isHeic = photo.contentType === "image/heic" || photo.contentType === "image/heif" ||
    photo.name.toLowerCase().endsWith(".heic") || photo.name.toLowerCase().endsWith(".heif");
  const derivativeImageSources = [photo.thumbnailUrl, photo.previewUrl]
    .filter((source): source is string => Boolean(source));
  const lowDataImageSources = derivativeImageSources.length > 0
    ? derivativeImageSources
    : isHeic
      ? []
      : [photo.url];
  const lowDataImageSrc = lowDataImageSources[0] ?? BLANK_GIF;
  const staticAnimatedSrc = photo.thumbnailUrl ?? photo.previewUrl ?? BLANK_GIF;
  const videoPosterSources = derivativeImageSources;
  const videoPosterSrc = photo.thumbnailUrl ?? photo.previewUrl;

  const [showConfirm, setShowConfirm] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  // GIF originals can be many MB. Keep the static thumbnail until the user
  // explicitly presses play instead of downloading every visible GIF.
  const [gifPaused, setGifPaused] = useState(isGif);
  const [videoThumbFailed, setVideoThumbFailed] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [gifDisplaySrc, setGifDisplaySrc] = useState<string>(() => staticAnimatedSrc);
  const videoThumbImgRef = useRef<HTMLImageElement>(null);
  const gifImgRef = useRef<HTMLImageElement>(null);
  // Video cards render only server-persisted derivatives. Missing or broken
  // derivatives stay as a local placeholder until the user opens playback.
  const useVideoThumb = isVideo && !!videoPosterSrc && !videoThumbFailed;

  // For video thumbnails served as <img>: if the image is already cached the browser
  // may fire onLoad synchronously before React attaches the handler, so we check
  // img.complete as a safety net whenever the thumbnail URL changes.
  useEffect(() => {
    const el = videoThumbImgRef.current;
    if (useVideoThumb && el?.complete && el.naturalWidth > 0) {
      setImgLoaded(true);
    }
  }, [useVideoThumb, videoPosterSrc]);

  useEffect(() => {
    setVideoThumbFailed(false);
  }, [videoPosterSrc]);

  // Same safety net for animated images (GIFs / motion photos).
  useEffect(() => {
    if (!isAnimated) return;
    const el = gifImgRef.current;
    if (el?.complete && el.naturalWidth > 0) {
      setImgLoaded(true);
    }
  }, [isAnimated, gifPaused, photo.url]);

  useEffect(() => {
    if (!isGif) return;
    setGifDisplaySrc(gifPaused ? staticAnimatedSrc : photo.url);
  }, [gifPaused, isGif, photo.url, staticAnimatedSrc]);

  // Toggle play/pause for GIFs. Uses src-swap instead of canvas
  // to avoid cross-origin (CORS) security errors on Azure SAS URLs.
  const toggleGifPause = (e: React.MouseEvent) => {
    e.stopPropagation();
    setImgLoaded(false);
    setGifPaused((paused) => !paused);
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
        onContextMenu={(e) => {
          e.preventDefault();
          setCtxMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {onSelect !== undefined && (
          <div className={`photo-select-badge${selected ? " photo-select-badge--on" : ""}`}>
            {selected ? "✓" : ""}
          </div>
        )}
        <div className="photo-thumbnail" onClick={onSelect ?? onClick}>
          {!imgLoaded && (!isVideo || useVideoThumb) && <div className="photo-skeleton" />}
          {useVideoThumb ? (
            <img
              ref={videoThumbImgRef}
              src={videoPosterSrc}
              alt={displayName}
              loading="lazy"
              className={imgLoaded ? "img-loaded" : "img-loading"}
              onLoad={() => setImgLoaded(true)}
              onError={(e) => {
                if (!fallbackMediaSource(e.currentTarget, videoPosterSources)) {
                  setVideoThumbFailed(true);
                  setImgLoaded(false);
                }
              }}
            />
          ) : isVideo ? (
            <div
              className="video-thumb-placeholder"
              role="img"
              aria-label={`${displayName} 的视频封面暂不可用`}
            />
          ) : isMotionPhoto ? (
            <img
              ref={gifImgRef}
              src={lowDataImageSrc}
              alt={displayName}
              loading="lazy"
              className={imgLoaded ? "img-loaded" : "img-loading"}
              onLoad={() => setImgLoaded(true)}
              onError={(e) => {
                if (!fallbackMediaSource(e.currentTarget, lowDataImageSources)) setImgLoaded(false);
              }}
            />
          ) : isAnimated ? (
            <img
              ref={gifImgRef}
              src={isGif ? gifDisplaySrc : staticAnimatedSrc}
              alt={displayName}
              loading="lazy"
              className={imgLoaded ? "img-loaded" : "img-loading"}
              onLoad={() => setImgLoaded(true)}
              onError={(e) => {
                const sources = isGif && !gifPaused
                  ? [photo.url]
                  : [photo.thumbnailUrl, photo.previewUrl];
                if (!fallbackMediaSource(e.currentTarget, sources)) setImgLoaded(false);
              }}
            />
          ) : (
            <img
              src={lowDataImageSrc}
              alt={displayName}
              loading="lazy"
              decoding="async"
              className={imgLoaded ? "img-loaded" : "img-loading"}
              onLoad={() => setImgLoaded(true)}
              onError={(e) => {
                // A broken derivative may try the preview and alternate route,
                // but never silently downloads a 20 MB original as fallback.
                if (!fallbackMediaSource(e.currentTarget, lowDataImageSources)) setImgLoaded(false);
              }}
            />
          )}
          {isVideo && <div className="photo-video-badge">▶</div>}
          {isHeic && <div className="photo-format-badge">HEIC</div>}
          {photo.favorite && <div className="photo-favorite-badge" title="已收藏">★</div>}
          {isAnimated && isMotionPhoto && (
            <div className="photo-video-badge">动态照片 📱</div>
          )}
          {isGif && (
            gifPaused ? (
              <>
                <div className="photo-gif-paused-overlay" />
                <div className="gif-play-center">
                  <button type="button" className="gif-play-center-btn" onClick={toggleGifPause} aria-label="继续播放动图" title="继续播放">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="gif-animated-badge">{isGif ? "GIF" : "动图"}</span>
                <button type="button" className="gif-pause-corner-btn" onClick={toggleGifPause} aria-label="暂停动图" title="暂停动图">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                  </svg>
                </button>
              </>
            )
          )}
          {isAnimated && !isMotionPhoto && !isGif && (
            <span className="gif-animated-badge">动图</span>
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
                  type="button"
                  className="move-btn"
                  aria-label="移动照片"
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
                  type="button"
                  className={`favorite-btn${photo.favorite ? " favorite-btn--on" : ""}`}
                  aria-label={photo.favorite ? "取消收藏" : "收藏"}
                  aria-pressed={photo.favorite}
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
                type="button"
                className="delete-btn"
                aria-label="删除照片"
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

      {ctxMenu && createPortal(
        <div className="photo-ctx-backdrop" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}>
          <ul className="photo-ctx-menu" style={{ top: ctxMenu.y, left: ctxMenu.x }} onClick={(e) => e.stopPropagation()}>
            <li className="photo-ctx-item" onClick={() => { setCtxMenu(null); onClick(); }}>🔍 预览</li>
            {onToggleFavorite && (
              <li className="photo-ctx-item" onClick={() => { setCtxMenu(null); onToggleFavorite(!photo.favorite); }}>
                {photo.favorite ? "☆ 取消收藏" : "★ 收藏"}
              </li>
            )}
            <li className="photo-ctx-item" onClick={() => { setCtxMenu(null); window.open(photo.url, "_blank"); }}>⬇ 打开原图</li>
            {onMoveRequest && (
              <li className="photo-ctx-item" onClick={() => { setCtxMenu(null); onMoveRequest(); }}>→ 移动到…</li>
            )}
            <li className="photo-ctx-item photo-ctx-item--danger" onClick={() => { setCtxMenu(null); setShowConfirm(true); }}>🗑 删除</li>
          </ul>
        </div>,
        document.body
      )}
    </>
  );
}

export default memo(PhotoCard);
