interface HomeDiagnosticsSnapshot {
  localMomentsCount: number;
  persistenceStatus: "unknown" | "local-only" | "server-synced" | "server-unavailable";
  persistenceUpdatedAt?: string;
}

interface HomeActivityItem {
  id: string;
  icon: string;
  title: string;
  meta: string;
  timestamp: number;
  action: () => void;
}

interface Props {
  activeTab: "timeline" | "folder" | "moments";
  groupLabel: string;
  isStandalone: boolean;
  dashboardExpanded: boolean;
  photoCount: number;
  folderCount: number;
  favoriteCount: number;
  subjectCount: number;
  recentUploadsCount: number;
  latestUploadText: string;
  managedShareLinksCount: number;
  managedShareViewsTotal: number;
  topSharedPhotoName: string | null;
  homeDiagnostics: HomeDiagnosticsSnapshot;
  recentActivity: HomeActivityItem[];
  missingSubjectCount: number;
  uncategorizedCount: number;
  expiringSoonShareLinksCount: number;
  onOpenFolder: () => void;
  onJumpRecentUploads: () => void;
  onToggleDashboard: () => void;
  onOpenManagedShares: () => void;
  onOpenDiagnostics: () => void;
  onJumpMissingSubject: () => void;
  onJumpUncategorized: () => void;
  onOpenExpiringShares: () => void;
}

