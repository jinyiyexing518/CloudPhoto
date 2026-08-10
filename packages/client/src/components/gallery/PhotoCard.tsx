import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Photo } from "../../services/photoApi";
import { BLANK_GIF, GRID_MEDIA_POLICY_MARKER, selectGridMediaSources } from "@cloudphoto/algorithm";
import { fallbackMediaSource, getPreferredMediaUrl } from "../../services/mediaRoute";
import {
  isLowInformationVideoCoverImage,
  useVideoCoverRepair,
} from "../../services/videoCoverRepair";
import {
  getPhotoCardGroupLabel,
  getPhotoCardPrimaryLabel,
} from "./photoCardAccessibility";

interface Props {
  photo: Photo;
  onClick: () => void;
  onDelete: () => void;
  onMoveRequest?: () => void;
  onToggleFavorite?: (next: boolean) => void;
  /** When defined, card is in selection mode: clicking selects/deselects */
  selected?: boolean;
  onSelect?: (e: React.MouseEvent) => void;
  interactionDisabled?: boolean;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLElement>) => void;
  onDragEnd?: (e: React.DragEvent<HTMLElement>) => void;
  priority?: boolean;
  onThumbnailUpdate?: (photoName: string, thumbnailUrl: string) => void;
}

function PhotoCard({
  photo,
  onClick,
  onDelete,
  onMoveRequest,
  onToggleFavorite,
  selected,
  onSelect,
  interactionDisabled = false,
  draggable,
  onDragStart,
  onDragEnd,
  priority = false,
  onThumbnailUpdate,
}: Props) {
  const isVideo = photo.contentType?.startsWith("video/") ?? false;
  const isGif = photo.contentType === "image/gif";
  const isAnimated = photo.isAnimated || isGif;
  // Motion photo = animated JPEG (Android/Google Motion Photo) — browser can't play the video part
  const isMotionPhoto = isAnimated && !isGif &&
    (photo.contentType === "image/jpeg" || photo.contentType === "image/jpg");
  const isHeic = photo.contentType === "image/heic" || photo.contentType === "image/heif" ||
    photo.name.toLowerCase().endsWith(".heic") || photo.name.toLowerCase().endsWith(".heif");
  const derivativeImageSources = selectGridMediaSources(photo)
    .map(getPreferredMediaUrl);
  const originalImageUrl = getPreferredMediaUrl(photo.url);
  const lowDataImageSources = derivativeImageSources;
  const lowDataImageSrc = lowDataImageSources[0] ?? BLANK_GIF;
  const staticAnimatedSrc = derivativeImageSources[0] ?? BLANK_GIF;
  const { targetRef: videoRepairTargetRef, state: videoRepairState, markDerivativeBroken } =
    useVideoCoverRepair(photo);
  const videoPosterSources = videoRepairState.thumbnailUrl
    ? [videoRepairState.thumbnailUrl]
    : derivativeImageSources;
  const videoPosterSrc = videoPosterSources[0];

  const [showConfirm, setShowConfirm] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  // GIF originals can be many MB. Keep the static thumbnail until the user
  // explicitly presses play instead of downloading every visible GIF.
  const [gifPaused, setGifPaused] = useState(isGif);
  const [videoThumbFailed, setVideoThumbFailed] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [gifDisplaySrc, setGifDisplaySrc] = useState<string>(() => staticAnimatedSrc);
  const videoThumbImgRef = useRef<HTMLImageElement>(null);
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
  const publishedRepairUrlRef = useRef<string | null>(null);
  const gifImgRef = useRef<HTMLImageElement>(null);
  // Video cards render only server-persisted derivatives. Missing or broken
  // derivatives stay as a local placeholder until the user opens playback.
  const useVideoThumb = isVideo && !!videoPosterSrc && !videoThumbFailed;

  useEffect(() => {
    const repairedUrl = videoRepairState.thumbnailUrl;
    if (!repairedUrl || publishedRepairUrlRef.current === repairedUrl) return;
    publishedRepairUrlRef.current = repairedUrl;
    onThumbnailUpdate?.(photo.name, repairedUrl);
  }, [onThumbnailUpdate, photo.name, videoRepairState.thumbnailUrl]);

  useEffect(() => {
    publishedRepairUrlRef.current = null;
  }, [photo.name]);

  // For video thumbnails served as <img>: if the image is already cached the browser
  // may fire onLoad synchronously before React attaches the handler, so we check
  // img.complete as a safety net whenever the thumbnail URL changes.
  useEffect(() => {
    const el = videoThumbImgRef.current;
    if (useVideoThumb && el?.complete && el.naturalWidth > 0) {
      if (isLowInformationVideoCoverImage(el) === true) {
        if (fallbackMediaSource(el, videoPosterSources)) {
          setImgLoaded(false);
          return;
        }
        setVideoThumbFailed(true);
        setImgLoaded(false);
        markDerivativeBroken();
        return;
      }
      setImgLoaded(true);
    }
  }, [markDerivativeBroken, useVideoThumb, videoPosterSrc]);

  useEffect(() => {
    setVideoThumbFailed(false);
    setImgLoaded(false);
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
    setGifDisplaySrc(gifPaused ? staticAnimatedSrc : originalImageUrl);
  }, [gifPaused, isGif, originalImageUrl, staticAnimatedSrc]);

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
  const selectionMode = onSelect !== undefined;
  const mediaType = isVideo
    ? "视频"
    : isGif
      ? "GIF 动图"
      : isMotionPhoto
        ? "动态照片"
        : isAnimated
          ? "动图"
          : "照片";
  const dateLabel = takenTime
    ? `拍摄于 ${takenTime}`
    : uploadTime
      ? `上传于 ${uploadTime}`
      : null;
  const primaryLabel = getPhotoCardPrimaryLabel(
    displayName,
    mediaType,
    dateLabel,
    selectionMode,
    Boolean(selected),
  );
  const primaryAction = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.focus({ preventScroll: true });
    if (onSelect) {
      onSelect(event);
      return;
    }
    onClick();
  };

  return (
    <>
      <article
        className={`photo-card${selected ? " photo-card--selected" : ""}${draggable ? " photo-card--draggable" : ""}`}
        aria-label={getPhotoCardGroupLabel(displayName)}
        aria-disabled={interactionDisabled || undefined}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        title={displayName}
        onContextMenu={(e) => {
          e.preventDefault();
          if (interactionDisabled) return;
          setCtxMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {onSelect !== undefined && (
          <div
            className={`photo-select-badge${selected ? " photo-select-badge--on" : ""}`}
            aria-hidden="true"
          >
            {selected ? "✓" : ""}
          </div>
        )}
        <div
          ref={videoRepairTargetRef}
          className="photo-thumbnail"
          data-media-policy={GRID_MEDIA_POLICY_MARKER}
        >
          {!imgLoaded && (!isVideo || useVideoThumb) && <div className="photo-skeleton" />}
          {useVideoThumb ? (
            <img
              ref={videoThumbImgRef}
              crossOrigin="anonymous"
              src={videoPosterSrc}
              alt={displayName}
              loading={priority ? "eager" : "lazy"}
              fetchPriority={priority ? "high" : "auto"}
              className={imgLoaded ? "img-loaded" : "img-loading"}
              onLoad={(event) => {
                if (isLowInformationVideoCoverImage(event.currentTarget) === true) {
                  if (fallbackMediaSource(event.currentTarget, videoPosterSources)) {
                    setImgLoaded(false);
                    return;
                  }
                  setVideoThumbFailed(true);
                  setImgLoaded(false);
                  markDerivativeBroken();
                  return;
                }
                setImgLoaded(true);
              }}
              onError={(e) => {
                if (!fallbackMediaSource(e.currentTarget, videoPosterSources)) {
                  setVideoThumbFailed(true);
                  setImgLoaded(false);
                  markDerivativeBroken();
                }
              }}
            />
          ) : isVideo ? (
           <div
             className="video-thumb-placeholder"
           >
             <span className="video-thumb-placeholder-icon" aria-hidden="true">▶</span>
             <span className="video-thumb-placeholder-text" aria-live="polite">
               {videoRepairState.phase === "queued" || videoRepairState.phase === "repairing"
                 ? "正在生成封面"
                 : "打开视频后生成封面"}
             </span>
           </div>
          ) : isMotionPhoto ? (
            <img
              ref={gifImgRef}
              src={lowDataImageSrc}
              alt={displayName}
              loading={priority ? "eager" : "lazy"}
              fetchPriority={priority ? "high" : "auto"}
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
              loading={priority ? "eager" : "lazy"}
              fetchPriority={priority ? "high" : "auto"}
              className={imgLoaded ? "img-loaded" : "img-loading"}
              onLoad={() => setImgLoaded(true)}
              onError={(e) => {
                const sources = isGif && !gifPaused
                  ? [originalImageUrl]
                  : derivativeImageSources;
                if (!fallbackMediaSource(e.currentTarget, sources)) setImgLoaded(false);
              }}
            />
          ) : (
            <img
              src={lowDataImageSrc}
              alt={displayName}
              loading={priority ? "eager" : "lazy"}
              fetchPriority={priority ? "high" : "auto"}
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
        <button
          ref={primaryButtonRef}
          type="button"
          className="photo-card-primary"
          aria-label={primaryLabel}
          aria-pressed={selectionMode ? Boolean(selected) : undefined}
          disabled={interactionDisabled}
          onClick={primaryAction}
        ></button>
        <div className="photo-info">
          <span className="photo-name" title={displayName}>
            {displayName}
          </span>
          {!onSelect && !interactionDisabled && (
            <>
              {onMoveRequest && (
                <button
                  type="button"
                  className="move-btn"
                  aria-label={`移动照片 ${displayName}`}
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
                  aria-label={`${photo.favorite ? "取消收藏" : "收藏"} ${displayName}`}
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
                aria-label={`删除照片 ${displayName}`}
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
      </article>

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

      {ctxMenu && !interactionDisabled && createPortal(
        <div className="photo-ctx-backdrop" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}>
          <ul className="photo-ctx-menu" style={{ top: ctxMenu.y, left: ctxMenu.x }} onClick={(e) => e.stopPropagation()}>
            <li
              className="photo-ctx-item"
              onClick={() => {
                primaryButtonRef.current?.focus({ preventScroll: true });
                setCtxMenu(null);
                onClick();
              }}
            >
              🔍 预览
            </li>
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
