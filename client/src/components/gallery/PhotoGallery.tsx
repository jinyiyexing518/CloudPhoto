import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Photo,
  updatePhotoSubject,
  renamePhoto as apiRenamePhoto,
  downloadPhotoApi,
  createPhotoShareLink,
  listMomentInsights,
  recordMomentViewApi,
  MomentInsight,
} from "../../services/photoApi";
import { addRecentShareLink } from "../../features/share/shareLinksStore";
import { copyText } from "../../features/share/clipboard";
import PhotoCard from "./PhotoCard";
import { useToast } from "../../contexts/ToastContext";

interface Props {
  photos: Photo[];
  onDelete: (name: string) => void;
  onSubjectUpdate: (name: string, subject: string) => void;
  onRenamePhoto: (name: string, newOriginalName: string) => void;
  onToggleFavorite: (name: string, favorite: boolean) => Promise<boolean>;
  onMovePhoto?: (name: string, toFolder: string) => Promise<boolean>;
  onDownloadStateChange?: (downloading: boolean) => void;
  userName?: string;
  showMemoryHighlights?: boolean;
  showImportantMoments?: boolean;
  momentsMode?: boolean;
  momentsShareViews?: Record<string, number>;
}

interface DateGroup {
  key: string;       // YYYY-MM-DD
  label: string;     // "May 25, 2026"
  photos: Photo[];
}

interface MomentsFilterState {
  query: string;
  viewBand: "all" | "viewed" | "hot" | "unviewed";
  sortBy: "engagement" | "views" | "recent" | "shares" | "recommended";
}

interface MomentCardData {
  photo: Photo;
  rank: number;
  score: number;
  shareViews: number;
  totalViews: number;
  lastViewedAt?: string;
  topViewer?: string;
  engagement: number;
}

const PAGE_SIZE = 120;

function splitDisplayName(value: string): { baseName: string; extension: string } {
  const trimmed = value.trim();
  const lastDot = trimmed.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === trimmed.length - 1) {
    return { baseName: trimmed, extension: "" };
  }
  return {
    baseName: trimmed.slice(0, lastDot),
    extension: trimmed.slice(lastDot),
  };
}

function getEditablePhotoName(photo: Photo): string {
  const displayName = photo.originalName || (photo.name.split("/").pop() ?? photo.name).replace(/^\d+-/, "");
  return splitDisplayName(displayName).baseName || displayName;
}

function buildRenamedPhotoName(photo: Photo, inputName: string): string {
  const currentDisplayName = photo.originalName || (photo.name.split("/").pop() ?? photo.name).replace(/^\d+-/, "");
  const { extension } = splitDisplayName(currentDisplayName);
  return `${inputName.trim()}${extension}`;
}

function getTopViewer(insight?: MomentInsight): string | undefined {
  if (!insight?.viewers) return undefined;
  return Object.entries(insight.viewers).sort((a, b) => b[1] - a[1])[0]?.[0];
}

function getPeakViewDay(insight?: MomentInsight): string | undefined {
  if (!insight?.dailyViews) return undefined;
  return Object.entries(insight.dailyViews).sort((a, b) => b[1] - a[1])[0]?.[0];
}

function groupByDate(photos: Photo[]): DateGroup[] {
  const map = new Map<string, Photo[]>();

  for (const photo of photos) {
    const raw = photo.createdAt ?? photo.lastModified;
    const date = raw ? new Date(raw) : new Date(0);
    const key = date.toISOString().slice(0, 10); // YYYY-MM-DD
    const bucket = map.get(key) ?? [];
    bucket.push(photo);
    map.set(key, bucket);
  }

  // Sort groups newest first
  const groups: DateGroup[] = Array.from(map.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, groupPhotos]) => ({
      key,
      label: new Date(key + "T12:00:00").toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
      photos: groupPhotos,
    }));

  return groups;
}

