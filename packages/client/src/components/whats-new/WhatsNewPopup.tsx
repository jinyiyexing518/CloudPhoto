import { useCallback, useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { fetchChangelogs, type ChangelogEntry } from "../../services/photoApi";
import {
  clearModalTimers,
  focusElement,
  hasActiveModalLayer,
  handleModalKeyDown,
  restoreFocus,
  subscribeModalStack,
  type ModalTimerHandles,
} from "../shared/modalFocus";

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

const IDLE_DELAY_MS = 5000;    // 5s 无操作后开始淡出
const FADE_DURATION_MS = 4000; // 4s CSS 过渡时长

/** Infer type from title prefix when the type field is absent */
function inferTypeFromTitle(title: string): "feature" | "fix" | "improvement" {
  const t = title.toLowerCase();
  if (t.startsWith("fix:") || t.startsWith("修复") || /^\[?fix\]?[:\s]/i.test(t)) return "fix";
  if (t.startsWith("perf:") || t.startsWith("chore:") || t.startsWith("优化") || t.startsWith("refactor:")) return "improvement";
  return "feature";
}

/** Entries without a type are inferred from the title (backward-compatible) */
function entryType(e: ChangelogEntry): "feature" | "fix" | "improvement" {
  return (e.type as "feature" | "fix" | "improvement" | undefined) ?? inferTypeFromTitle(e.title ?? "");
}

/** Normalize runtime entry: handle both 'desc' and 'description'; add default icon */
function normalize(e: ChangelogEntry & { description?: string; summary?: string }): ChangelogEntry {
  const type = entryType(e);
  return {
    ...e,
    type,
    desc: e.desc ?? (e as { description?: string }).description ?? (e as { summary?: string }).summary ?? "",
    icon: e.icon ?? (type === "fix" ? "🔧" : type === "improvement" ? "⚡" : "✨"),
  };
}

function EntryItem({ entry, expandedId, setExpandedId }: {
  entry: ChangelogEntry;
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
}) {
  const open = expandedId === entry.id;
  const detailsId = `whats-new-details-${entry.id}`;
  const summary = (
    <>
      <span className="whats-new-icon">{entry.icon}</span>
      <span className="whats-new-body">
        <span className="whats-new-item-top">
          <span className="whats-new-item-title">{entry.title}</span>
          <span className="whats-new-item-date">{formatDate(entry.date)}</span>
        </span>
        <span className="whats-new-item-desc">{entry.desc}</span>
      </span>
      {entry.details && (
        <span className={`whats-new-expand-icon${open ? " whats-new-expand-icon--open" : ""}`}>▼</span>
      )}
    </>
  );
  return (
    <li key={entry.id} className={`whats-new-item whats-new-item--${entryType(entry)}`}>
      {entry.details ? (
        <button
          type="button"
          className="whats-new-item-summary"
          onClick={() => setExpandedId(open ? null : entry.id)}
          aria-expanded={open}
          aria-controls={detailsId}
        >
          {summary}
        </button>
      ) : (
        <div className="whats-new-item-summary">{summary}</div>
      )}
      {open && entry.details && (
        <div id={detailsId} className="whats-new-item-details">{entry.details}</div>
      )}
    </li>
  );
}

export default function WhatsNewPopup() {
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null);
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const [fading, setFading] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fixesOpen, setFixesOpen] = useState(false);
  const mountedRef = useRef(true);
  const closingRef = useRef(false);
  const changelogRequestIdRef = useRef(0);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const suppressFocusPinRef = useRef(false);
  const timerHandles = useRef<ModalTimerHandles>({
    idle: null,
    fade: null,
    close: null,
    initialFocus: null,
  });

  // Fetch changelog entries from Cosmos DB via the API
  useEffect(() => {
    mountedRef.current = true;
    const requestId = ++changelogRequestIdRef.current;
    fetchChangelogs(7).then((data) => {
      if (!mountedRef.current || requestId !== changelogRequestIdRef.current) return;
      // Normalize: map 'description'/'summary' → 'desc', infer type from title
      const normalized = data.map(normalize);
      // Sort: features/improvements first, then fixes; newest-first within each group
      normalized.sort((a, b) => {
        const ta = entryType(a) === "fix" ? 1 : 0;
        const tb = entryType(b) === "fix" ? 1 : 0;
        if (ta !== tb) return ta - tb;
        return b.date.localeCompare(a.date);
      });
      setEntries(normalized);
      if (normalized.length > 0 && !hasActiveModalLayer()) setVisible(true);
    });
    return () => {
      mountedRef.current = false;
      changelogRequestIdRef.current += 1;
      clearModalTimers(timerHandles.current);
    };
  }, []);

  // WhatsNew 是自动淡出的轻量提示层，不需要锁定 body 滚动。

  // 启动自动淡出倒计时；pinned 后取消
  useEffect(() => {
    if (!visible || pinned) return;
    timerHandles.current.idle = setTimeout(() => {
      if (!mountedRef.current) return;
      setFading(true);
      timerHandles.current.fade = setTimeout(() => {
        if (mountedRef.current) setVisible(false);
      }, FADE_DURATION_MS);
    }, IDLE_DELAY_MS);
    return () => {
      if (timerHandles.current.idle !== null) {
        clearTimeout(timerHandles.current.idle);
        timerHandles.current.idle = null;
      }
      if (timerHandles.current.fade !== null) {
        clearTimeout(timerHandles.current.fade);
        timerHandles.current.fade = null;
      }
    };
  }, [visible, pinned]);

  const pinPopup = useCallback(() => {
    if (closingRef.current) return;
    clearModalTimers(timerHandles.current);
    if (!mountedRef.current) return;
    setFading(false);
    setPinned(true);
  }, []);

  const dismiss = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    clearModalTimers(timerHandles.current);
    setClosing(true);
    timerHandles.current.close = setTimeout(() => {
      if (mountedRef.current) setVisible(false);
    }, 300);
  }, []);

  useEffect(() => {
    const hideBehindSharedModal = () => {
      if (!hasActiveModalLayer()) return;
      clearModalTimers(timerHandles.current);
      setVisible(false);
    };
    hideBehindSharedModal();
    return subscribeModalStack(hideBehindSharedModal);
  }, []);

  // 用户点击弹窗内容 → 立刻恢复、等待手动关闭
  const handlePopupClick = () => pinPopup();
  const handlePopupFocus = useCallback(() => {
    if (!suppressFocusPinRef.current) pinPopup();
  }, [pinPopup]);

  useEffect(() => {
    if (!visible) return;

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    timerHandles.current.initialFocus = setTimeout(() => {
      timerHandles.current.initialFocus = null;
      if (!mountedRef.current) return;
      suppressFocusPinRef.current = true;
      focusElement(closeButtonRef.current);
      suppressFocusPinRef.current = false;
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      const popup = popupRef.current;
      if (!popup || hasActiveModalLayer()) return;
      if (
        event.key !== "Escape"
        && event.key !== "Tab"
        && !popup.contains(document.activeElement)
      ) return;
      handleModalKeyDown(event, popup, document.activeElement, dismiss, pinPopup);
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      clearModalTimers(timerHandles.current);
      restoreFocus(previousFocusRef.current);
      previousFocusRef.current = null;
    };
  }, [dismiss, pinPopup, visible]);

  if (!visible || !entries) return null;

  const mainEntries = entries.filter((e) => entryType(e) !== "fix");
  const fixEntries  = entries.filter((e) => entryType(e) === "fix");

  return createPortal(
    <div
      className={`whats-new-overlay${closing ? " whats-new-overlay--out" : ""}${fading ? " whats-new-overlay--fading" : ""}`}
      onClick={(e) => { if (e.target === e.currentTarget) dismiss(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="whats-new-title"
    >
      <div
        ref={popupRef}
        className="whats-new-popup"
        onClick={handlePopupClick}
        onFocusCapture={handlePopupFocus}
        tabIndex={-1}
      >
        <div className="whats-new-header">
          <div className="whats-new-header-text">
            <span id="whats-new-title" className="whats-new-title">🎉 最近更新</span>
            <span className="whats-new-subtitle">过去 7 天新上线的功能，点击条目查看详情</span>
          </div>
          <button ref={closeButtonRef} type="button" className="whats-new-close" onClick={dismiss} aria-label="关闭">✕</button>
        </div>

        {/* ── Scrollable content area ────────────────────────────────── */}
        <div className="whats-new-scroll-area">
          {/* Feature / improvement entries (prominent) */}
          {mainEntries.length > 0 && (
            <ul className="whats-new-list">
              {mainEntries.map((entry) => (
                <EntryItem key={entry.id} entry={entry} expandedId={expandedId} setExpandedId={setExpandedId} />
              ))}
            </ul>
          )}

          {/* Fix entries — collapsed by default */}
          {fixEntries.length > 0 && (
            <div className="whats-new-fixes">
              <button
                type="button"
                className="whats-new-fixes-toggle"
                onClick={() => setFixesOpen((v) => !v)}
                aria-expanded={fixesOpen}
                aria-controls="whats-new-fixes-list"
              >
                <span className="whats-new-fixes-label">🔧 另有 {fixEntries.length} 项修复</span>
                <span className={`whats-new-expand-icon${fixesOpen ? " whats-new-expand-icon--open" : ""}`}>▼</span>
              </button>
              {fixesOpen && (
                <ul id="whats-new-fixes-list" className="whats-new-list whats-new-list--fixes">
                  {fixEntries.map((entry) => (
                    <EntryItem key={entry.id} entry={entry} expandedId={expandedId} setExpandedId={setExpandedId} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}