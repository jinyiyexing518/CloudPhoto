import { useRef, useState, useCallback } from "react";

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
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const saved = localStorage.getItem("fab-pos");
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const railRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, mx: 0, my: 0, ox: 0, oy: 0 });

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest("button")) return;
    e.preventDefault();
    const rect = railRef.current!.getBoundingClientRect();
    drag.current = { active: true, mx: e.clientX, my: e.clientY, ox: rect.left, oy: rect.top };
    railRef.current!.style.cursor = "grabbing";
    railRef.current!.style.transition = "none";
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current.active) return;
    const { mx, my, ox, oy } = drag.current;
    setPos({ x: ox + e.clientX - mx, y: oy + e.clientY - my });
  }, []);

  const onPointerUp = useCallback(() => {
    if (!drag.current.active) return;
    drag.current.active = false;
    const el = railRef.current;
    if (!el) return;
    el.style.cursor = "";
    el.style.transition = "";
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

  return (
    <div
      ref={railRef}
      className={`workspace-fab-rail${hidden ? " workspace-fab-rail--hidden" : ""}`}
      style={pos ? ({ left: pos.x, top: pos.y, right: "unset", bottom: "unset" } as React.CSSProperties) : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <button className="workspace-fab-pill" onClick={onOpenSidebar}>
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
  );
}
