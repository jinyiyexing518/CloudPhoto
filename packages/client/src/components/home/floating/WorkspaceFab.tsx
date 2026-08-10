import { useRef, useState, useCallback, useEffect, type MouseEvent as ReactMouseEvent } from "react";

interface Props {
  activeTab: "timeline" | "moments";
  hidden: boolean;
  /** Count of currently active filters — displayed as a badge on the pill */
  filterCount?: number;
  onOpenSidebar: (trigger: HTMLButtonElement) => void;
  onPrimaryChipClick: () => void;
  onSecondaryChipClick: () => void;
}

export default function WorkspaceFab({
  activeTab,
  hidden,
  filterCount = 0,
  onOpenSidebar,
  onPrimaryChipClick,
  onSecondaryChipClick,
}: Props) {
  const [compactExpanded, setCompactExpanded] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const saved = localStorage.getItem("fab-pos");
      if (!saved) return null;
      const p = JSON.parse(saved) as { x: number; y: number };
      // Discard positions that fall outside the current viewport (e.g. from a different screen size)
      if (
        typeof p.x !== "number" || typeof p.y !== "number" ||
        p.x < 0 || p.x > window.innerWidth - 50 ||
        p.y < 0 || p.y > window.innerHeight - 50
      ) {
        localStorage.removeItem("fab-pos");
        return null;
      }
      return p;
    } catch {
      return null;
    }
  });

  const railRef = useRef<HTMLDivElement>(null);
  const compactToggleRef = useRef<HTMLButtonElement>(null);
  const compactFirstActionRef = useRef<HTMLButtonElement>(null);
  const primaryChipRef = useRef<HTMLButtonElement>(null);
  const secondaryChipRef = useRef<HTMLButtonElement>(null);
  const drag = useRef({ active: false, hasDragged: false, mx: 0, my: 0, ox: 0, oy: 0 });

  useEffect(() => {
    if (compactExpanded) {
      compactFirstActionRef.current?.focus();
    }
  }, [compactExpanded]);

  useEffect(() => {
    if (!compactExpanded) return;
    const collapseOutside = (event: PointerEvent) => {
      if (railRef.current?.contains(event.target as Node)) return;
      setCompactExpanded(false);
    };
    document.addEventListener("pointerdown", collapseOutside);
    return () => document.removeEventListener("pointerdown", collapseOutside);
  }, [compactExpanded]);

  const runCompactAction = useCallback((
    action: () => void,
    desktopTarget: React.RefObject<HTMLButtonElement>,
    restoreFocus: boolean,
  ) => {
    const compact = window.matchMedia("(max-width: 480px)").matches;
    setCompactExpanded(false);
    if (compact && !restoreFocus) compactToggleRef.current?.focus();
    action();
    if (restoreFocus) {
      requestAnimationFrame(() => {
        if (compact) compactToggleRef.current?.focus();
        else desktopTarget.current?.focus();
      });
    }
  }, []);

  const openSidebarFromFab = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    const compact = window.matchMedia("(max-width: 480px)").matches;
    const restoreTarget = compact ? compactToggleRef.current : event.currentTarget;
    setCompactExpanded(false);
    onOpenSidebar(restoreTarget ?? event.currentTarget);
  }, [onOpenSidebar]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest("button")) return;
    e.preventDefault();
    const rect = railRef.current!.getBoundingClientRect();
    drag.current = { active: true, hasDragged: false, mx: e.clientX, my: e.clientY, ox: rect.left, oy: rect.top };
    railRef.current!.style.transition = "none";
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current.active) return;
    const { mx, my, ox, oy } = drag.current;
    const dx = e.clientX - mx;
    const dy = e.clientY - my;
    // Require at least 8px movement before treating as a real drag — prevents
    // accidental repositioning when the user scrolls or taps over the FAB.
    if (!drag.current.hasDragged) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      drag.current.hasDragged = true;
      railRef.current!.style.cursor = "grabbing";
    }
    setPos({ x: ox + dx, y: oy + dy });
  }, []);

  const onPointerUp = useCallback(() => {
    if (!drag.current.active) return;
    const wasDragged = drag.current.hasDragged;
    drag.current.active = false;
    drag.current.hasDragged = false;
    const el = railRef.current;
    if (!el) return;
    el.style.cursor = "";
    el.style.transition = "";
    // Only persist position if the user actually dragged (not just tapped)
    if (!wasDragged) return;
    const maxX = window.innerWidth - el.offsetWidth - 8;
    const maxY = window.innerHeight - el.offsetHeight - 8;
    setPos((prev) => {
      if (!prev) return prev;
      const nx = Math.max(8, Math.min(prev.x, maxX));
      const ny = Math.max(8, Math.min(prev.y, maxY));
      localStorage.setItem("fab-pos", JSON.stringify({ x: nx, y: ny }));
      return { x: nx, y: ny };
    });
  }, []);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    if (!compactExpanded) return;
    event.preventDefault();
    setCompactExpanded(false);
    requestAnimationFrame(() => compactToggleRef.current?.focus());
  }, [compactExpanded]);

  return (
    <div
      ref={railRef}
      className={`workspace-fab-rail${compactExpanded ? " workspace-fab-rail--expanded" : ""}${hidden ? " workspace-fab-rail--hidden" : ""}`}
      style={pos ? ({ left: pos.x, top: pos.y, right: "unset", bottom: "unset" } as React.CSSProperties) : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <div id="workspace-fab-actions" className="workspace-fab-actions">
        <button ref={compactFirstActionRef} className="workspace-fab-pill" onClick={openSidebarFromFab}>
          <span className="workspace-fab-icon">{activeTab === "timeline" ? "⚙" : "✦"}</span>
          <span className="workspace-fab-copy">
            <strong>{activeTab === "timeline" ? "筛选与整理" : "片段洞察"}</strong>
            <em>{activeTab === "timeline" ? "打开时间线侧栏" : "打开重要片段侧栏"}</em>
          </span>
          {filterCount > 0 && (
            <span className="workspace-fab-filter-badge" title={`${filterCount}个筛选条件已激活`}>
              {filterCount}
            </span>
          )}
        </button>
        <div className="workspace-fab-chip-group">
          <button ref={primaryChipRef} className="workspace-fab-chip" onClick={() => runCompactAction(onPrimaryChipClick, primaryChipRef, activeTab === "timeline")}>
            {activeTab === "timeline" ? <span style={{ lineHeight: 1.2 }}>最近<br />上传</span> : <span style={{ lineHeight: 1.2 }}>分享<br />管理</span>}
          </button>
          <button ref={secondaryChipRef} className="workspace-fab-chip workspace-fab-chip--secondary" onClick={() => runCompactAction(onSecondaryChipClick, secondaryChipRef, activeTab === "timeline")}>
            {activeTab === "timeline" ? <span style={{ lineHeight: 1.2 }}>去<br />整理</span> : <span style={{ lineHeight: 1.2 }}>看<br />诊断</span>}
          </button>
        </div>
      </div>
      <button
        ref={compactToggleRef}
        className="workspace-fab-compact-toggle"
        type="button"
        aria-expanded={compactExpanded}
        aria-controls="workspace-fab-actions"
        aria-label={compactExpanded ? "收起快捷操作" : "展开快捷操作"}
        onClick={() => setCompactExpanded((expanded) => !expanded)}
      >
        <span aria-hidden="true">{compactExpanded ? "×" : "⋮"}</span>
      </button>
    </div>
  );
}
