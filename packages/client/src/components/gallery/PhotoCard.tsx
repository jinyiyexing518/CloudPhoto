import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Photo } from "../../services/photoApi";
import { BLANK_GIF, GRID_MEDIA_POLICY_MARKER, selectGridMediaSources } from "@cloudphoto/algorithm";
import { useAuth } from "../../contexts/AuthContext";
import {
  fallbackMediaSource,
  getMediaCandidates,
  getPreferredMediaUrl,
  promoteSuccessfulMediaUrl,
} from "../../services/mediaRoute";
import {
  isLowInformationVideoCoverImage,
  useVideoCoverRepair,
} from "../../services/videoCoverRepair";
import {
  getPhotoActionLabel,
  getPhotoCardGroupLabel,
  getPhotoDisplayName,
  getPhotoMediaKind,
  getPhotoPrimaryActionLabel,
  type PhotoCardLabelInput,
} from "./photoCardAccessibility";
import {
  getPhotoContextMenuPosition,
  openPhotoOriginal,
} from "./photoCardContextMenu";
import { formatPhotoDate } from "../../utils/dateFormat";
import { focusMenuItem, handleMenuKeyDown } from "../shared/menuKeyboard";
import { useModalFocusBoundary } from "../shared/useModalFocusBoundary";

const COVER_LOAD_DEADLINE_MS = 8_000;
const COVER_SOURCE_ATTEMPT_MAX_MS = 4_000;

function withCoverRequestState(
  source: string,
  retryKey: number,
  coverDerivative: boolean,
): string {
  if (source.startsWith("blob:") || source.startsWith("data:")) {
    return source;
  }
  const requestState = [
    ...(coverDerivative ? ["cf_cover=1"] : []),
    ...(retryKey > 0 ? [`cf_cover_retry=${retryKey}`] : []),
  ];
  if (requestState.length === 0) return source;
  const hashIndex = source.indexOf("#");
  const base = hashIndex >= 0 ? source.slice(0, hashIndex) : source;
  const hash = hashIndex >= 0 ? source.slice(hashIndex) : "";
  return `${base}${base.includes("?") ? "&" : "?"}${requestState.join("&")}${hash}`;
}

interface Props {
  photo: Photo;
  onClick: () => void;
  onDelete: () => void | Promise<void>;
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
  const { user } = useAuth();
  const isVideo = photo.contentType?.startsWith("video/") ?? false;
  const isAudio = photo.contentType?.startsWith("audio/") ?? false;
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
  const [deletePending, setDeletePending] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [imageRetryKey, setImageRetryKey] = useState(0);
  const [coverAttempt, setCoverAttempt] = useState({ context: "", index: 0 });
  // GIF originals can be many MB. Keep the static thumbnail until the user
  // explicitly presses play instead of downloading every visible GIF.
  const [gifPaused, setGifPaused] = useState(isGif);
  const [videoThumbFailed, setVideoThumbFailed] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const coverImageRef = useRef<HTMLImageElement>(null);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const confirmLayerRef = useRef<HTMLDivElement>(null);
  const confirmDialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const deleteDialogTriggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const mountedRef = useRef(true);
  const publishedRepairUrlRef = useRef<string | null>(null);
  // Video cards render only server-persisted derivatives. Missing or broken
  // derivatives stay as a local placeholder until the user opens playback.
  const useVideoThumb = isVideo && !!videoPosterSrc && !videoThumbFailed;
  const retryVideoPosterSources = videoPosterSources.map((source) =>
    withCoverRequestState(source, imageRetryKey, true));
  const retryVideoPosterSrc = retryVideoPosterSources[0];
  const retryLowDataImageSources = lowDataImageSources.map((source) =>
    withCoverRequestState(source, imageRetryKey, true));
  const retryDerivativeImageSources = derivativeImageSources.map((source) =>
    withCoverRequestState(source, imageRetryKey, true));
  const retryOriginalImageUrl = withCoverRequestState(originalImageUrl, imageRetryKey, false);
  const retryStaticAnimatedSrc = withCoverRequestState(staticAnimatedSrc, imageRetryKey, true);
  const retryGifDisplaySrc = gifPaused
    ? retryStaticAnimatedSrc
    : retryOriginalImageUrl;
  const selectionMode = onSelect !== undefined;
  const gifInteractionBlocked = selectionMode || interactionDisabled;
  const gifUsesOriginal = isGif && !gifPaused && !gifInteractionBlocked;
  const coverDeadlineSources = isAudio || (isVideo && !useVideoThumb) || gifUsesOriginal
    ? null
    : useVideoThumb
      ? retryVideoPosterSources
      : isAnimated
        ? retryDerivativeImageSources
        : retryLowDataImageSources;
  const coverDeadlineCandidates = coverDeadlineSources
    ? getMediaCandidates(coverDeadlineSources)
    : [];
  const coverDeadlineEnabled = coverDeadlineSources !== null;
  const coverDeadlineSourceKey = coverDeadlineCandidates.join("\n");
  const coverLoadContext = [
    user?.id ?? "anonymous",
    user?.role ?? "none",
    photo.name,
    String(imageRetryKey),
    coverDeadlineSourceKey,
  ].join("\n");
  const coverLoadContextRef = useRef(coverLoadContext);
  coverLoadContextRef.current = coverLoadContext;
  const coverAttemptIndex = coverAttempt.context === coverLoadContext
    ? coverAttempt.index
    : 0;
  const coverAttemptSource = coverDeadlineCandidates[coverAttemptIndex];
  const coverAttemptTimeoutMs = Math.min(
    COVER_SOURCE_ATTEMPT_MAX_MS,
    Math.floor(COVER_LOAD_DEADLINE_MS / Math.max(coverDeadlineCandidates.length, 1)),
  );
  const coverAttemptElementKey = [
    coverLoadContext,
    String(coverAttemptIndex),
  ].join("\n");

