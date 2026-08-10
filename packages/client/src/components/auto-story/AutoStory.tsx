import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { Photo } from "../../services/photoApi";
import { fallbackMediaSource } from "../../services/mediaRoute";
import { BLANK_GIF, selectGridMediaSources } from "@cloudphoto/algorithm";
import MediaThumb from "../shared/MediaThumb";
import { useModalFocusBoundary } from "../shared/useModalFocusBoundary";

interface Props {
  photos: Photo[];
}

type TransitionStyle = "fade" | "slide" | "zoom";

function isStoryEligible(photo: Photo): boolean {
  if (photo.contentType?.startsWith("image/")) return true;
  if (!photo.contentType?.startsWith("video/")) return false;
  return selectGridMediaSources(photo).length > 0;
}

export default function AutoStory({ photos }: Props) {
  const storyLayerRef = useRef<HTMLDivElement | null>(null);
  const storyDialogRef = useRef<HTMLDivElement | null>(null);
  const storyCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const navigationTimerRef = useRef<number | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [transition, setTransition] = useState<TransitionStyle>("fade");
  const [intervalSec, setIntervalSec] = useState(4);
  const [animClass, setAnimClass] = useState("story-enter");

  const storyEligiblePhotos = useMemo(() => photos.filter(isStoryEligible), [photos]);

  const folders = useMemo(
    () => [...new Set(storyEligiblePhotos.map((p) => (p.folder ?? "").trim()).filter(Boolean))].sort(),
    [storyEligiblePhotos],
  );

  // Pre-compute per-folder counts once — avoids O(n×folders) in render
  const folderCounts = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const p of storyEligiblePhotos) {
      const f = (p.folder ?? "").trim();
      if (f) map[f] = (map[f] ?? 0) + 1;
    }
    return map;
  }, [storyEligiblePhotos]);

  const storyPhotos = useMemo(() => {
    if (selectedFolder === null) return storyEligiblePhotos.slice().reverse();
    if (selectedFolder === "") return storyEligiblePhotos.filter((p) => !(p.folder ?? "").trim()).slice().reverse();
    return storyEligiblePhotos.filter((p) => (p.folder ?? "").trim() === selectedFolder).slice().reverse();
  }, [selectedFolder, storyEligiblePhotos]);

  const cancelPendingNavigation = useCallback(() => {
    if (navigationTimerRef.current === null) return;
    window.clearTimeout(navigationTimerRef.current);
    navigationTimerRef.current = null;
  }, []);

  const scheduleNavigation = useCallback((direction: -1 | 1) => {
    if (storyPhotos.length < 2) return;
    cancelPendingNavigation();
    setAnimClass(direction < 0 ? "story-exit-right" : "story-exit-left");
    navigationTimerRef.current = window.setTimeout(() => {
      navigationTimerRef.current = null;
      setCurrentIndex((index) => (
        index + direction + storyPhotos.length
      ) % storyPhotos.length);
      setAnimClass("story-enter");
    }, 200);
  }, [cancelPendingNavigation, storyPhotos.length]);

  const prev = useCallback(() => scheduleNavigation(-1), [scheduleNavigation]);
  const next = useCallback(() => scheduleNavigation(1), [scheduleNavigation]);

  const jumpTo = useCallback((index: number) => {
    cancelPendingNavigation();
    setCurrentIndex(Math.max(0, Math.min(storyPhotos.length - 1, index)));
    setAnimClass("story-enter");
  }, [cancelPendingNavigation, storyPhotos.length]);

  useEffect(() => cancelPendingNavigation, [cancelPendingNavigation]);

  // Auto-advance
  useEffect(() => {
    if (!playing || paused || storyPhotos.length < 2) return;
    const id = setInterval(next, intervalSec * 1000);
    return () => clearInterval(id);
  }, [intervalSec, next, paused, playing, storyPhotos.length]);

  const currentPhoto = storyPhotos[currentIndex];
  const currentPhotoIsVideo = currentPhoto?.contentType?.startsWith("video/") ?? false;
  const currentDerivativeSources = currentPhoto ? selectGridMediaSources(currentPhoto) : [];
  const currentPreviewSources = [...currentDerivativeSources].reverse();
  const currentPhotoPoster = currentDerivativeSources[0];

  const closeStoryPlayer = useCallback(() => {
    cancelPendingNavigation();
    setAnimClass("story-enter");
    setPlaying(false);
    setPaused(false);
  }, [cancelPendingNavigation]);

  useEffect(() => {
    if (storyPhotos.length === 0) {
      closeStoryPlayer();
      setCurrentIndex(0);
      return;
    }
    if (currentIndex >= storyPhotos.length) setCurrentIndex(storyPhotos.length - 1);
  }, [closeStoryPlayer, currentIndex, storyPhotos.length]);

  const onStoryKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement && event.target.type === "range") return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      prev();
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      next();
    }
  }, [next, prev]);

  useModalFocusBoundary({
    active: playing && currentPhoto !== undefined,
    layerRef: storyLayerRef,
    containerRef: storyDialogRef,
    initialFocusRef: storyCloseButtonRef,
    onEscape: () => {
      closeStoryPlayer();
      return true;
    },
    onKeyDown: onStoryKeyDown,
  });

  return (
    <div className="story-wrap">
      <div className="story-header">
        <span className="story-title">🎬 自动故事</span>
        <span className="story-subtitle">选择文件夹，一键播放照片和视频</span>
      </div>

      <div className="story-controls">
        <div className="story-control-group">
          <label className="story-control-label">内容来源</label>
          <select
            className="story-select"
            value={selectedFolder ?? "__all__"}
            onChange={(e) => {
              const v = e.target.value;
              setSelectedFolder(v === "__all__" ? null : v);
              setCurrentIndex(0);
            }}
          >
            <option value="__all__">全部可播放照片/视频（{storyEligiblePhotos.length} 项）</option>
            {folders.map((f) => (
              <option key={f} value={f}>{f}（{folderCounts[f] ?? 0} 项）</option>
            ))}
            <option value="">
              未分类文件夹（{storyEligiblePhotos.filter((p) => !(p.folder ?? "").trim()).length} 项）
            </option>
          </select>
        </div>

        <div className="story-control-group">
          <label className="story-control-label">切换效果</label>
          <select
            className="story-select"
            value={transition}
            onChange={(e) => setTransition(e.target.value as TransitionStyle)}
          >
            <option value="fade">淡入淡出</option>
            <option value="slide">左右滑动</option>
            <option value="zoom">缩放</option>
          </select>
        </div>

        <div className="story-control-group">
          <label className="story-control-label">间隔（秒）</label>
          <select
            className="story-select"
            value={intervalSec}
            onChange={(e) => setIntervalSec(Number(e.target.value))}
          >
            {[2, 3, 4, 5, 8, 10].map((s) => (
              <option key={s} value={s}>{s} 秒</option>
            ))}
          </select>
        </div>

        <button
          className="story-play-btn"
          onClick={() => { cancelPendingNavigation(); setAnimClass("story-enter"); setCurrentIndex(0); setPaused(false); setPlaying(true); }}
          disabled={storyPhotos.length === 0}
        >
          ▶ 开始播放（{storyPhotos.length} 项）
        </button>
      </div>

      {storyPhotos.length === 0 && (
        <div className="story-empty" role="status">
          没有可播放的照片或视频
        </div>
      )}

      {/* Preview grid */}
      <div className="story-preview-grid">
        {storyPhotos.slice(0, 12).map((p, i) => (
          <div key={p.name} className="story-preview-thumb">
            <MediaThumb
              url={p.url}
              thumbnailUrl={p.thumbnailUrl}
              previewUrl={p.previewUrl}
              alt={p.originalName ?? ""}
              contentType={p.contentType}
              loading="lazy"
            />
            <span className="story-preview-num">{i + 1}</span>
          </div>
        ))}
        {storyPhotos.length > 12 && (
          <div className="story-preview-more">+{storyPhotos.length - 12}</div>
        )}
      </div>

      {/* Full-screen player */}
      {playing && currentPhoto && createPortal(
        <div
          ref={(element) => {
            storyLayerRef.current = element;
            storyDialogRef.current = element;
          }}
          className={`story-player story-player--${transition}`}
          data-modal-layer
          role="dialog"
          aria-modal="true"
          aria-label="自动故事播放器"
          tabIndex={-1}
        >
          {/* Background blur layer */}
          <div
            className="story-player-bg"
            style={{ backgroundImage: currentPhotoPoster ? `url(${currentPhotoPoster})` : undefined }}
          />

          {/* Main photo */}
          <div className={`story-player-img-wrap ${animClass}`} key={currentIndex}>
            {currentPhotoIsVideo ? (
              <MediaThumb
                url={currentPhoto.url}
                thumbnailUrl={currentPhoto.thumbnailUrl}
                previewUrl={currentPhoto.previewUrl}
                alt={currentPhoto.originalName ?? ""}
                contentType={currentPhoto.contentType}
                className="story-player-img"
              />
            ) : (
              <img
                src={currentPreviewSources[0] ?? BLANK_GIF}
                alt={currentPhoto.originalName ?? ""}
                className="story-player-img"
                onError={(event) => {
                  fallbackMediaSource(event.currentTarget, currentPreviewSources);
                }}
              />
            )}
          </div>

          {/* Caption */}
          <div className="story-player-caption">
            {currentPhoto.subject && <div className="story-player-subject">{currentPhoto.subject}</div>}
            <div className="story-player-name">
              {currentPhoto.originalName ?? currentPhoto.name.split("/").pop()}
            </div>
            <div className="story-player-date">
              {new Date(currentPhoto.createdAt ?? currentPhoto.lastModified ?? "").toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}
            </div>
          </div>

          {/* Progress scrubber */}
          <div className="story-player-progress">
            <input
              className="story-progress-scrubber"
              type="range"
              min={1}
              max={storyPhotos.length}
              value={currentIndex + 1}
              aria-label="故事进度"
              aria-valuetext={`${currentIndex + 1} / ${storyPhotos.length}：${currentPhoto.originalName ?? currentPhoto.name.split("/").pop()}`}
              style={{
                background: `linear-gradient(to right, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.95) ${((currentIndex + 1) / storyPhotos.length) * 100}%, rgba(255,255,255,0.35) ${((currentIndex + 1) / storyPhotos.length) * 100}%, rgba(255,255,255,0.35) 100%)`,
              }}
              onChange={(event) => jumpTo(Number(event.target.value) - 1)}
            />
          </div>

          {/* Controls */}
          <div className="story-player-controls">
            <button type="button" className="story-ctrl-btn" onClick={prev} aria-label="上一张" title="上一张">‹</button>
            <button
              type="button"
              className="story-ctrl-btn story-ctrl-pause"
              onClick={() => setPaused((value) => !value)}
              aria-label={paused ? "继续播放" : "暂停播放"}
              title="暂停/继续"
            >{paused ? "▶" : "⏸"}</button>
            <button type="button" className="story-ctrl-btn" onClick={next} aria-label="下一张" title="下一张">›</button>
            <button
              type="button"
              ref={storyCloseButtonRef}
              className="story-ctrl-btn story-ctrl-close"
              onClick={closeStoryPlayer}
              aria-label="关闭自动故事"
              title="关闭 (Esc)"
            >✕</button>
          </div>

          {/* Counter */}
          <div className="story-player-counter">
            {currentIndex + 1} / {storyPhotos.length}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