export default function HomeDashboard({
  activeTab,
  groupLabel,
  isStandalone,
  dashboardExpanded,
  photoCount,
  folderCount,
  favoriteCount,
  subjectCount,
  recentUploadsCount,
  latestUploadText,
  managedShareLinksCount,
  managedShareViewsTotal,
  topSharedPhotoName,
  homeDiagnostics,
  recentActivity,
  missingSubjectCount,
  uncategorizedCount,
  expiringSoonShareLinksCount,
  onOpenFolder,
  onJumpRecentUploads,
  onToggleDashboard,
  onOpenManagedShares,
  onOpenDiagnostics,
  onJumpMissingSubject,
  onJumpUncategorized,
  onOpenExpiringShares,
}: Props) {
  return (
    <>
      <section className="focus-toolbar">
        <div className="focus-toolbar-main">
          <div className="focus-toolbar-title-row">
            <h2 className="focus-toolbar-title">{groupLabel}</h2>
            <span className={`focus-toolbar-mode${isStandalone ? " focus-toolbar-mode--app" : ""}`}>
              {isStandalone ? "App 模式" : "网页模式"}
            </span>
          </div>
          <div className="focus-toolbar-badges">
            <span className="focus-toolbar-badge">{photoCount} 张照片</span>
            <span className="focus-toolbar-badge">{folderCount} 个文件夹</span>
            <span className="focus-toolbar-badge">{favoriteCount} 张收藏</span>
            <span className="focus-toolbar-badge">{subjectCount} 个主题</span>
          </div>
        </div>
        <div className="focus-toolbar-actions">
          {activeTab !== "folder" && (
            <button className="focus-toolbar-btn" onClick={onOpenFolder}>
              去整理照片
            </button>
          )}
          <button className="focus-toolbar-btn focus-toolbar-btn--secondary" onClick={onJumpRecentUploads}>
            最近上传
          </button>
          <button className="focus-toolbar-btn focus-toolbar-btn--ghost" onClick={onToggleDashboard}>
            {dashboardExpanded ? "收起洞察" : "展开洞察"}
          </button>
        </div>
      </section>

      {dashboardExpanded && (
        <section className="dashboard-drawer">
          <section className="insights-hub">
            <article className="insights-hub-card insights-hub-card--recent">
              <div className="insights-hub-kicker">最近上传</div>
              <div className="insights-hub-value">近 7 天新增 {recentUploadsCount} 张</div>
              <div className="insights-hub-meta">最近一次上传：{latestUploadText}</div>
              <button className="insights-hub-btn" onClick={onJumpRecentUploads}>查看最近上传</button>
            </article>

            <article className="insights-hub-card insights-hub-card--share">
              <div className="insights-hub-kicker">分享表现</div>
              <div className="insights-hub-value">有效链接 {managedShareLinksCount} 条</div>
              <div className="insights-hub-meta">累计分享浏览 {managedShareViewsTotal} 次{topSharedPhotoName ? ` · 最热：${topSharedPhotoName}` : ""}</div>
              <button className="insights-hub-btn" onClick={onOpenManagedShares}>管理分享链接</button>
            </article>

            <article className="insights-hub-card insights-hub-card--health">
              <div className="insights-hub-kicker">同步健康</div>
              <div className="insights-hub-value">
                {homeDiagnostics.persistenceStatus === "server-synced"
                  ? "服务端已同步"
                  : homeDiagnostics.persistenceStatus === "server-unavailable"
                  ? "服务端暂不可用"
                  : homeDiagnostics.persistenceStatus === "local-only"
                  ? "当前仅本地保存"
                  : "等待诊断数据"}
              </div>
              <div className="insights-hub-meta">
                本地浏览记录 {homeDiagnostics.localMomentsCount} 条{homeDiagnostics.persistenceUpdatedAt ? ` · 更新于 ${new Date(homeDiagnostics.persistenceUpdatedAt).toLocaleString("zh-CN")}` : ""}
              </div>
              <button className="insights-hub-btn" onClick={onOpenDiagnostics}>打开诊断页</button>
            </article>
          </section>

          <section className="pm-panels">
            <article className="pm-panel pm-panel--activity">
              <div className="pm-panel-head">
                <div>
                  <p className="pm-panel-kicker">动态</p>
                  <h3 className="pm-panel-title">最近活动流</h3>
                </div>
                <span className="pm-panel-badge">{recentActivity.length} 条</span>
              </div>
              <div className="pm-activity-list">
                {recentActivity.length === 0 ? (
                  <p className="pm-panel-empty">还没有足够的上传、分享或同步活动，先从文件夹上传一批照片开始。</p>
                ) : recentActivity.map((item) => (
                  <button key={item.id} className="pm-activity-item" onClick={item.action}>
                    <span className="pm-activity-icon">{item.icon}</span>
                    <div className="pm-activity-copy">
                      <div className="pm-activity-title">{item.title}</div>
                      <div className="pm-activity-meta">{item.meta}</div>
                    </div>
                  </button>
                ))}
              </div>
            </article>

            <article className="pm-panel pm-panel--cleanup">
              <div className="pm-panel-head">
                <div>
                  <p className="pm-panel-kicker">整理</p>
                  <h3 className="pm-panel-title">内容整理助手</h3>
                </div>
                <span className="pm-panel-badge">待处理 {missingSubjectCount + uncategorizedCount}</span>
              </div>
              <div className="pm-action-grid">
                <button className="pm-action-card" onClick={onJumpMissingSubject}>
                  <strong>{missingSubjectCount}</strong>
                  <span>张照片缺少主题</span>
                  <em>去时间线集中补主题</em>
                </button>
                <button className="pm-action-card" onClick={onJumpUncategorized}>
                  <strong>{uncategorizedCount}</strong>
                  <span>张照片还未分类</span>
                  <em>先筛出未分类照片再整理</em>
                </button>
              </div>
            </article>

            <article className="pm-panel pm-panel--watchlist">
              <div className="pm-panel-head">
                <div>
                  <p className="pm-panel-kicker">预警</p>
                  <h3 className="pm-panel-title">分享预警卡</h3>
                </div>
                <span className="pm-panel-badge">{expiringSoonShareLinksCount} 条即将到期</span>
              </div>
              <div className="pm-watchlist-copy">
                <div className="pm-watchlist-line">48 小时内到期：{expiringSoonShareLinksCount} 条</div>
                <div className="pm-watchlist-line">当前最热分享：{topSharedPhotoName ?? "暂无"}</div>
                <div className="pm-watchlist-line">建议：及时延长高价值链接，避免外部访问失效。</div>
              </div>
              <button className="pm-panel-btn" onClick={onOpenExpiringShares}>
                进入分享管理
              </button>
            </article>
          </section>
        </section>
      )}
    </>
  );
}
