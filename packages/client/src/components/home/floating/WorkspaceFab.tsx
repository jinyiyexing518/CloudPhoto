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
  return (
    <div className={`workspace-fab-rail${hidden ? " workspace-fab-rail--hidden" : ""}`}>
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
          {activeTab === "timeline" ? "最近上传" : <span style={{ lineHeight: 1.2 }}>分享<br/>管理</span>}
        </button>
        <button className="workspace-fab-chip workspace-fab-chip--secondary" onClick={onSecondaryChipClick}>
          {activeTab === "timeline" ? "去整理" : "看诊断"}
        </button>
      </div>
    </div>
  );
}
