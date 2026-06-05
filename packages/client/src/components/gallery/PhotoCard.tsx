import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Photo } from "../../services/photoApi";
import { setVideoThumbnail } from "../../services/uploadApi";
import {
  BLANK_GIF,
  VIDEO_THUMB_RANGE_BYTES,
  VIDEO_THUMB_MAX_WIDTH,
  VIDEO_THUMB_PRELOAD_MARGIN,
  THUMB_QUALITY_FRACTION,
} from "@cloudphoto/algorithm";

// Per-session dedup: avoid re-uploading a thumbnail for the same video twice
const _thumbnailedInSession = new Set<string>();

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
  const [videoThumbFailed, setVideoThumbFailed] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const isVideo = photo.contentType?.startsWith("video/") ?? false;
  const isGif = photo.contentType === "image/gif";
  const isAnimated = photo.isAnimated || isGif;
  // Motion photo = animated JPEG (Android/Google Motion Photo) — browser can't play the video part
  const isMotionPhoto = isAnimated && !isGif &&
    (photo.contentType === "image/jpeg" || photo.contentType === "image/jpg");
  const isHeic = photo.contentType === "image/heic" || photo.contentType === "image/heif" ||
    photo.name.toLowerCase().endsWith(".heic") || photo.name.toLowerCase().endsWith(".heif");
  // GIF progressive loading: show static thumbnail immediately, upgrade to full GIF in background
  const [gifDisplaySrc, setGifDisplaySrc] = useState<string>(() =>
    isAnimated && !isMotionPhoto && photo.thumbnailUrl ? photo.thumbnailUrl : photo.url
  );
  const gifPreloadDone = useRef(false);
  // Range-fetch src for videos: starts as full URL, replaced with a 512 KB partial blob URL
  // once the card enters the viewport. Falls back to full URL if Range is not supported.
  const [videoThumbSrc, setVideoThumbSrc] = useState<string>(() => photo.url);
  const videoBlobRef = useRef<string | null>(null);
  const videoThumbImgRef = useRef<HTMLImageElement>(null);
  const gifImgRef = useRef<HTMLImageElement>(null);
  // Show static thumbnail for videos that already have one (generated client-side at upload).
  // Fall back to <video> seek approach if no thumbnail or if the thumbnail 404s.
  const useVideoThumb = isVideo && !!photo.thumbnailUrl && !videoThumbFailed;
  const videoRef = useRef<HTMLVideoElement>(null);

  // For video thumbnails served as <img>: if the image is already cached the browser
  // may fire onLoad synchronously before React attaches the handler, so we check
  // img.complete as a safety net whenever the thumbnail URL changes.
  useEffect(() => {
    const el = videoThumbImgRef.current;
    if (useVideoThumb && el?.complete && el.naturalWidth > 0) {
      setImgLoaded(true);
    }
  }, [useVideoThumb, photo.thumbnailUrl]);

  // Same safety net for animated images (GIFs / motion photos). We also clear
  // imgLoaded when the GIF src is swapped to BLANK_GIF so the skeleton doesn't
  // re-appear; the blank GIF onLoad restores imgLoaded immediately anyway.
  useEffect(() => {
    if (!isAnimated || gifPaused) return;
    const el = gifImgRef.current;
    if (el?.complete && el.naturalWidth > 0) {
      setImgLoaded(true);
    }
  }, [isAnimated, gifPaused, photo.url]);

  // GIF progressive load: wait until the card is actually visible in viewport,
  // THEN fetch the full animated file in the background.
  //
  // IMPORTANT: only fire for traditional GIFs (image/gif).
  // Phone animated photos — animated WebP, HEIC live photos, short-video
  // formats from Vivo/Xiaomi/Oppo — can be 2-20 MB per file.  Preloading
  // every visible one simultaneously would burn 20-200 MB of mobile data
  // just for gallery cards.  For these formats the gallery shows the static
  // thumbnail; the full animation is visible when the user opens the viewer.
  useEffect(() => {
    if (!isGif || !isAnimated || isMotionPhoto || !photo.thumbnailUrl || gifPreloadDone.current) return;
    const el = gifImgRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        observer.disconnect();
        if (gifPreloadDone.current) return;
        const img = new Image();
        img.onload = () => {
          gifPreloadDone.current = true;
          setGifDisplaySrc(photo.url);
        };
        img.src = photo.url;
      },
      { rootMargin: "100px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAnimated, isMotionPhoto, photo.thumbnailUrl, photo.url]);

  // Reset Range-fetch state whenever the SAS URL renews
  useEffect(() => {
    if (videoBlobRef.current) {
      URL.revokeObjectURL(videoBlobRef.current);
      videoBlobRef.current = null;
    }
    setVideoThumbSrc(photo.url);
  }, [photo.url]);

  // With preload="none" the video element needs a manual load() call once it enters
  // the viewport before metadata is available.
  // Uses HTTP Range: bytes=0-524287 (512 KB) so only the first slice of the file is
  // fetched. For faststart-encoded MP4s (moov at start — default on iOS/Android) this
  // is sufficient to decode metadata + extract the first frame, cutting download size
  // from 10-200 MB (full video) to a maximum of 512 KB per card.
  // NOTE: deps include useVideoThumb so the observer is (re-)registered whenever we
  // switch from the <img> thumbnail path to the <video> seek-fallback path (e.g. after
  // the thumbnail image 404s and videoThumbFailed flips to true).
  useEffect(() => {
    if (!isVideo || useVideoThumb) return; // <img> is handling it; no <video> in DOM
    const el = videoRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        observer.disconnect();
        // Range-fetch first 512 KB to extract a thumbnail frame.
        // IMPORTANT: .load() is only called when the blob was successfully
        // created.  Calling it unconditionally (e.g. in .finally()) would
        // trigger a full video download when:
        //   a) the Range fetch fails (network error) — src stays as photo.url
        //   b) the fallback path below — src is reset to photo.url
        // For non-faststart MP4 a full download means the browser streams the
        // entire file (10-200 MB) looking for the moov atom at the end.
        void fetch(photo.url, { headers: { Range: `bytes=0-${VIDEO_THUMB_RANGE_BYTES}` } })
          .then(async (res) => {
            if (res.status === 206 || res.ok) {
              const blob = await res.blob();
              const url = URL.createObjectURL(blob);
              videoBlobRef.current = url;
              setVideoThumbSrc(url);
              // rAF: wait for React to commit the updated src before load()
              requestAnimationFrame(() => { videoRef.current?.load(); });
            }
            // Range not supported or error status: leave src as photo.url but
            // do NOT call load() — that would download the full video.
          })
          .catch(() => { /* network error: show placeholder, no download */ });
      },
      { rootMargin: VIDEO_THUMB_PRELOAD_MARGIN },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      // Revoke the partial blob URL now that the card is unmounting or the
      // photo URL has changed.  This is the correct place to release the
      // memory — NOT inside handleVideoSeeked which fires before unmount.
      if (videoBlobRef.current) {
        URL.revokeObjectURL(videoBlobRef.current);
        videoBlobRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideo, useVideoThumb, photo.url]);

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
  const handleVideoSeeked = () => {
    setImgLoaded(true);    // Partial blob URL no longer needed after frame is drawn — free the memory
    if (videoBlobRef.current) {
      URL.revokeObjectURL(videoBlobRef.current);
      videoBlobRef.current = null;
    }    // Auto-save the extracted frame as the server thumbnail (fire-and-forget).
    // After this, future page loads use the fast <img> path instead of downloading the video.
    const v = videoRef.current;
    if (!v || _thumbnailedInSession.has(photo.name)) return;
    _thumbnailedInSession.add(photo.name);
    try {
      const scale = Math.min(1, VIDEO_THUMB_MAX_WIDTH / (v.videoWidth || VIDEO_THUMB_MAX_WIDTH));
      const w = Math.round((v.videoWidth || VIDEO_THUMB_MAX_WIDTH) * scale);
      const h = Math.round((v.videoHeight || 300) * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")?.drawImage(v, 0, 0, w, h);
      canvas.toBlob((blob) => {
        if (blob) void setVideoThumbnail(photo.name, blob);
      }, "image/webp", THUMB_QUALITY_FRACTION);
    } catch { /* best-effort */ }
  };

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
          {!imgLoaded && <div className="photo-skeleton" />}
          {useVideoThumb ? (
            <img
              ref={videoThumbImgRef}
              src={photo.thumbnailUrl}
              alt={displayName}
              loading="lazy"
              className={imgLoaded ? "img-loaded" : "img-loading"}
              onLoad={() => setImgLoaded(true)}
              onError={() => { setVideoThumbFailed(true); setImgLoaded(false); }}
            />
          ) : isVideo ? (
            <video
              ref={videoRef}
              src={videoThumbSrc}
              className={imgLoaded ? "img-loaded" : "img-loading"}
              preload="none"
              muted
              playsInline
              onLoadedMetadata={handleVideoMetadata}
              onSeeked={handleVideoSeeked}
              onError={() => {
                // The 512 KB partial blob couldn't be decoded — typically a
                // non-faststart MP4 where the moov atom is at the END of the
                // file and is not included in our range slice.
                // Do NOT fall back to loading the full video URL: that would
                // silently download the entire file (10-200 MB) just to
                // capture one gallery thumbnail, burning mobile data.
                // The thumbnail will be generated next time the user opens
                // the viewer and plays the video (saved server-side after that).
                if (videoBlobRef.current) {
                  URL.revokeObjectURL(videoBlobRef.current);
                  videoBlobRef.current = null;
                }
                // imgLoaded stays false → skeleton placeholder remains
              }}
            />
          ) : isMotionPhoto ? (
            <img
              ref={gifImgRef}
              src={photo.thumbnailUrl ?? photo.url}
              alt={displayName}
              loading="lazy"
              className={imgLoaded ? "img-loaded" : "img-loading"}
              onLoad={() => setImgLoaded(true)}
              onError={(e) => {
                if (photo.thumbnailUrl && e.currentTarget.src !== photo.url) {
                  e.currentTarget.src = photo.url;
                }
              }}
            />
          ) : isAnimated ? (
            <img
              ref={gifImgRef}
              src={gifPaused ? BLANK_GIF : gifDisplaySrc}
              alt={displayName}
              loading="lazy"
              className={imgLoaded ? "img-loaded" : "img-loading"}
              onLoad={() => setImgLoaded(true)}
            />
          ) : (
            <img
              src={photo.thumbnailUrl ?? photo.url}
              alt={displayName}
              loading="lazy"
              decoding="async"
              className={imgLoaded ? "img-loaded" : "img-loading"}
              onLoad={() => setImgLoaded(true)}
              onError={(e) => {
                // If thumbnail 404s (e.g. generation failed), fall back to full-res
                if (photo.thumbnailUrl && e.currentTarget.src !== photo.url) {
                  e.currentTarget.src = photo.url;
                }
              }}
            />
          )}
          {isVideo && <div className="photo-video-badge">▶{videoDuration ? ` ${videoDuration}` : ""}</div>}
          {isHeic && <div className="photo-format-badge">HEIC</div>}
          {photo.favorite && <div className="photo-favorite-badge" title="已收藏">★</div>}
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
                <span className="gif-animated-badge">{isGif ? "GIF" : "动图"}</span>
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
