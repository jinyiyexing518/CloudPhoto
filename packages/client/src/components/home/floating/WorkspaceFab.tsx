import { useRef, useState, useCallback, useEffect } from "react";

interface Props {
  activeTab: "timeline" | "moments";
  hidden: boolean;
  /** Count of currently active filters — displayed as a badge on the pill */
  filterCount?: number;
  onOpenSidebar: () => void;
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
  const compactWasExpanded = useRef(false);
  const drag = useRef({ active: false, hasDragged: false, mx: 0, my: 0, ox: 0, oy: 0 });

  useEffect(() => {
    if (compactExpanded) {
      compactFirstActionRef.current?.focus();
    } else if (compactWasExpanded.current) {
      compactToggleRef.current?.focus();
    }
    compactWasExpanded.current = compactExpanded;
  }, [compactExpanded]);

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
        <button ref={compactFirstActionRef} className="workspace-fab-pill" onClick={onOpenSidebar}>
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
          <button className="workspace-fab-chip" onClick={onPrimaryChipClick}>
            {activeTab === "timeline" ? <span style={{ lineHeight: 1.2 }}>最近<br />上传</span> : <span style={{ lineHeight: 1.2 }}>分享<br />管理</span>}
          </button>
          <button className="workspace-fab-chip workspace-fab-chip--secondary" onClick={onSecondaryChipClick}>
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
