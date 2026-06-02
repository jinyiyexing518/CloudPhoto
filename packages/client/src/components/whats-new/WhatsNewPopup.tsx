import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { fetchChangelogs, type ChangelogEntry } from "../../services/photoApi";

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

const IDLE_DELAY_MS = 5000;    // 5s 无操作后开始淡出
const FADE_DURATION_MS = 4000; // 4s CSS 过渡时长

export default function WhatsNewPopup() {
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null);
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const [fading, setFading] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch changelog entries from Cosmos DB via the API
  useEffect(() => {
    fetchChangelogs(7).then((data) => {
      setEntries(data);
      if (data.length > 0) setVisible(true);
    });
  }, []);

  // WhatsNew 是自动淡出的轻量提示层，不需要锁定 body 滚动。
  // 之前的 scroll-lock + paddingRight 补偿会在弹窗淡出时产生布局位移，
  // 导致 position:fixed 的 FAB 看起来发生了偏移。

  // 启动自动淡出倒计时；pinned 后取消
  useEffect(() => {
    if (!visible || pinned) return;
    idleTimer.current = setTimeout(() => {
      setFading(true);
      fadeTimer.current = setTimeout(() => setVisible(false), FADE_DURATION_MS);
    }, IDLE_DELAY_MS);
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
    };
  }, [visible, pinned]);

  const dismiss = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    setClosing(true);
    setTimeout(() => setVisible(false), 300);
  };

  // 用户点击弹窗内容 → 立刻恢复、等待手动关闭
  const handlePopupClick = () => {
    if (pinned) return;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    setFading(false);
    setPinned(true);
  };

  if (!visible || !entries) return null;

  return createPortal(
    <div
      className={`whats-new-overlay${closing ? " whats-new-overlay--out" : ""}${fading ? " whats-new-overlay--fading" : ""}`}
      onClick={(e) => { if (e.target === e.currentTarget) dismiss(); }}
      role="dialog"
      aria-modal="true"
      aria-label="最近更新"
    >
      <div className="whats-new-popup" onClick={handlePopupClick}>
        <div className="whats-new-header">
          <div className="whats-new-header-text">
            <span className="whats-new-title">🎉 最近更新</span>
            <span className="whats-new-subtitle">过去 7 天新上线的功能，点击条目查看详情</span>
          </div>
          <button className="whats-new-close" onClick={dismiss} aria-label="关闭">✕</button>
        </div>
        <ul className="whats-new-list">
          {entries.map((entry) => {
            const open = expandedId === entry.id;
            return (
              <li key={entry.id} className="whats-new-item">
                <div
                  className="whats-new-item-summary"
                  onClick={() => setExpandedId(open ? null : entry.id)}
                  role="button"
                  aria-expanded={open}
                >
                  <span className="whats-new-icon">{entry.icon}</span>
                  <div className="whats-new-body">
                    <div className="whats-new-item-top">
                      <span className="whats-new-item-title">{entry.title}</span>
                      <span className="whats-new-item-date">{formatDate(entry.date)}</span>
                    </div>
                    <span className="whats-new-item-desc">{entry.desc}</span>
                  </div>
                  {entry.details && (
                    <span className={`whats-new-expand-icon${open ? " whats-new-expand-icon--open" : ""}`}>▼</span>
                  )}
                </div>
                {open && entry.details && (
                  <div className="whats-new-item-details">{entry.details}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>,
    document.body,
  );
}