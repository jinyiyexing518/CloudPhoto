import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Photo } from "../../services/photoApi";
import { fallbackMediaSource } from "../../services/mediaRoute";
import { BLANK_GIF, selectGridMediaSources } from "@cloudphoto/algorithm";
import MediaThumb from "../shared/MediaThumb";

interface Props {
  photos: Photo[];
}

type TransitionStyle = "fade" | "slide" | "zoom";

export default function AutoStory({ photos }: Props) {
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [transition, setTransition] = useState<TransitionStyle>("fade");
  const [intervalSec, setIntervalSec] = useState(4);
  const [animClass, setAnimClass] = useState("story-enter");

  const folders = useMemo(
    () => [...new Set(photos.map((p) => (p.folder ?? "").trim()).filter(Boolean))].sort(),
    [photos],
  );

  // Pre-compute per-folder counts once — avoids O(n×folders) in render
  const folderCounts = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const p of photos) {
      const f = (p.folder ?? "").trim();
      if (f) map[f] = (map[f] ?? 0) + 1;
    }
    return map;
  }, [photos]);

  const storyPhotos = useMemo(() => {
    if (selectedFolder === null) return photos.slice().reverse();
    if (selectedFolder === "") return photos.filter((p) => !(p.folder ?? "").trim()).slice().reverse();
    return photos.filter((p) => (p.folder ?? "").trim() === selectedFolder).slice().reverse();
  }, [photos, selectedFolder]);

  const prev = useCallback(() => {
    setAnimClass("story-exit-right");
    setTimeout(() => {
      setCurrentIndex((i) => (i - 1 + storyPhotos.length) % storyPhotos.length);
      setAnimClass("story-enter");
    }, 200);
  }, [storyPhotos.length]);

  const next = useCallback(() => {
    setAnimClass("story-exit-left");
    setTimeout(() => {
      setCurrentIndex((i) => (i + 1) % storyPhotos.length);
      setAnimClass("story-enter");
    }, 200);
  }, [storyPhotos.length]);

  // Auto-advance
  useEffect(() => {
    if (!playing || storyPhotos.length < 2) return;
    const id = setInterval(next, intervalSec * 1000);
    return () => clearInterval(id);
  }, [playing, next, intervalSec, storyPhotos.length]);

  // Keyboard controls
  useEffect(() => {
    if (!playing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
      if (e.key === "ArrowRight") { e.preventDefault(); next(); }
      if (e.key === "Escape") { e.preventDefault(); setPlaying(false); }
      if (e.key === " ") { e.preventDefault(); /* toggle handled by button */ }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, prev, next]);

  const currentPhoto = storyPhotos[currentIndex];
  const currentPhotoIsVideo = currentPhoto?.contentType.startsWith("video/") ?? false;
  const currentDerivativeSources = currentPhoto ? selectGridMediaSources(currentPhoto) : [];
  const currentPreviewSources = [...currentDerivativeSources].reverse();
  const currentPhotoPoster = currentDerivativeSources[0];

  return (
    <div className="story-wrap">
      <div className="story-header">
        <span className="story-title">🎬 自动故事</span>
        <span className="story-subtitle">选择文件夹，一键生成幻灯片</span>
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
            <option value="__all__">全部照片（{photos.length} 张）</option>
            {folders.map((f) => (
              <option key={f} value={f}>{f}（{folderCounts[f] ?? 0} 张）</option>
            ))}
            <option value="">未分类文件夹</option>
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
          onClick={() => { setCurrentIndex(0); setPlaying(true); }}
          disabled={storyPhotos.length === 0}
        >
          ▶ 开始播放（{storyPhotos.length} 张）
        </button>
      </div>

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
        <div className={`story-player story-player--${transition}`}>
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

          {/* Progress bar */}
          <div className="story-player-progress">
            {storyPhotos.map((_, i) => (
              <div
                key={i}
                className={`story-progress-seg${i === currentIndex ? " active" : i < currentIndex ? " done" : ""}`}
                onClick={() => { setCurrentIndex(i); setAnimClass("story-enter"); }}
              />
            ))}
          </div>

          {/* Controls */}
          <div className="story-player-controls">
            <button type="button" className="story-ctrl-btn" onClick={prev} aria-label="上一张" title="上一张">‹</button>
            <button
              type="button"
              className="story-ctrl-btn story-ctrl-pause"
              onClick={() => setPlaying((v) => !v)}
              aria-label={playing ? "暂停播放" : "继续播放"}
              title="暂停/继续"
            >{playing ? "⏸" : "▶"}</button>
            <button type="button" className="story-ctrl-btn" onClick={next} aria-label="下一张" title="下一张">›</button>
            <button
              type="button"
              className="story-ctrl-btn story-ctrl-close"
              onClick={() => setPlaying(false)}
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