export default function PhotoGallery({
  photos,
  onDelete,
  onSubjectUpdate,
  onRenamePhoto,
  onToggleFavorite,
  onMovePhoto,
  onDownloadStateChange,
  userName,
  showMemoryHighlights = true,
  showImportantMoments = false,
  momentsMode = false,
  momentsShareViews = {},
}: Props) {
  const showToast = useToast();
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [editingSubject, setEditingSubject] = useState(false);
  const [subjectInput, setSubjectInput] = useState("");
  const [savingSubject, setSavingSubject] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareHours, setShareHours] = useState("24");
  const [moveFolderInput, setMoveFolderInput] = useState("");
  const [moving, setMoving] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [momentsInsightsMap, setMomentsInsightsMap] = useState<Record<string, MomentInsight>>({});
  const [momentsFilters, setMomentsFilters] = useState<MomentsFilterState>({
    query: "",
    viewBand: "all",
    sortBy: "engagement",
  });

  // Batch selection
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBatchConfirm, setShowBatchConfirm] = useState(false);

  useEffect(() => {
    onDownloadStateChange?.(downloading);
    return () => onDownloadStateChange?.(false);
  }, [downloading, onDownloadStateChange]);
  const allSelected = selected.size > 0 && selected.size === photos.length;
  const exitSelectMode = () => { setSelectMode(false); setSelected(new Set()); };
  const togglePhoto = (name: string) => {
    setSelected((prev) => { const next = new Set(prev); next.has(name) ? next.delete(name) : next.add(name); return next; });
  };
  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(photos.map((p) => p.name)));
    }
  };
  const handleBatchDelete = () => {
    for (const name of selected) onDelete(name);
    showToast(`已删除 ${selected.size} 张照片`, "success");
    exitSelectMode();
    setShowBatchConfirm(false);
  };

  const handleBatchRename = async () => {
    if (selected.size === 0) return;
    const prefix = prompt("请输入批量重命名前缀（例如：旅行）");
    if (prefix == null) return;
    const safePrefix = prefix.trim();
    if (!safePrefix) {
      showToast("前缀不能为空", "error");
      return;
    }
    const startRaw = prompt("起始序号（默认 1）", "1");
    const start = Math.max(1, Number.parseInt(startRaw ?? "1", 10) || 1);

    const selectedList = flatPhotos.filter((p) => selected.has(p.name));
    let failed = 0;
    for (let i = 0; i < selectedList.length; i++) {
      const p = selectedList[i];
      const nextName = buildRenamedPhotoName(p, `${safePrefix}-${String(start + i).padStart(3, "0")}`);
      try {
        await apiRenamePhoto(p.name, nextName, userName);
        onRenamePhoto(p.name, nextName);
      } catch {
        failed++;
      }
    }
    if (failed > 0) showToast(`批量重命名完成，失败 ${failed} 张`, "error");
    else showToast(`已重命名 ${selectedList.length} 张照片`, "success");
  };

  // Flat photo list for keyboard navigation (ordered as displayed: by date desc)
  const flatPhotos = useMemo(() => {
    return [...photos].sort((a, b) => {
      const da = (a.createdAt ?? a.lastModified) ?? "";
      const db = (b.createdAt ?? b.lastModified) ?? "";
      return db.localeCompare(da);
    });
  }, [photos]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [photos]);

  const visiblePhotos = useMemo(() => flatPhotos.slice(0, visibleCount), [flatPhotos, visibleCount]);

  const memoryHighlights = useMemo(() => {
    const now = new Date();
    const month = now.getMonth();
    const day = now.getDate();
    return flatPhotos
      .filter((p) => {
        const raw = p.createdAt ?? p.lastModified;
        if (!raw) return false;
        const d = new Date(raw);
        return d.getMonth() === month && d.getDate() === day && d.getFullYear() < now.getFullYear();
      })
      .slice(0, 8);
  }, [flatPhotos]);

  const importantMoments = useMemo(() => {
    const scored = [...flatPhotos].map((p) => {
      const ts = new Date(p.createdAt ?? p.lastModified ?? 0).getTime();
      const recencyDays = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
      const score = (p.favorite ? 120 : 0) + (p.subject ? 20 : 0) + Math.max(0, 40 - recencyDays);
      return { p, score };
    });
    return scored.sort((a, b) => b.score - a.score).map((x) => x.p).slice(0, 10);
  }, [flatPhotos]);

  const getMomentScore = useCallback((photo: Photo): number => {
    const ts = new Date(photo.createdAt ?? photo.lastModified ?? 0).getTime();
    const recencyDays = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
    return (photo.favorite ? 120 : 0) + (photo.subject ? 20 : 0) + Math.max(0, 40 - recencyDays);
  }, []);

  useEffect(() => {
    if (!momentsMode) return;
    let cancelled = false;
    const load = async () => {
      try {
        const map = await listMomentInsights(flatPhotos.map((photo) => photo.name));
        if (!cancelled) setMomentsInsightsMap(map);
      } catch {
        if (!cancelled) setMomentsInsightsMap({});
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [flatPhotos, momentsMode]);

  const momentCards = useMemo(() => {
    const filteredPhotos = flatPhotos.filter((photo) => {
      const insight = momentsInsightsMap[photo.name];
      const totalViews = insight?.totalViews ?? 0;
      const haystack = `${photo.originalName ?? ""} ${photo.subject ?? ""} ${photo.createdBy ?? ""}`.toLowerCase();
      if (momentsFilters.query && !haystack.includes(momentsFilters.query.toLowerCase())) return false;
      if (momentsFilters.viewBand === "viewed" && totalViews === 0) return false;
      if (momentsFilters.viewBand === "hot" && totalViews < 3) return false;
      if (momentsFilters.viewBand === "unviewed" && totalViews > 0) return false;
      return true;
    });

    const ranked = filteredPhotos.map((photo) => {
      const insight = momentsInsightsMap[photo.name];
      const shareViews = momentsShareViews[photo.name] ?? 0;
      const score = Math.round(getMomentScore(photo));
      const totalViews = insight?.totalViews ?? 0;
      const lastViewedAt = insight?.lastViewedAt;
      const recentBoost = lastViewedAt
        ? Math.max(0, 72 - (Date.now() - new Date(lastViewedAt).getTime()) / (1000 * 60 * 60))
        : 0;
      const engagement = score + totalViews * 24 + shareViews * 10 + recentBoost;
      return {
        photo,
        rank: 0,
        score,
        shareViews,
        totalViews,
        lastViewedAt,
        topViewer: getTopViewer(insight),
        engagement,
      } satisfies MomentCardData;
    });

    ranked.sort((a, b) => {
      switch (momentsFilters.sortBy) {
        case "views":
          return b.totalViews - a.totalViews || b.engagement - a.engagement;
        case "recent":
          return (new Date(b.lastViewedAt ?? 0).getTime() - new Date(a.lastViewedAt ?? 0).getTime()) || b.engagement - a.engagement;
        case "shares":
          return b.shareViews - a.shareViews || b.engagement - a.engagement;
        case "recommended":
          return b.score - a.score || b.engagement - a.engagement;
        default:
          return b.engagement - a.engagement;
      }
    });

    return ranked.slice(0, visibleCount).map((item, index) => ({ ...item, rank: index + 1 }));
  }, [flatPhotos, getMomentScore, momentsFilters, momentsInsightsMap, momentsShareViews, visibleCount]);

  const modalPhotos = useMemo(
    () => (momentsMode ? momentCards.map((item) => item.photo) : flatPhotos),
    [flatPhotos, momentCards, momentsMode],
  );

  const selectedMomentInsight = selectedPhoto ? momentsInsightsMap[selectedPhoto.name] : undefined;

  const trackMomentView = useCallback((photo: Photo) => {
    if (!momentsMode) return;
    const viewer = (userName?.trim() || "匿名用户").slice(0, 80);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    setMomentsInsightsMap((prev) => {
      const current = prev[photo.name] ?? {
        photoName: photo.name,
        totalViews: 0,
        viewers: {},
        dailyViews: {},
      };
      return {
        ...prev,
        [photo.name]: {
          ...current,
          totalViews: (current.totalViews ?? 0) + 1,
          lastViewedAt: now.toISOString(),
          lastViewedBy: viewer,
          viewers: {
            ...(current.viewers ?? {}),
            [viewer]: ((current.viewers ?? {})[viewer] ?? 0) + 1,
          },
          dailyViews: {
            ...(current.dailyViews ?? {}),
            [today]: ((current.dailyViews ?? {})[today] ?? 0) + 1,
          },
        },
      };
    });

    void recordMomentViewApi(photo.name, userName).then((serverItem) => {
      if (!serverItem) return;
      setMomentsInsightsMap((prev) => ({
        ...prev,
        [photo.name]: serverItem,
      }));
    }).catch(() => {
      // Keep optimistic local state on transient failures.
    });
  }, [momentsMode, userName]);

  const navigateToPhoto = useCallback((idx: number) => {
    const photo = modalPhotos[idx];
    if (!photo) return;
    setSelectedIdx(idx);
    setSelectedPhoto(photo);
    setEditingSubject(false);
    setSubjectInput(photo.subject ?? "");
    setEditingName(false);
    setNameInput(getEditablePhotoName(photo));
    setMoveFolderInput(photo.folder ?? "");
    setDownloading(false);
    trackMomentView(photo);
  }, [modalPhotos, trackMomentView]);

  // Keyboard navigation when modal is open
  useEffect(() => {
    if (selectedIdx === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setSelectedIdx(null); setSelectedPhoto(null); }
      if (e.key === "ArrowLeft" && selectedIdx > 0) navigateToPhoto(selectedIdx - 1);
      if (e.key === "ArrowRight" && selectedIdx < modalPhotos.length - 1) navigateToPhoto(selectedIdx + 1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedIdx, modalPhotos.length, navigateToPhoto]);

  const openModal = (photo: Photo) => {
    const idx = modalPhotos.findIndex((p) => p.name === photo.name);
    setSelectedIdx(idx >= 0 ? idx : null);
    setSelectedPhoto(photo);
    setEditingSubject(false);
    setSubjectInput(photo.subject ?? "");
    setEditingName(false);
    setNameInput(getEditablePhotoName(photo));
    setMoveFolderInput(photo.folder ?? "");
    setDownloading(false);
    trackMomentView(photo);
  };

  const saveSubject = async () => {
    if (!selectedPhoto) return;
    setSavingSubject(true);
    try {
      await updatePhotoSubject(selectedPhoto.name, subjectInput.trim(), userName);
      onSubjectUpdate(selectedPhoto.name, subjectInput.trim());
      setSelectedPhoto({ ...selectedPhoto, subject: subjectInput.trim() });
      setEditingSubject(false);
    } finally {
      setSavingSubject(false);
    }
  };

  const saveName = async () => {
    if (!selectedPhoto) return;
    const trimmed = nameInput.trim();
    if (!trimmed) return;
    const finalName = buildRenamedPhotoName(selectedPhoto, trimmed);
    setSavingName(true);
    try {
      await apiRenamePhoto(selectedPhoto.name, finalName, userName);
      onRenamePhoto(selectedPhoto.name, finalName);
      setSelectedPhoto({ ...selectedPhoto, originalName: finalName });
      setEditingName(false);
    } finally {
      setSavingName(false);
    }
  };

  const handleDownload = async () => {
    if (!selectedPhoto) return;
    setDownloading(true);
    try {
      const filename = selectedPhoto.originalName || selectedPhoto.name.replace(/^\d+-/, "");
      await downloadPhotoApi(selectedPhoto.name, filename);
    } finally {
      setDownloading(false);
    }
  };

  const handleShare = async () => {
    if (!selectedPhoto) return;
    const hours = Math.max(1, Math.min(168, Number.parseInt(shareHours, 10) || 24));
    setSharing(true);
    try {
      const { url, directUrl, expiresAt } = await createPhotoShareLink(selectedPhoto.name, hours);
      const finalUrl = directUrl ?? url;
      const copied = await copyText(finalUrl);
      if (!copied) {
        window.prompt("复制分享链接", finalUrl);
      }
      const displayName = selectedPhoto.originalName || (() => { const b = selectedPhoto.name.split("/").pop() ?? selectedPhoto.name; return b.replace(/^\d+-/, ""); })();
      addRecentShareLink({
        photoName: selectedPhoto.name,
        displayName,
        url: finalUrl,
        expiresAt,
      });
      showToast(copied ? `分享链接已复制（到期：${formatDate(expiresAt)}）` : `分享链接已生成（到期：${formatDate(expiresAt)}），请手动复制`, "success");
    } catch (e) {
      showToast(e instanceof Error ? `创建分享链接失败：${e.message}` : "创建分享链接失败", "error");
    } finally {
      setSharing(false);
    }
  };

  const handleModalFavoriteToggle = async () => {
    if (!selectedPhoto) return;
    const next = !selectedPhoto.favorite;
    const ok = await onToggleFavorite(selectedPhoto.name, next);
    if (ok) {
      setSelectedPhoto({ ...selectedPhoto, favorite: next });
    }
  };

  const handleModalMove = async () => {
    if (!selectedPhoto || !onMovePhoto) return;
    const target = moveFolderInput.trim();
    setMoving(true);
    try {
      const ok = await onMovePhoto(selectedPhoto.name, target);
      if (ok) {
        showToast(target ? `已移动到文件夹：${target}` : "已移动到根目录", "success");
        setSelectedIdx(null);
        setSelectedPhoto(null);
      }
    } finally {
      setMoving(false);
    }
  };

  const handleModalDelete = () => {
    if (!selectedPhoto) return;
    const displayName = selectedPhoto.originalName || (selectedPhoto.name.split("/").pop() ?? selectedPhoto.name).replace(/^\d+-/, "");
    if (!window.confirm(`确认删除照片：${displayName}？`)) return;
    onDelete(selectedPhoto.name);
    setSelectedIdx(null);
    setSelectedPhoto(null);
  };

  if (photos.length === 0) {
    return (
      <div className="empty-gallery">
        <div className="empty-gallery-icon">📷</div>
        <p className="empty-gallery-title">还没有照片</p>
        <p className="empty-gallery-sub">切换到「文件夹」视图，选择文件夹后上传照片</p>
      </div>
    );
  }

  const groups = groupByDate(visiblePhotos);
  const hasMore = visibleCount < flatPhotos.length;

  return (
    <>
      {/* Batch selection toolbar */}
      <div className="gallery-batch-toolbar">
        <button
          className={`batch-select-btn${selectMode ? " active" : ""}`}
          onClick={() => { setSelectMode((v) => !v); setSelected(new Set()); }}
        >
          {selectMode ? `取消选择` : "批量选择"}
        </button>
        {selectMode && (
          <>
            <button className="batch-select-btn" onClick={toggleSelectAll}>
              {allSelected ? "取消全选" : "全选"}
            </button>
            <span className="batch-count">已选 {selected.size} 张</span>
          </>
        )}
        {selectMode && selected.size > 0 && (
          <>
            <button className="batch-select-btn" onClick={() => void handleBatchRename()}>
              重命名 ({selected.size})
            </button>
            <button className="batch-delete-btn" onClick={() => setShowBatchConfirm(true)}>
              删除 ({selected.size})
            </button>
          </>
        )}
      </div>

      {!selectMode && showMemoryHighlights && memoryHighlights.length > 0 && (
        <section className="insight-section">
          <h2 className="insight-title">📅 历史回忆</h2>
          <div className="insight-strip">
            {memoryHighlights.map((photo) => (
              <PhotoCard
                key={`memory-${photo.name}`}
                photo={photo}
                onClick={() => openModal(photo)}
                onDelete={() => onDelete(photo.name)}
                onToggleFavorite={(next) => { void onToggleFavorite(photo.name, next); }}
              />
            ))}
          </div>
        </section>
      )}

      {!selectMode && showImportantMoments && importantMoments.length > 0 && (
        <section className="insight-section">
          <h2 className="insight-title">⭐ 重要片段</h2>
          <div className="insight-strip">
            {importantMoments.map((photo) => (
              <PhotoCard
                key={`important-${photo.name}`}
                photo={photo}
                onClick={() => openModal(photo)}
                onDelete={() => onDelete(photo.name)}
                onToggleFavorite={(next) => { void onToggleFavorite(photo.name, next); }}
              />
            ))}
          </div>
        </section>
      )}

      {momentsMode ? (
        <section className="moments-board">
          <div className="moments-filter-bar">
            <input
              className="moments-filter-input"
              type="search"
              placeholder="按文件名 / 主题 / 上传者搜索"
              value={momentsFilters.query}
              onChange={(e) => setMomentsFilters((prev) => ({ ...prev, query: e.target.value }))}
            />
            <select
              className="moments-filter-select"
              value={momentsFilters.viewBand}
              onChange={(e) => setMomentsFilters((prev) => ({ ...prev, viewBand: e.target.value as MomentsFilterState["viewBand"] }))}
            >
              <option value="all">全部浏览状态</option>
              <option value="viewed">看过的</option>
              <option value="hot">高频查看</option>
              <option value="unviewed">还没看过</option>
            </select>
            <select
              className="moments-filter-select"
              value={momentsFilters.sortBy}
              onChange={(e) => setMomentsFilters((prev) => ({ ...prev, sortBy: e.target.value as MomentsFilterState["sortBy"] }))}
            >
              <option value="engagement">按互动热度排序</option>
              <option value="views">按查看次数排序</option>
              <option value="recent">按最近查看排序</option>
              <option value="shares">按分享浏览排序</option>
              <option value="recommended">按推荐值排序</option>
            </select>
          </div>
          <div className="moments-grid">
            {momentCards.map(({ photo, rank, score, shareViews, totalViews, lastViewedAt, topViewer, engagement }) => {
              const raw = photo.createdAt ?? photo.lastModified;
              const dateText = raw ? formatDate(raw) : "—";
              const display = photo.originalName || (photo.name.split("/").pop() ?? photo.name).replace(/^\d+-/, "");
              const engagementPercent = Math.max(6, Math.min(100, Math.round(engagement / 4)));
              const rankBadge = rank <= 3 ? (rank === 1 ? "🏆" : rank === 2 ? "🥈" : "🥉") : "⭐";
              return (
                <article key={photo.name} className="moments-card" onClick={() => openModal(photo)}>
                  <div className="moments-rank">{rankBadge} #{rank}</div>
                  <img src={photo.url} alt={display} loading="lazy" className="moments-thumb" />
                  <div className="moments-card-body">
                    <div className="moments-title-row">
                      <div className="moments-title" title={display}>{display}</div>
                      <span className="moments-score-pill">热度 {Math.round(engagement)}</span>
                    </div>
                    <div className="moments-chips">
                      <span>查看 {totalViews}</span>
                      <span>推荐值 {score}</span>
                      <span>分享浏览 {shareViews}</span>
                    </div>
                    <div className="moments-energy">
                      <span className="moments-energy-label">热度进度</span>
                      <span className="moments-energy-track"><span className="moments-energy-fill" style={{ width: `${engagementPercent}%` }} /></span>
                    </div>
                    <div className="moments-meta">👤 {photo.createdBy ?? "未知"} · {dateText}</div>
                    <div className="moments-meta">最近查看：{lastViewedAt ? formatDate(lastViewedAt) : "还没人看过"}{topViewer ? ` · 常看：${topViewer}` : ""}</div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : (
        groups.map((group) => (
          <section key={group.key} className="date-group">
            <h2 className="date-group-label">
              <span className="date-group-dot" />
              {group.label}
              <span className="date-group-count">{group.photos.length}</span>
            </h2>
            <div className="photo-grid">
              {group.photos.map((photo) => (
                <PhotoCard
                  key={photo.name}
                  photo={photo}
                  onClick={() => !selectMode && openModal(photo)}
                  onDelete={() => onDelete(photo.name)}
                  onToggleFavorite={(next) => { void onToggleFavorite(photo.name, next); }}
                  selected={selectMode ? selected.has(photo.name) : undefined}
                  onSelect={selectMode ? (e) => { e.stopPropagation(); togglePhoto(photo.name); } : undefined}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {hasMore && (
        <div className="timeline-more-wrap">
          <button className="timeline-more-btn" onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}>
            加载更多 ({visibleCount}/{flatPhotos.length})
          </button>
        </div>
      )}

      {selectedPhoto && (
        <div
          className="modal-overlay"
          onClick={() => { setSelectedIdx(null); setSelectedPhoto(null); }}
        >
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close"
              onClick={() => { setSelectedIdx(null); setSelectedPhoto(null); }}
            >
              ✕
            </button>
            {selectedIdx !== null && selectedIdx > 0 && (
              <button className="modal-nav modal-nav--prev" onClick={() => navigateToPhoto(selectedIdx - 1)} title="上一张 (←)">‹</button>
            )}
            {selectedIdx !== null && selectedIdx < modalPhotos.length - 1 && (
              <button className="modal-nav modal-nav--next" onClick={() => navigateToPhoto(selectedIdx + 1)} title="下一张 (→)">›</button>
            )}
            <img src={selectedPhoto.url} alt={selectedPhoto.name} />
            <div className="modal-info">
              <div className="modal-info-row">
                {editingName ? (
                  <span className="modal-subject-cell" style={{ flex: 1 }}>
                    <input
                      autoFocus
                      className="modal-subject-input"
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveName();
                        if (e.key === "Escape") setEditingName(false);
                      }}
                      maxLength={120}
                    />
                    <button className="modal-subject-save" onClick={() => void saveName()} disabled={savingName}>
                      {savingName ? "..." : "保存"}
                    </button>
                    <button className="modal-subject-cancel" onClick={() => setEditingName(false)}>✕</button>
                  </span>
                ) : (
                  <span className="modal-filename">
                    <span
                      className="modal-filename-text"
                      title={selectedPhoto.originalName || (() => { const b = selectedPhoto.name.split("/").pop() ?? selectedPhoto.name; return b.replace(/^\d+-/, ""); })()}
                    >
                      {selectedPhoto.originalName || (() => { const b = selectedPhoto.name.split("/").pop() ?? selectedPhoto.name; return b.replace(/^\d+-/, ""); })()}
                    </span>
                    <button className="modal-rename-btn" title="重命名" onClick={() => setEditingName(true)}>✏ 重命名</button>
                  </span>
                )}
                <span className="modal-size">{formatSize(selectedPhoto.size)}</span>
              </div>

              {/* Download button */}
              <button
                className="modal-download-btn"
                onClick={() => void handleDownload()}
                disabled={downloading}
              >
                {downloading ? "⏳ 下载中…" : "⬇ 下载原图"}
              </button>

              <div className="modal-actions-row">
                <button
                  className={`modal-favorite-btn${selectedPhoto.favorite ? " modal-favorite-btn--on" : ""}`}
                  onClick={() => void handleModalFavoriteToggle()}
                >
                  {selectedPhoto.favorite ? "★ 取消收藏" : "☆ 收藏"}
                </button>
                {onMovePhoto && (
                  <>
                    <input
                      className="modal-folder-input"
                      value={moveFolderInput}
                      onChange={(e) => setMoveFolderInput(e.target.value)}
                      placeholder="移动到文件夹（留空=根目录）"
                    />
                    <button className="modal-move-btn" onClick={() => void handleModalMove()} disabled={moving}>
                      {moving ? "移动中…" : "📁 移动"}
                    </button>
                  </>
                )}
                <button className="modal-delete-btn" onClick={handleModalDelete}>🗑 删除</button>
              </div>

              <div className="modal-share-row">
                <select className="modal-move-select" value={shareHours} onChange={(e) => setShareHours(e.target.value)}>
                  <option value="1">1 小时</option>
                  <option value="24">24 小时</option>
                  <option value="72">3 天</option>
                  <option value="168">7 天</option>
                </select>
                <button className="modal-share-btn" onClick={() => void handleShare()} disabled={sharing}>
                  {sharing ? "创建中…" : "🔗 复制分享链接"}
                </button>
              </div>
              <div className="modal-detail-grid">
                <span className="modal-detail-label">Subject</span>
                <span className="modal-detail-value modal-subject-cell">
                  {editingSubject ? (
                    <>
                      <input
                        autoFocus
                        className="modal-subject-input"
                        value={subjectInput}
                        onChange={(e) => setSubjectInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void saveSubject(); if (e.key === "Escape") setEditingSubject(false); }}
                        placeholder="Add subject..."
                        maxLength={80}
                      />
                      <button className="modal-subject-save" onClick={() => void saveSubject()} disabled={savingSubject}>
                        {savingSubject ? "..." : "Save"}
                      </button>
                      <button className="modal-subject-cancel" onClick={() => setEditingSubject(false)}>✕</button>
                    </>
                  ) : (
                    <>
                      <span>{selectedPhoto.subject || <em className="modal-empty">None</em>}</span>
                      <button className="modal-edit-btn" onClick={() => setEditingSubject(true)}>✏</button>
                    </>
                  )}
                </span>

                <span className="modal-detail-label">Created by</span>
                <span className="modal-detail-value">{selectedPhoto.createdBy ?? "—"}</span>

                <span className="modal-detail-label">Uploaded at</span>
                <span className="modal-detail-value">{selectedPhoto.createdAt ? formatDate(selectedPhoto.createdAt) : "—"}</span>

                <span className="modal-detail-label">Last modified by</span>
                <span className="modal-detail-value">{selectedPhoto.lastModifiedBy ?? "—"}</span>

                <span className="modal-detail-label">Last modified at</span>
                <span className="modal-detail-value">
                  {selectedPhoto.lastModifiedAt
                    ? formatDate(selectedPhoto.lastModifiedAt)
                    : selectedPhoto.lastModified
                    ? formatDate(selectedPhoto.lastModified)
                    : "—"}
                </span>

                <span className="modal-detail-label">Type</span>
                <span className="modal-detail-value">{selectedPhoto.contentType ?? "—"}</span>

                <span className="modal-detail-label">Moment score</span>
                <span className="modal-detail-value">{Math.round(getMomentScore(selectedPhoto))}</span>

                <span className="modal-detail-label">Share views</span>
                <span className="modal-detail-value">{momentsShareViews[selectedPhoto.name] ?? 0}</span>

                {momentsMode && (
                  <>
                    <span className="modal-detail-label">查看次数</span>
                    <span className="modal-detail-value">{selectedMomentInsight?.totalViews ?? 0}</span>

                    <span className="modal-detail-label">最近查看</span>
                    <span className="modal-detail-value">{selectedMomentInsight?.lastViewedAt ? formatDate(selectedMomentInsight.lastViewedAt) : "暂无"}</span>

                    <span className="modal-detail-label">常看用户</span>
                    <span className="modal-detail-value">{getTopViewer(selectedMomentInsight) ?? "暂无"}</span>

                    <span className="modal-detail-label">浏览高峰日</span>
                    <span className="modal-detail-value">{getPeakViewDay(selectedMomentInsight) ?? "暂无"}</span>
                  </>
                )}
              </div>
            </div>
            {modalPhotos.length > 1 && (
              <div className="modal-nav-hint">← → 键切换 · Esc 关闭</div>
            )}
          </div>
        </div>
      )}

      {/* Batch delete confirmation */}
      {showBatchConfirm && (
        <div className="confirm-overlay" onClick={() => setShowBatchConfirm(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-title">确认删除 {selected.size} 张照片？</p>
            <p className="confirm-filename">此操作不可撤销</p>
            <div className="confirm-actions">
              <button className="confirm-cancel-btn" onClick={() => setShowBatchConfirm(false)}>取消</button>
              <button className="confirm-delete-btn" onClick={handleBatchDelete}>删除</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string | Date): string {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}
