import { ReactNode } from "react";
import FilterBar, { FilterState } from "../gallery/FilterBar";

interface MomentsStats {
  total: number;
  favoriteCount: number;
  withSubjectCount: number;
  recentCount: number;
  filteredTotal: number;
}

interface HomeDiagnosticsSnapshot {
  localMomentsCount: number;
  persistenceStatus: "unknown" | "local-only" | "server-synced" | "server-unavailable";
  persistenceUpdatedAt?: string;
}

interface Props {
  activeTab: "timeline" | "folder" | "moments";
  isOpen: boolean;
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  uploaders: string[];
  subjects: string[];
  totalPhotos: number;
  filteredPhotos: number;
  recentUploadsCount: number;
  latestUploadText: string;
  missingSubjectCount: number;
  uncategorizedCount: number;
  managedShareLinksCount: number;
  managedShareViewsTotal: number;
  expiringSoonShareLinksCount: number;
  topSharedPhotoName: string | null;
  homeDiagnostics: HomeDiagnosticsSnapshot;
  momentsStats: MomentsStats;
  onJumpRecentUploads: () => void;
  onJumpMissingSubject: () => void;
  onJumpUncategorized: () => void;
  onOpenManagedShares: () => void;
  onOpenDiagnostics: () => void;
  onClose: () => void;
}

function SidebarSection({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="workspace-sidebar-section">
      <div className="workspace-sidebar-section-head">
        <h3>{title}</h3>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

export default function WorkspaceSidebar({
  activeTab,
  isOpen,
  filters,
  onFiltersChange,
  uploaders,
  subjects,
  totalPhotos,
  filteredPhotos,
  recentUploadsCount,
  latestUploadText,
  missingSubjectCount,
  uncategorizedCount,
  managedShareLinksCount,
  managedShareViewsTotal,
  expiringSoonShareLinksCount,
  topSharedPhotoName,
  homeDiagnostics,
  momentsStats,
  onJumpRecentUploads,
  onJumpMissingSubject,
  onJumpUncategorized,
  onOpenManagedShares,
  onOpenDiagnostics,
  onClose,
}: Props) {
  if (activeTab === "folder") return null;

  return (
    <>
      {isOpen && <div className="workspace-sidebar-backdrop" onClick={onClose} />}
      <aside className={`workspace-sidebar${isOpen ? " workspace-sidebar--open" : ""}`}>
        <div className="workspace-sidebar-shell">
          <div className="workspace-sidebar-topbar">
            <div>
              <span className="workspace-sidebar-kicker">{activeTab === "timeline" ? "Timeline" : "Moments"}</span>
              <h2>{activeTab === "timeline" ? "侧边工具栏" : "片段侧边栏"}</h2>
            </div>
            <button className="workspace-sidebar-close" onClick={onClose}>✕</button>
          </div>

          <div className="workspace-sidebar-content">
            {activeTab === "timeline" ? (
              <>
                <SidebarSection title="时间线筛选" subtitle="筛选、统计和整理动作都收进这里，主区专注看照片。">
                  <FilterBar
                    filters={filters}
                    onChange={onFiltersChange}
                    uploaders={uploaders}
                    subjects={subjects}
                    total={totalPhotos}
                    filtered={filteredPhotos}
                  />
                </SidebarSection>

                <SidebarSection title="快捷整理" subtitle="点击后会直接定位到需要你处理的照片。">
                  <div className="workspace-sidebar-note">最近一次上传：{latestUploadText}</div>
                  <div className="workspace-sidebar-action-grid">
                    <button className="workspace-sidebar-action" onClick={onJumpRecentUploads}>
                      <strong>{recentUploadsCount}</strong>
                      <span>最近上传</span>
                    </button>
                    <button className="workspace-sidebar-action" onClick={onJumpMissingSubject}>
                      <strong>{missingSubjectCount}</strong>
                      <span>缺少主题</span>
                    </button>
                    <button className="workspace-sidebar-action" onClick={onJumpUncategorized}>
                      <strong>{uncategorizedCount}</strong>
                      <span>未分类</span>
                    </button>
                  </div>
                </SidebarSection>
              </>
            ) : (
              <>
                <SidebarSection title="重要片段概览" subtitle="把热度、收藏和最近性收成一个侧边洞察面板。">
                  <div className="workspace-sidebar-stats">
                    <div><strong>{momentsStats.total}</strong><span>重点照片</span></div>
                    <div><strong>{momentsStats.favoriteCount}</strong><span>已收藏</span></div>
                    <div><strong>{momentsStats.withSubjectCount}</strong><span>有主题</span></div>
                    <div><strong>{momentsStats.recentCount}</strong><span>近 30 天</span></div>
                  </div>
                  <div className="workspace-sidebar-note">当前筛选范围：{momentsStats.filteredTotal}</div>
                </SidebarSection>

                <SidebarSection title="分享与同步" subtitle="需要维护时直接在这里进入目标区。">
                  <div className="workspace-sidebar-list">
                    <button className="workspace-sidebar-list-item" onClick={onOpenManagedShares}>
                      <span>有效分享链接</span>
                      <strong>{managedShareLinksCount}</strong>
                    </button>
                    <button className="workspace-sidebar-list-item" onClick={onOpenManagedShares}>
                      <span>累计分享浏览</span>
                      <strong>{managedShareViewsTotal}</strong>
                    </button>
                    <button className="workspace-sidebar-list-item" onClick={onOpenManagedShares}>
                      <span>48 小时内到期</span>
                      <strong>{expiringSoonShareLinksCount}</strong>
                    </button>
                  </div>
                  <div className="workspace-sidebar-note">当前最热分享：{topSharedPhotoName ?? "暂无"}</div>
                  <div className="workspace-sidebar-note">
                    浏览同步：
                    {homeDiagnostics.persistenceStatus === "server-synced"
                      ? " 服务端已同步"
                      : homeDiagnostics.persistenceStatus === "server-unavailable"
                      ? " 服务端暂不可用"
                      : homeDiagnostics.persistenceStatus === "local-only"
                      ? " 当前仅本地保存"
                      : " 等待诊断数据"}
                  </div>
                  <div className="workspace-sidebar-buttons">
                    <button className="workspace-sidebar-primary" onClick={onOpenManagedShares}>打开分享管理</button>
                    <button className="workspace-sidebar-secondary" onClick={onOpenDiagnostics}>打开诊断页</button>
                  </div>
                </SidebarSection>
              </>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
