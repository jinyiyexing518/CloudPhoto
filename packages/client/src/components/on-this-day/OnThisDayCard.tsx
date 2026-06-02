import { useState } from "react";
import { Photo } from "../../services/photoApi";

interface Props {
  photos: Photo[];
  onJumpToPhoto?: (name: string) => void;
}

function photoDate(p: Photo): string {
  return (p.createdAt ?? p.lastModified ?? "").slice(0, 10);
}

export default function OnThisDayCard({ photos, onJumpToPhoto }: Props) {
  const [expanded, setExpanded] = useState(false);

  const today = new Date();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const todayMD = `${mm}-${dd}`;
  const todayYear = today.getFullYear();

  const matched = photos.filter((p) => {
    const d = photoDate(p);
    if (!d || d.length < 10) return false;
    const pYear = parseInt(d.slice(0, 4), 10);
    const pMD = d.slice(5, 10);
    return pMD === todayMD && pYear < todayYear;
  });

  if (matched.length === 0) return null;

  // Group by year, newest first
  const byYear: Record<number, Photo[]> = {};
  for (const p of matched) {
    const yr = parseInt(photoDate(p).slice(0, 4), 10);
    (byYear[yr] ??= []).push(p);
  }
  const years = Object.keys(byYear).map(Number).sort((a, b) => b - a);

  const previewPhotos = expanded ? matched : matched.slice(0, 6);

  return (
    <div className="otd-card">
      <button className="otd-toggle" onClick={() => setExpanded((v) => !v)}>
        <span className="otd-title">📅 历史上的今天</span>
        <span className="otd-meta">
          {years.length} 个年份 · {matched.length} 张
        </span>
        <span className="otd-chevron">{expanded ? "▲" : "▼"}</span>
      </button>

      <div className="otd-thumbs">
        {(expanded ? matched : previewPhotos).map((p) => {
          const yr = parseInt(photoDate(p).slice(0, 4), 10);
          const yrsAgo = todayYear - yr;
          return (
            <button
              key={p.name}
              className="otd-thumb-btn"
              onClick={() => onJumpToPhoto?.(p.name)}
              title={`${yrsAgo} 年前 · ${p.originalName ?? p.name}`}
            >
              <img
                src={p.url}
                alt={p.originalName ?? "照片"}
                loading="lazy"
              />
              <span className="otd-thumb-label">{yrsAgo}年前</span>
            </button>
          );
        })}
        {!expanded && matched.length > 6 && (
          <button
            className="otd-thumb-btn otd-thumb-more"
            onClick={() => setExpanded(true)}
          >
            <span>+{matched.length - 6}</span>
          </button>
        )}
      </div>

      {expanded && (
        <div className="otd-year-list">
          {years.map((yr) => (
            <div key={yr} className="otd-year-row">
              <span className="otd-year-badge">{yr} · {todayYear - yr} 年前</span>
              <span className="otd-year-count">{byYear[yr].length} 张</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
