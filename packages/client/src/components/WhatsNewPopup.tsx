import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface ChangelogEntry {
  id: string;
  date: string; // "YYYY-MM-DD"
  icon: string;
  title: string;
  desc: string;
}

// ─── Changelog — newest first ────────────────────────────────────────────────
export const CHANGELOG: ChangelogEntry[] = [
  {
    id: "delete-progress",
    date: "2026-06-02",
    icon: "🗑️",
    title: "删除进度条",
    desc: "批量删除照片和清空回收站时，顶部进度条实时更新",
  },
  {
    id: "dialog-centering",
    date: "2026-06-01",
    icon: "📐",
    title: "删除确认居中",
    desc: "删除确认弹窗现在固定在屏幕正中央，不再需要滚动",
  },
  {
    id: "voice-memo",
    date: "2026-05-30",
    icon: "🎙️",
    title: "语音备注",
    desc: "为每张照片录制语音备注，点击播放按钮随时回听",
  },
  {
    id: "video-upload",
    date: "2026-05-30",
    icon: "🎬",
    title: "视频上传",
    desc: "现在可以上传视频文件，与照片一同保存在相册中",
  },
  {
    id: "folder-persist",
    date: "2026-05-29",
    icon: "📁",
    title: "文件夹路径记忆",
    desc: "刷新页面后自动回到上次浏览的文件夹，不再从根目录开始",
  },
];

const STORAGE_KEY = "cf_whats_new_seen";
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const AUTO_DISMISS_MS = 10_000;

function getRecentEntries(): ChangelogEntry[] {
  const now = Date.now();
  return CHANGELOG.filter((e) => now - new Date(e.date).getTime() <= THREE_DAYS_MS);
}

function mostRecentDate(entries: ChangelogEntry[]): string {
  return entries.reduce((max, e) => (e.date > max ? e.date : max), "");
}

export default function WhatsNewPopup() {
  const recent = getRecentEntries();
  const latestDate = mostRecentDate(recent);
  const lastSeen = localStorage.getItem(STORAGE_KEY) ?? "";
  const shouldShow = recent.length > 0 && latestDate > lastSeen;

  const [visible, setVisible] = useState(shouldShow);
  const [fadeOut, setFadeOut] = useState(false);
  const [progress, setProgress] = useState(100); // countdown bar 100→0
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);

  const dismiss = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    localStorage.setItem(STORAGE_KEY, latestDate);
    setFadeOut(true);
    setTimeout(() => setVisible(false), 500);
  };

  useEffect(() => {
    if (!visible) return;

    startRef.current = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startRef.current;
      const pct = Math.max(0, 100 - (elapsed / AUTO_DISMISS_MS) * 100);
      setProgress(pct);
      if (elapsed < AUTO_DISMISS_MS) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    timerRef.current = setTimeout(dismiss, AUTO_DISMISS_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!visible) return null;

  return createPortal(
    <div className={`whats-new-popup${fadeOut ? " whats-new-popup--out" : ""}`} role="status" aria-live="polite">
      <div className="whats-new-header">
        <span className="whats-new-title">🎉 最近更新</span>
        <button className="whats-new-close" onClick={dismiss} aria-label="关闭">✕</button>
      </div>
      <ul className="whats-new-list">
        {recent.map((entry) => (
          <li key={entry.id} className="whats-new-item">
            <span className="whats-new-icon">{entry.icon}</span>
            <div className="whats-new-body">
              <span className="whats-new-item-title">{entry.title}</span>
              <span className="whats-new-item-desc">{entry.desc}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="whats-new-countdown">
        <div className="whats-new-countdown-fill" style={{ width: `${progress}%` }} />
      </div>
    </div>,
    document.body,
  );
}