  useEffect(() => {
    const repairedUrl = videoRepairState.thumbnailUrl;
    if (!repairedUrl || publishedRepairUrlRef.current === repairedUrl) return;
    publishedRepairUrlRef.current = repairedUrl;
    onThumbnailUpdate?.(photo.name, repairedUrl);
  }, [onThumbnailUpdate, photo.name, videoRepairState.thumbnailUrl]);

  useEffect(() => {
    publishedRepairUrlRef.current = null;
  }, [photo.name]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setVideoThumbFailed(false);
    setImgLoaded(false);
    setImgFailed(false);
  }, [videoPosterSrc]);

  useEffect(() => {
    setImgLoaded(false);
    setImgFailed(false);
  }, [lowDataImageSrc, staticAnimatedSrc, originalImageUrl]);

  const photoCoverFailed = imgFailed && !isVideo && !isAudio;
  const markImageLoaded = useCallback(() => {
    setImgFailed(false);
    setImgLoaded(true);
  }, []);
  const markImageFailed = useCallback(() => {
    setImgLoaded(false);
    setImgFailed(true);
  }, []);
  const markCoverFailed = useCallback(() => {
    if (isVideo) {
      markDerivativeBroken();
      setVideoThumbFailed(true);
      setImgLoaded(false);
      return;
    }
    markImageFailed();
  }, [isVideo, markDerivativeBroken, markImageFailed]);

  useEffect(() => {
    const element = coverImageRef.current;
    const expectedSource = coverAttemptSource;
    if (!element || !coverDeadlineEnabled) return;
    if (!expectedSource) {
      markCoverFailed();
      return;
    }

    const context = coverLoadContext;
    let active = true;
    let timeoutId: number | undefined;
    const contextIsCurrent = () => (
      active
      && mountedRef.current
      && coverLoadContextRef.current === context
      && coverImageRef.current === element
    );
    const clearAttempt = () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      timeoutId = undefined;
      element.removeEventListener("load", handleLoad);
      element.removeEventListener("error", handleError);
    };
    const advanceOrFail = () => {
      if (!contextIsCurrent()) return;
      clearAttempt();
      if (coverAttemptIndex + 1 >= coverDeadlineCandidates.length) {
        markCoverFailed();
        return;
      }
      setImgLoaded(false);
      setImgFailed(false);
      setCoverAttempt((current) => {
        const currentIndex = current.context === context ? current.index : 0;
        if (coverLoadContextRef.current !== context || currentIndex !== coverAttemptIndex) {
          return current;
        }
        return { context, index: coverAttemptIndex + 1 };
      });
    };
    const handleLoad = () => {
      if (!contextIsCurrent()) return;
      clearAttempt();
      if (
        isVideo
        && isLowInformationVideoCoverImage(element) === true
      ) {
        markDerivativeBroken();
        advanceOrFail();
        return;
      }
      promoteSuccessfulMediaUrl(expectedSource);
      markImageLoaded();
    };
    const handleError = () => advanceOrFail();

    element.addEventListener("load", handleLoad);
    element.addEventListener("error", handleError);
    timeoutId = window.setTimeout(
      advanceOrFail,
      coverAttemptTimeoutMs,
    );
    if (element.complete && element.naturalWidth > 0) {
      void Promise.resolve().then(handleLoad);
    }

    return () => {
      active = false;
      clearAttempt();
    };
  }, [
    coverAttemptIndex,
    coverAttemptSource,
    coverAttemptTimeoutMs,
    coverDeadlineEnabled,
    coverDeadlineSourceKey,
    coverLoadContext,
    isVideo,
    markCoverFailed,
    markDerivativeBroken,
    markImageLoaded,
  ]);

  const retryImage = () => {
    setImgLoaded(false);
    setImgFailed(false);
    setImageRetryKey((current) => current + 1);
  };
  // Toggle play/pause for GIFs. Uses src-swap instead of canvas
  // to avoid cross-origin (CORS) security errors on Azure SAS URLs.
  const toggleGifPause = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (gifInteractionBlocked) return;
    setImgLoaded(false);
    setGifPaused((paused) => !paused);
  };
  const displayName = getPhotoDisplayName(photo.name, photo.originalName);
  const uploadTime = photo.createdAt
    ? formatPhotoDate(photo.createdAt)
    : null;
  const takenTime = photo.takenAt
    ? formatPhotoDate(photo.takenAt)
    : null;
  // Show taken date if it's different from upload date (or if upload date unknown)
  const showTakenDate = takenTime && takenTime !== uploadTime;
  const labelInput: PhotoCardLabelInput = {
    displayName,
    isVideo,
    mediaKind: getPhotoMediaKind(photo),
    favorite: !!photo.favorite,
    takenDate: takenTime,
    uploadDate: uploadTime,
    selectionMode,
    selected: !!selected,
  };
  const groupLabel = getPhotoCardGroupLabel(labelInput);
  const primaryActionLabel = photoCoverFailed
    ? `重试加载 ${displayName} 封面`
    : getPhotoPrimaryActionLabel(labelInput);
  const descriptionId = useId();
  const deleteDialogTitleId = useId();
  const deleteDialogDescriptionId = useId();
  const videoRepairStatus = videoRepairState.phase === "queued" || videoRepairState.phase === "repairing"
    ? "正在生成封面"
    : "打开视频后生成封面";
  const primaryDescriptionIds = [
    photo.subject ? `${descriptionId}-subject` : null,
    photo.createdBy ? `${descriptionId}-creator` : null,
    isVideo && !useVideoThumb ? `${descriptionId}-video-status` : null,
    photoCoverFailed ? `${descriptionId}-cover-status` : null,
  ].filter(Boolean).join(" ");

  const requestCloseDeleteDialog = useCallback(() => {
    if (deletePending) return false;
    setShowConfirm(false);
    return true;
  }, [deletePending]);

  useModalFocusBoundary({
    active: showConfirm,
    layerRef: confirmLayerRef,
    containerRef: confirmDialogRef,
    initialFocusRef: cancelButtonRef,
    restoreFocusTo: deleteDialogTriggerRef.current,
    onEscape: requestCloseDeleteDialog,
  });

  const handleConfirmDelete = async () => {
    if (deletePending) return;
    setDeletePending(true);
    try {
      await onDelete();
      if (mountedRef.current) setShowConfirm(false);
    } finally {
      if (mountedRef.current) setDeletePending(false);
    }
  };

  const restorePrimaryFocus = () => {
    if (primaryActionRef.current?.isConnected) {
      primaryActionRef.current.focus({ preventScroll: true });
    }
  };

  const closeContextMenu = (restoreFocus = true) => {
    if (restoreFocus) restorePrimaryFocus();
    setCtxMenu(null);
  };

  const contextMenuActions = [
    {
      key: "preview",
      icon: "🔍",
      label: "预览",
      run: onClick,
    },
    ...(onToggleFavorite ? [{
      key: "favorite",
      icon: photo.favorite ? "☆" : "★",
      label: photo.favorite ? "取消收藏" : "收藏",
      run: () => onToggleFavorite(!photo.favorite),
    }] : []),
    {
      key: "original",
      icon: "⬇",
      label: "打开原图",
      run: () => openPhotoOriginal(photo.url),
    },
    ...(onMoveRequest ? [{
      key: "move",
      icon: "→",
      label: "移动到…",
      run: onMoveRequest,
    }] : []),
    {
      key: "delete",
      icon: "🗑",
      label: "删除",
      danger: true,
      run: () => {
        deleteDialogTriggerRef.current = primaryActionRef.current;
        setShowConfirm(true);
      },
    },
  ];

  const activateContextMenuAction = (run: () => void) => {
    if (primaryActionRef.current?.isConnected) {
      primaryActionRef.current.focus({ preventScroll: true });
    }
    setCtxMenu(null);
    run();
  };

  const openContextMenu = (
    clientX: number,
    clientY: number,
    anchor: HTMLElement,
  ) => {
    if (interactionDisabled || selectionMode) return;
    setCtxMenu(getPhotoContextMenuPosition({
      clientX,
      clientY,
      anchorRect: anchor.getBoundingClientRect(),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      itemCount: contextMenuActions.length,
    }));
  };

  useEffect(() => {
    if (!ctxMenu) return;
    const frame = window.requestAnimationFrame(() => {
      focusMenuItem(menuRef.current, "first");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ctxMenu]);

  useEffect(() => {
    if (isGif && gifInteractionBlocked) setGifPaused(true);
  }, [gifInteractionBlocked, isGif]);

  useEffect(() => {
    if (!ctxMenu || (!interactionDisabled && !selectionMode)) return;
    closeContextMenu();
  }, [ctxMenu, interactionDisabled, selectionMode]);

  const handlePrimaryAction = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (interactionDisabled) return;
    event.currentTarget.focus({ preventScroll: true });
    if (selectionMode) {
      onSelect?.(event);
    } else if (photoCoverFailed) {
      retryImage();
    } else {
      onClick();
    }
  };

  return (
    <>
      <div
        className={`photo-card${selected ? " photo-card--selected" : ""}${draggable ? " photo-card--draggable" : ""}`}
        role="group"
        aria-label={groupLabel}
        aria-disabled={interactionDisabled || undefined}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        title={displayName}
        onContextMenu={(e) => {
          e.preventDefault();
          if (interactionDisabled || selectionMode) return;
          openContextMenu(e.clientX, e.clientY, e.currentTarget);
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
        <button
          ref={primaryActionRef}
          type="button"
          className="photo-card-primary"
          aria-label={primaryActionLabel}
          aria-describedby={primaryDescriptionIds || undefined}
          aria-pressed={selectionMode ? !!selected : undefined}
          aria-haspopup={!selectionMode && !interactionDisabled ? "menu" : undefined}
          aria-expanded={!selectionMode && !interactionDisabled ? !!ctxMenu : undefined}
          disabled={interactionDisabled}
          onClick={handlePrimaryAction}
          onKeyDown={(event) => {
            if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
              event.preventDefault();
              event.stopPropagation();
              const card = event.currentTarget.closest<HTMLElement>(".photo-card");
              openContextMenu(0, 0, card ?? event.currentTarget);
            }
          }}
        >
          <span
            ref={videoRepairTargetRef}
            className="photo-thumbnail"
            data-media-policy={GRID_MEDIA_POLICY_MARKER}
          >
            {!isAudio && !imgLoaded && !imgFailed && (!isVideo || useVideoThumb) && <span className="photo-skeleton" />}
            {isAudio ? (
              <>
                <span className="audio-thumb-placeholder" aria-hidden="true">
                  <span className="audio-thumb-placeholder-icon">🎙</span>
                  <span className="audio-thumb-placeholder-text">语音备忘录</span>
                </span>
                <span className="photo-audio-badge" aria-hidden="true">音频</span>
              </>
            ) : useVideoThumb ? (
              <img
                key={coverAttemptElementKey}
                ref={coverImageRef}
                crossOrigin="anonymous"
                src={coverAttemptSource ?? retryVideoPosterSrc}
                alt=""
                loading={priority ? "eager" : "lazy"}
                fetchPriority={priority ? "high" : "auto"}
                className={imgLoaded ? "img-loaded" : "img-loading"}
              />
            ) : isVideo ? (
              <span className="video-thumb-placeholder" aria-hidden="true">
                <span className="video-thumb-placeholder-icon">▶</span>
                <span className="video-thumb-placeholder-text">{videoRepairStatus}</span>
              </span>
            ) : isMotionPhoto ? (
              <img
                key={coverAttemptElementKey}
                ref={coverImageRef}
                src={coverAttemptSource ?? retryLowDataImageSources[0] ?? BLANK_GIF}
                alt=""
                loading={priority ? "eager" : "lazy"}
                fetchPriority={priority ? "high" : "auto"}
                className={imgLoaded ? "img-loaded" : "img-loading"}
              />
            ) : isAnimated ? (
              <img
                key={gifUsesOriginal ? imageRetryKey : coverAttemptElementKey}
                ref={coverImageRef}
                src={coverAttemptSource ?? (isGif
                  ? (gifInteractionBlocked ? retryStaticAnimatedSrc : retryGifDisplaySrc)
                  : retryStaticAnimatedSrc)}
                alt=""
                loading={priority ? "eager" : "lazy"}
                fetchPriority={priority ? "high" : "auto"}
                className={imgLoaded ? "img-loaded" : "img-loading"}
                onLoad={gifUsesOriginal ? markImageLoaded : undefined}
                onError={gifUsesOriginal
                  ? (event) => {
                    if (!fallbackMediaSource(event.currentTarget, [retryOriginalImageUrl])) {
                      markImageFailed();
                    }
                  }
                  : undefined}
              />
            ) : (
              <img
                key={coverAttemptElementKey}
                ref={coverImageRef}
                src={coverAttemptSource ?? retryLowDataImageSources[0] ?? BLANK_GIF}
                alt=""
                loading={priority ? "eager" : "lazy"}
                fetchPriority={priority ? "high" : "auto"}
                decoding="async"
                className={imgLoaded ? "img-loaded" : imgFailed ? "img-error" : "img-loading"}
              />
            )}
            {photoCoverFailed && (
              <span
                id={`${descriptionId}-cover-status`}
                className="photo-thumb-error"
                role="status"
              >
                封面加载失败，点击重试
              </span>
            )}
            {isVideo && <span className="photo-video-badge">▶</span>}
            {isHeic && <span className="photo-format-badge">HEIC</span>}
            {photo.favorite && <span className="photo-favorite-badge" title="已收藏">★</span>}
            {isAnimated && isMotionPhoto && (
              <span className="photo-video-badge">动态照片 📱</span>
            )}
            {isGif && gifPaused && <span className="photo-gif-paused-overlay" />}
            {isGif && !gifPaused && <span className="gif-animated-badge">GIF</span>}
            {isAnimated && !isMotionPhoto && !isGif && (
              <span className="gif-animated-badge">动图</span>
            )}
          </span>
          <span className="photo-info">
            <span className="photo-name" title={displayName}>
              {displayName}
            </span>
          </span>
          {(uploadTime || takenTime || photo.createdBy || photo.subject) && (
            <span className="photo-meta">
              {photo.subject && <span id={`${descriptionId}-subject`} className="photo-subject-tag">{photo.subject}</span>}
              {photo.createdBy && <span id={`${descriptionId}-creator`} className="photo-meta-by">👤 {photo.createdBy}</span>}
              {showTakenDate && <span className="photo-meta-taken" title="拍摄时间">📷 {takenTime}</span>}
              {uploadTime && !showTakenDate && <span className="photo-meta-date">{uploadTime}</span>}
            </span>
          )}
        </button>
        {isVideo && !useVideoThumb && (
          <span id={`${descriptionId}-video-status`} className="photo-card-status" role="status">
            {videoRepairStatus}
          </span>
        )}
        {!selectionMode && !interactionDisabled && (
          <div className="photo-card-controls">
            {isGif && (
              gifPaused ? (
                <button
                  type="button"
                  className="gif-play-center-btn"
                  onClick={toggleGifPause}
                  aria-label={`继续播放动图 ${displayName}`}
                  title="继续播放"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </button>
              ) : (
                <button
                  type="button"
                  className="gif-pause-corner-btn"
                  onClick={toggleGifPause}
                  aria-label={`暂停动图 ${displayName}`}
                  title="暂停动图"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                  </svg>
                </button>
            )
          )}
            {onMoveRequest && (
                <button
                  type="button"
                  className="move-btn"
                  aria-label={getPhotoActionLabel("move", displayName)}
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
                  aria-label={getPhotoActionLabel(photo.favorite ? "unfavorite" : "favorite", displayName)}
                  aria-pressed={!!photo.favorite}
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
                aria-label={getPhotoActionLabel("delete", displayName)}
                title="删除照片"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteDialogTriggerRef.current = e.currentTarget;
                  setShowConfirm(true);
                }}
              >
                <span aria-hidden="true">🗑︎</span>
            </button>
          </div>
        )}
      </div>

      {showConfirm && createPortal(
        <div
          ref={confirmLayerRef}
          className="confirm-overlay"
          data-modal-layer
          onClick={requestCloseDeleteDialog}
        >
          <div
            ref={confirmDialogRef}
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={deleteDialogTitleId}
            aria-describedby={deleteDialogDescriptionId}
            aria-busy={deletePending || undefined}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <p id={deleteDialogTitleId} className="confirm-title">删除照片？</p>
            <p id={deleteDialogDescriptionId} className="confirm-filename">
              {displayName} · 此操作不可撤销
            </p>
            <div className="confirm-actions">
              <button
                ref={cancelButtonRef}
                type="button"
                className="confirm-cancel-btn"
                onClick={requestCloseDeleteDialog}
                disabled={deletePending}
              >
                取消
              </button>
              <button
                type="button"
                className="confirm-delete-btn"
                onClick={() => void handleConfirmDelete()}
                disabled={deletePending}
              >
                {deletePending ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {ctxMenu && !interactionDisabled && !selectionMode && createPortal(
        <div
          className="photo-ctx-backdrop"
          onClick={() => closeContextMenu()}
          onContextMenu={(event) => {
            event.preventDefault();
            closeContextMenu();
          }}
        >
          <ul
            ref={menuRef}
            className="photo-ctx-menu"
            role="menu"
            aria-label={`照片 ${displayName} 操作菜单`}
            style={{ top: ctxMenu.y, left: ctxMenu.x }}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (!menuRef.current) return;
              handleMenuKeyDown(
                event,
                menuRef.current,
                document.activeElement,
                (restoreFocus) => closeContextMenu(restoreFocus),
              );
            }}
          >
            {contextMenuActions.map((action) => (
              <li role="none" key={action.key}>
                <button
                  type="button"
                  role="menuitem"
                  className={`photo-ctx-item${action.danger ? " photo-ctx-item--danger" : ""}`}
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation();
                    activateContextMenuAction(action.run);
                  }}
                >
                  <span aria-hidden="true">{action.icon}</span> {action.label}
                </button>
              </li>
            ))}
          </ul>
        </div>,
        document.body
      )}
    </>
  );
}

export default memo(PhotoCard);
