import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react";
import {
  Photo,
  updatePhotoSubject,
  renamePhoto as apiRenamePhoto,
  downloadPhotoApi,
  createPhotoShareLink,
  listMomentInsights,
  recordMomentViewApi,
  MomentInsight,
  ManagedMomentsUnavailableError,
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
  onShareCreated?: (photoName: string) => void;
  userName?: string;
  showMemoryHighlights?: boolean;
  showImportantMoments?: boolean;
  momentsMode?: boolean;
  momentsShareViews?: Record<string, number>;
  focusPhotoName?: string;
  focusRequestKey?: number;
  /** When true, oldest date groups appear first instead of newest */
  reverseOrder?: boolean;
}

interface DateGroup {
  key: string;       // YYYY-MM-DD
  label: string;     // "May 25, 2026"
  photos: Photo[];
}

interface MomentsFilterState {
  query: string;
  engagementBand: "all" | "high" | "medium" | "low";
  recommendationBand: "all" | "high" | "favorite" | "fresh";
  viewBand: "all" | "hot" | "viewed" | "unviewed";
  shareBand: "all" | "shared" | "viral" | "notShared";
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
const MOMENT_SCORE_FAVORITE_WEIGHT = 120;
const MOMENT_SCORE_SUBJECT_WEIGHT = 20;
const MOMENT_SCORE_RECENCY_MAX = 40;
const MOMENT_HOT_VIEW_THRESHOLD = 3;
const MOMENT_ENGAGEMENT_VIEW_WEIGHT = 24;
const MOMENT_ENGAGEMENT_RECENT_WINDOW_HOURS = 72;
const MOMENTS_LOCAL_STORAGE_KEY = "cloudphoto_moments_insights_v1";
const MOMENTS_DIAGNOSTICS_KEY = "cloudphoto_moments_diagnostics_v1";

type MomentsDiagnosticsStatus = "unknown" | "local-only" | "server-synced" | "server-unavailable";

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

function normalizeRenameBaseName(value: string): string {
  const trimmed = value.trim();
  const lastDot = trimmed.lastIndexOf(".");
  if (lastDot <= 0) return trimmed;
  const suffix = trimmed.slice(lastDot + 1);
  if (!/^[a-z0-9]{1,10}$/i.test(suffix)) return trimmed;
  return trimmed.slice(0, lastDot).trimEnd();
}

function getPhotoExtension(photo: Photo): string {
  const displayName = photo.originalName || (photo.name.split("/").pop() ?? photo.name).replace(/^\d+-/, "");
  return splitDisplayName(displayName).extension;
}

function getEditablePhotoName(photo: Photo): string {
  const displayName = photo.originalName || (photo.name.split("/").pop() ?? photo.name).replace(/^\d+-/, "");
  return splitDisplayName(displayName).baseName || displayName;
}

function buildRenamedPhotoName(photo: Photo, inputName: string): string {
  const currentDisplayName = photo.originalName || (photo.name.split("/").pop() ?? photo.name).replace(/^\d+-/, "");
  const { extension } = splitDisplayName(currentDisplayName);
  const baseName = normalizeRenameBaseName(inputName);
  return `${baseName}${extension}`;
}

function getTopViewer(insight?: MomentInsight): string | undefined {
  if (!insight?.viewers) return undefined;
  return Object.entries(insight.viewers).sort((a, b) => b[1] - a[1])[0]?.[0];
}

function getPeakViewDay(insight?: MomentInsight): string | undefined {
  if (!insight?.dailyViews) return undefined;
  return Object.entries(insight.dailyViews).sort((a, b) => b[1] - a[1])[0]?.[0];
}

function mergeMomentInsight(current: MomentInsight | undefined, incoming: MomentInsight): MomentInsight {
  const mergedViewers = { ...(current?.viewers ?? {}) };
  for (const [viewer, count] of Object.entries(incoming.viewers ?? {})) {
    mergedViewers[viewer] = Math.max(mergedViewers[viewer] ?? 0, count);
  }

  const mergedDailyViews = { ...(current?.dailyViews ?? {}) };
  for (const [day, count] of Object.entries(incoming.dailyViews ?? {})) {
    mergedDailyViews[day] = Math.max(mergedDailyViews[day] ?? 0, count);
  }

  const currentLastViewedAt = current?.lastViewedAt ? new Date(current.lastViewedAt).getTime() : 0;
  const incomingLastViewedAt = incoming.lastViewedAt ? new Date(incoming.lastViewedAt).getTime() : 0;
  const useIncomingTimestamp = incomingLastViewedAt >= currentLastViewedAt;

  return {
    ...incoming,
    totalViews: Math.max(current?.totalViews ?? 0, incoming.totalViews ?? 0),
    viewers: mergedViewers,
    dailyViews: mergedDailyViews,
    lastViewedAt: useIncomingTimestamp ? incoming.lastViewedAt : current?.lastViewedAt,
    lastViewedBy: useIncomingTimestamp ? incoming.lastViewedBy : current?.lastViewedBy,
  };
}

function readLocalMomentInsights(): Record<string, MomentInsight> {
  try {
    const raw = localStorage.getItem(MOMENTS_LOCAL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, MomentInsight>;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.entries(parsed).reduce<Record<string, MomentInsight>>((acc, [photoName, item]) => {
      if (!item || typeof item !== "object" || !photoName) return acc;
      acc[photoName] = {
        photoName,
        totalViews: Number.isFinite(item.totalViews) ? item.totalViews : 0,
        lastViewedAt: item.lastViewedAt,
        lastViewedBy: item.lastViewedBy,
        viewers: item.viewers ?? {},
        dailyViews: item.dailyViews ?? {},
        updatedAt: item.updatedAt,
      };
      return acc;
    }, {});
  } catch {
    return {};
  }
}

function writeLocalMomentInsights(map: Record<string, MomentInsight>): void {
  try {
    localStorage.setItem(MOMENTS_LOCAL_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore localStorage quota and privacy mode failures.
  }
}

function writeMomentsDiagnostics(status: MomentsDiagnosticsStatus, details?: { message?: string; photoCount?: number }): void {
  try {
    localStorage.setItem(MOMENTS_DIAGNOSTICS_KEY, JSON.stringify({
      status,
      message: details?.message,
      photoCount: details?.photoCount,
      updatedAt: new Date().toISOString(),
    }));
  } catch {
    // Ignore localStorage failures.
  }
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

function createDefaultMomentsFilters(): MomentsFilterState {
  return {
    query: "",
    engagementBand: "all",
    recommendationBand: "all",
    viewBand: "all",
    shareBand: "all",
    sortBy: "engagement",
  };
}

function PhotoGallery({
  photos,
  onDelete,
  onSubjectUpdate,
  onRenamePhoto,
  onToggleFavorite,
  onMovePhoto,
  onDownloadStateChange,
  onShareCreated,
  userName,
  showMemoryHighlights = true,
  showImportantMoments = false,
  momentsMode = false,
  momentsShareViews = {},
  focusPhotoName,
  focusRequestKey,
  reverseOrder = false,
}: Props) {
  const showToast = useToast();
  const focusCardRef = useRef<HTMLDivElement | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [editingSubject, setEditingSubject] = useState(false);
  const [subjectInput, setSubjectInput] = useState("");
  const [savingSubject, setSavingSubject] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [showOriginalPreview, setShowOriginalPreview] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareHours, setShareHours] = useState("24");
  const [showSharePanel, setShowSharePanel] = useState(false);
  const [showMoveInput, setShowMoveInput] = useState(false);
  const [moveFolderInput, setMoveFolderInput] = useState("");
  const [moving, setMoving] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [momentsInsightsMap, setMomentsInsightsMap] = useState<Record<string, MomentInsight>>(() => readLocalMomentInsights());
  const momentsUnavailableNoticeShown = useRef(false);
  const [momentsFilters, setMomentsFilters] = useState<MomentsFilterState>(createDefaultMomentsFilters);

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

  // Flat photo list for keyboard navigation (ordered as displayed: by date desc or asc)
  const flatPhotos = useMemo(() => {
    return [...photos].sort((a, b) => {
      const da = (a.createdAt ?? a.lastModified) ?? "";
      const db = (b.createdAt ?? b.lastModified) ?? "";
      return reverseOrder ? da.localeCompare(db) : db.localeCompare(da);
    });
  }, [photos, reverseOrder]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [photos]);

  useEffect(() => {
    if (!focusPhotoName) return;
    const focusIndex = flatPhotos.findIndex((photo) => photo.name === focusPhotoName);
    if (focusIndex >= 0 && focusIndex + 1 > visibleCount) {
      setVisibleCount(Math.max(PAGE_SIZE, Math.ceil((focusIndex + 1) / PAGE_SIZE) * PAGE_SIZE));
    }
  }, [flatPhotos, focusPhotoName, visibleCount]);

  const visiblePhotos = useMemo(() => flatPhotos.slice(0, visibleCount), [flatPhotos, visibleCount]);

  useEffect(() => {
    if (!focusPhotoName || focusRequestKey === undefined) return;
    const frame = window.requestAnimationFrame(() => {
      const el = focusCardRef.current;
      if (!el) return;
      // Measure actual sticky coverage so we never land behind the header/tab-bar
      const appHeader = document.querySelector<HTMLElement>(".app-header");
      const tabShellWrap = document.querySelector<HTMLElement>(".view-tabs-shell-wrap");
      const stickyHeight = (appHeader?.offsetHeight ?? 52) + (tabShellWrap?.offsetHeight ?? 80) + 8;
      const rect = el.getBoundingClientRect();
      if (rect.top < stickyHeight || rect.bottom > window.innerHeight) {
        window.scrollTo({ top: window.scrollY + rect.top - stickyHeight, behavior: "auto" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusPhotoName, focusRequestKey, visiblePhotos]);

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
      const score = (p.favorite ? MOMENT_SCORE_FAVORITE_WEIGHT : 0)
        + (p.subject ? MOMENT_SCORE_SUBJECT_WEIGHT : 0)
        + Math.max(0, MOMENT_SCORE_RECENCY_MAX - recencyDays);
      return { p, score };
    });
    return scored.sort((a, b) => b.score - a.score).map((x) => x.p).slice(0, 10);
  }, [flatPhotos]);

  const getMomentScore = useCallback((photo: Photo): number => {
    const ts = new Date(photo.createdAt ?? photo.lastModified ?? 0).getTime();
    const recencyDays = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
    return (photo.favorite ? MOMENT_SCORE_FAVORITE_WEIGHT : 0)
      + (photo.subject ? MOMENT_SCORE_SUBJECT_WEIGHT : 0)
      + Math.max(0, MOMENT_SCORE_RECENCY_MAX - recencyDays);
  }, []);

  useEffect(() => {
    writeLocalMomentInsights(momentsInsightsMap);
    writeMomentsDiagnostics("local-only", { photoCount: Object.keys(momentsInsightsMap).length });
  }, [momentsInsightsMap]);

  useEffect(() => {
    if (!momentsMode) return;
    let cancelled = false;
    const load = async () => {
      try {
        const map = await listMomentInsights(flatPhotos.map((photo) => photo.name));
        if (!cancelled) {
          writeMomentsDiagnostics("server-synced", { photoCount: Object.keys(map).length });
          setMomentsInsightsMap(map);
        }
      } catch (e) {
        if (!cancelled && e instanceof ManagedMomentsUnavailableError && !momentsUnavailableNoticeShown.current) {
          momentsUnavailableNoticeShown.current = true;
          writeMomentsDiagnostics("server-unavailable", {
            message: e.message,
            photoCount: Object.keys(momentsInsightsMap).length,
          });
          showToast("照片浏览量暂时不可持久化，当前设备会先本地记录浏览变化", "info");
        }
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
      const shareViews = momentsShareViews[photo.name] ?? 0;
      const score = Math.round(getMomentScore(photo));
      const recentBoost = insight?.lastViewedAt
        ? Math.max(0, MOMENT_ENGAGEMENT_RECENT_WINDOW_HOURS - (Date.now() - new Date(insight.lastViewedAt).getTime()) / (1000 * 60 * 60))
        : 0;
      const engagement = score + totalViews * MOMENT_ENGAGEMENT_VIEW_WEIGHT + recentBoost;
      const haystack = `${photo.originalName ?? ""} ${photo.subject ?? ""} ${photo.createdBy ?? ""}`.toLowerCase();
      if (momentsFilters.query && !haystack.includes(momentsFilters.query.toLowerCase())) return false;
      if (momentsFilters.engagementBand === "high" && engagement < 160) return false;
      if (momentsFilters.engagementBand === "medium" && (engagement < 90 || engagement >= 160)) return false;
      if (momentsFilters.engagementBand === "low" && engagement >= 90) return false;
      if (momentsFilters.recommendationBand === "high" && score < 90) return false;
      if (momentsFilters.recommendationBand === "favorite" && !photo.favorite) return false;
      if (momentsFilters.recommendationBand === "fresh") {
        const photoTime = new Date(photo.createdAt ?? photo.lastModified ?? 0).getTime();
        const photoAgeDays = (Date.now() - photoTime) / (1000 * 60 * 60 * 24);
        if (!Number.isFinite(photoAgeDays) || photoAgeDays > 30) return false;
      }
      if (momentsFilters.viewBand === "viewed" && totalViews === 0) return false;
      if (momentsFilters.viewBand === "hot" && totalViews < MOMENT_HOT_VIEW_THRESHOLD) return false;
      if (momentsFilters.viewBand === "unviewed" && totalViews > 0) return false;
      if (momentsFilters.shareBand === "shared" && shareViews === 0) return false;
      if (momentsFilters.shareBand === "viral" && shareViews < 3) return false;
      if (momentsFilters.shareBand === "notShared" && shareViews > 0) return false;
      return true;
    });

    const ranked = filteredPhotos.map((photo) => {
      const insight = momentsInsightsMap[photo.name];
      const shareViews = momentsShareViews[photo.name] ?? 0;
      const score = Math.round(getMomentScore(photo));
      const totalViews = insight?.totalViews ?? 0;
      const lastViewedAt = insight?.lastViewedAt;
      const recentBoost = lastViewedAt
        ? Math.max(0, MOMENT_ENGAGEMENT_RECENT_WINDOW_HOURS - (Date.now() - new Date(lastViewedAt).getTime()) / (1000 * 60 * 60))
        : 0;
      // Engagement is intentionally browse-focused; share traffic stays an independent metric.
      const engagement = score + totalViews * MOMENT_ENGAGEMENT_VIEW_WEIGHT + recentBoost;
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

  const trackMomentView = useCallback((photoName: string) => {
    const viewer = (userName?.trim() || "匿名用户").slice(0, 80);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    setMomentsInsightsMap((prev) => {
      const current = prev[photoName] ?? {
        photoName,
        totalViews: 0,
        viewers: {},
        dailyViews: {},
      };
      return {
        ...prev,
        [photoName]: {
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

    void recordMomentViewApi(photoName, userName).then((serverItem) => {
      if (!serverItem) return;
      writeMomentsDiagnostics("server-synced", { photoCount: Object.keys(momentsInsightsMap).length + 1 });
      setMomentsInsightsMap((prev) => ({
        ...prev,
        [photoName]: mergeMomentInsight(prev[photoName], serverItem),
      }));
    }).catch((e) => {
      if (e instanceof ManagedMomentsUnavailableError && !momentsUnavailableNoticeShown.current) {
        momentsUnavailableNoticeShown.current = true;
        writeMomentsDiagnostics("server-unavailable", {
          message: e.message,
          photoCount: Object.keys(momentsInsightsMap).length,
        });
        showToast("照片浏览量暂时不可持久化，当前设备会先本地记录浏览变化", "info");
      }
    });
  }, [momentsInsightsMap, userName]);

  const navigateToPhoto = useCallback((idx: number) => {
    const photo = modalPhotos[idx];
    if (!photo) return;
    trackMomentView(photo.name);
    setSelectedIdx(idx);
    setSelectedPhoto(photo);
    setEditingSubject(false);
    setSubjectInput(photo.subject ?? "");
    setEditingName(false);
    setNameInput(getEditablePhotoName(photo));
    setMoveFolderInput(photo.folder ?? "");
    setShowOriginalPreview(false);
    setDownloading(false);
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
    trackMomentView(photo.name);
    setSelectedIdx(idx >= 0 ? idx : null);
    setSelectedPhoto(photo);
    setEditingSubject(false);
    setSubjectInput(photo.subject ?? "");
    setEditingName(false);
    setNameInput(getEditablePhotoName(photo));
    setMoveFolderInput(photo.folder ?? "");
    setShowOriginalPreview(false);
    setDownloading(false);
    setShowSharePanel(false);
    setShowMoveInput(false);
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
    const trimmed = normalizeRenameBaseName(nameInput);
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
      onShareCreated?.(selectedPhoto.name);
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
        <div className="empty-gallery-icon">{momentsMode ? "⭐" : "📷"}</div>
        <p className="empty-gallery-title">{momentsMode ? "还没有可展示的重要片段" : "还没有照片"}</p>
        <p className="empty-gallery-sub">{momentsMode ? "先在时间线或文件夹中浏览、收藏并补充主题，系统会逐步沉淀出更有价值的重点照片。" : "切换到「文件夹」视图，选择文件夹后上传照片"}</p>
      </div>
    );
  }

  const groups = groupByDate(visiblePhotos);
  if (reverseOrder) groups.reverse();
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
            <label className="moments-filter-field">
              <span className="moments-filter-field-label">热度</span>
              <select
                className="moments-filter-select"
                value={momentsFilters.engagementBand}
                onChange={(e) => setMomentsFilters((prev) => ({ ...prev, engagementBand: e.target.value as MomentsFilterState["engagementBand"] }))}
              >
                <option value="all">全部热度</option>
                <option value="high">高热度</option>
                <option value="medium">中热度</option>
                <option value="low">低热度</option>
              </select>
            </label>
            <label className="moments-filter-field">
              <span className="moments-filter-field-label">推荐值</span>
              <select
                className="moments-filter-select"
                value={momentsFilters.recommendationBand}
                onChange={(e) => setMomentsFilters((prev) => ({ ...prev, recommendationBand: e.target.value as MomentsFilterState["recommendationBand"] }))}
              >
                <option value="all">全部推荐值</option>
                <option value="high">高推荐值</option>
                <option value="favorite">已收藏优先</option>
                <option value="fresh">近 30 天</option>
              </select>
            </label>
            <label className="moments-filter-field">
              <span className="moments-filter-field-label">浏览量</span>
              <select
                className="moments-filter-select"
                value={momentsFilters.viewBand}
                onChange={(e) => setMomentsFilters((prev) => ({ ...prev, viewBand: e.target.value as MomentsFilterState["viewBand"] }))}
              >
                <option value="all">全部浏览量</option>
                <option value="hot">高频浏览</option>
                <option value="viewed">已有浏览</option>
                <option value="unviewed">暂无浏览</option>
              </select>
            </label>
            <label className="moments-filter-field">
              <span className="moments-filter-field-label">分享量</span>
              <select
                className="moments-filter-select"
                value={momentsFilters.shareBand}
                onChange={(e) => setMomentsFilters((prev) => ({ ...prev, shareBand: e.target.value as MomentsFilterState["shareBand"] }))}
              >
                <option value="all">全部分享量</option>
                <option value="shared">已有分享</option>
                <option value="viral">高分享量</option>
                <option value="notShared">暂无分享</option>
              </select>
            </label>
            <select
              className="moments-filter-select"
              value={momentsFilters.sortBy}
              onChange={(e) => setMomentsFilters((prev) => ({ ...prev, sortBy: e.target.value as MomentsFilterState["sortBy"] }))}
            >
              <option value="engagement">按互动热度排序</option>
              <option value="views">按浏览量排序</option>
              <option value="recent">按最近查看排序</option>
              <option value="shares">按分享量排序</option>
              <option value="recommended">按推荐值排序</option>
            </select>
          </div>
          {momentCards.length === 0 ? (
            <div className="empty-gallery empty-gallery--actionable moments-empty-state">
              <div className="empty-gallery-icon">🧭</div>
              <p className="empty-gallery-title">当前筛选下没有命中的重要片段</p>
              <p className="empty-gallery-sub">建议先放宽热度、浏览量或分享量条件，再看系统推荐结果。</p>
              <div className="empty-gallery-actions">
                <button className="empty-gallery-btn" onClick={() => setMomentsFilters(createDefaultMomentsFilters())}>
                  重置片段筛选
                </button>
              </div>
            </div>
          ) : (
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
                      <span><strong>浏览量</strong><em>{totalViews}</em></span>
                      <span><strong>推荐值</strong><em>{score}</em></span>
                      <span><strong>分享量</strong><em>{shareViews}</em></span>
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
          )}
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
                <div
                  key={photo.name}
                  ref={photo.name === focusPhotoName ? focusCardRef : null}
                  className={photo.name === focusPhotoName ? "gallery-focus-card" : undefined}
                >
                  <PhotoCard
                    photo={photo}
                    onClick={() => !selectMode && openModal(photo)}
                    onDelete={() => onDelete(photo.name)}
                    onToggleFavorite={(next) => { void onToggleFavorite(photo.name, next); }}
                    selected={selectMode ? selected.has(photo.name) : undefined}
                    onSelect={selectMode ? (e) => { e.stopPropagation(); togglePhoto(photo.name); } : undefined}
                  />
                </div>
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
          onClick={() => { setSelectedIdx(null); setSelectedPhoto(null); setShowOriginalPreview(false); }}
        >
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close"
              onClick={() => { setSelectedIdx(null); setSelectedPhoto(null); setShowOriginalPreview(false); }}
            >
              ✕
            </button>
            {selectedIdx !== null && selectedIdx > 0 && (
              <button className="modal-nav modal-nav--prev" onClick={() => navigateToPhoto(selectedIdx - 1)} title="上一张 (←)">‹</button>
            )}
            {selectedIdx !== null && selectedIdx < modalPhotos.length - 1 && (
              <button className="modal-nav modal-nav--next" onClick={() => navigateToPhoto(selectedIdx + 1)} title="下一张 (→)">›</button>
            )}
            <div className="modal-image-pane">
              {selectedPhoto.contentType?.startsWith("video/") ? (
                <video className="modal-image modal-video" controls playsInline>
                  <source src={selectedPhoto.url} type={selectedPhoto.contentType} />
                </video>
              ) : (
                <img
                  src={selectedPhoto.url}
                  alt={selectedPhoto.name}
                  className="modal-image"
                  onClick={() => setShowOriginalPreview(true)}
                  title="点击预览原图"
                />
              )}
              {modalPhotos.length > 1 && (
                <div className="modal-nav-hint">← → 切换 · Esc 关闭</div>
              )}
            </div>
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
                    <span className="modal-empty" style={{ marginLeft: 6 }}>
                      后缀固定：{getPhotoExtension(selectedPhoto) || "（无）"}
                    </span>
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

              <div className="modal-action-strip">
                <button
                  className="modal-action-btn"
                  onClick={() => void handleDownload()}
                  disabled={downloading}
                >
                  {downloading ? "⏳" : "⬇"} 下载
                </button>
                <button
                  className={`modal-action-btn${selectedPhoto.favorite ? " modal-action-btn--active" : ""}`}
                  onClick={() => void handleModalFavoriteToggle()}
                >
                  {selectedPhoto.favorite ? "❤" : "♡"} 收藏
                </button>
                <button
                  className={`modal-action-btn${showSharePanel ? " modal-action-btn--active" : ""}`}
                  onClick={() => setShowSharePanel((v) => !v)}
                >
                  🔗 分享
                </button>
                {onMovePhoto && (
                  <button
                    className={`modal-action-btn${showMoveInput ? " modal-action-btn--active" : ""}`}
                    onClick={() => setShowMoveInput((v) => !v)}
                  >
                    📁 移动
                  </button>
                )}
                {!selectedPhoto.contentType?.startsWith("video/") && (
                  <button
                    className="modal-action-btn"
                    onClick={() => setShowOriginalPreview(true)}
                  >
                    🔍 预览
                  </button>
                )}
                <button className="modal-action-btn modal-action-btn--danger" onClick={handleModalDelete}>🗑 删除</button>
              </div>

              {showSharePanel && (
                <div className="modal-panel-box">
                  <div className="modal-share-row">
                    <select className="modal-move-select" value={shareHours} onChange={(e) => setShareHours(e.target.value)}>
                      <option value="1">1 小时</option>
                      <option value="24">24 小时</option>
                      <option value="72">3 天</option>
                      <option value="168">7 天</option>
                    </select>
                    <button className="modal-share-btn" onClick={() => void handleShare()} disabled={sharing}>
                      {sharing ? "创建中…" : "复制链接"}
                    </button>
                  </div>
                  <p className="modal-privacy-notice">🔒 请确认内容不含敏感信息（身份证、银行卡等）</p>
                </div>
              )}

              {showMoveInput && onMovePhoto && (
                <div className="modal-panel-box">
                  <input
                    className="modal-folder-input"
                    value={moveFolderInput}
                    onChange={(e) => setMoveFolderInput(e.target.value)}
                    placeholder="目标文件夹（留空=根目录）"
                  />
                  <button className="modal-move-btn" onClick={() => void handleModalMove()} disabled={moving}>
                    {moving ? "移动中…" : "移动"}
                  </button>
                </div>
              )}
              <div className="modal-detail-grid">
                <span className="modal-detail-label">备注</span>
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

                {momentsMode ? (
                  <>
                    <span className="modal-detail-section">片段评分</span>
                    <span className="modal-detail-label">推荐值</span>
                    <span className="modal-detail-value">{Math.round(getMomentScore(selectedPhoto))}</span>

                    <span className="modal-detail-label">互动热度</span>
                    <span className="modal-detail-value">
                      {Math.round(
                        Math.round(getMomentScore(selectedPhoto))
                        + (selectedMomentInsight?.totalViews ?? 0) * MOMENT_ENGAGEMENT_VIEW_WEIGHT,
                      )}
                    </span>

                    <span className="modal-detail-section">浏览指标</span>
                    <span className="modal-detail-label">浏览量（应用内）</span>
                    <span className="modal-detail-value">{selectedMomentInsight?.totalViews ?? 0}</span>

                    <span className="modal-detail-label">最近查看</span>
                    <span className="modal-detail-value">{selectedMomentInsight?.lastViewedAt ? formatDate(selectedMomentInsight.lastViewedAt) : "暂无"}</span>

                    <span className="modal-detail-label">常看用户</span>
                    <span className="modal-detail-value">{getTopViewer(selectedMomentInsight) ?? "暂无"}</span>

                    <span className="modal-detail-label">浏览高峰日</span>
                    <span className="modal-detail-value">{getPeakViewDay(selectedMomentInsight) ?? "暂无"}</span>

                    <span className="modal-detail-section">分享指标</span>
                    <span className="modal-detail-label">分享量（外链）</span>
                    <span className="modal-detail-value">{momentsShareViews[selectedPhoto.name] ?? 0}</span>
                  </>
                ) : (
                  <>
                    <span className="modal-detail-label">上传者</span>
                    <span className="modal-detail-value">{selectedPhoto.createdBy ?? "—"}</span>

                    <span className="modal-detail-label">上传时间</span>
                    <span className="modal-detail-value">{selectedPhoto.createdAt ? formatDate(selectedPhoto.createdAt) : "—"}</span>

                    <span className="modal-detail-label">修改者</span>
                    <span className="modal-detail-value">{selectedPhoto.lastModifiedBy ?? "—"}</span>

                    <span className="modal-detail-label">修改时间</span>
                    <span className="modal-detail-value">
                      {selectedPhoto.lastModifiedAt
                        ? formatDate(selectedPhoto.lastModifiedAt)
                        : selectedPhoto.lastModified
                        ? formatDate(selectedPhoto.lastModified)
                        : "—"}
                    </span>

                    <span className="modal-detail-label">文件类型</span>
                    <span className="modal-detail-value">{selectedPhoto.contentType ?? "—"}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {selectedPhoto && showOriginalPreview && (
        <div className="modal-preview-overlay" onClick={() => setShowOriginalPreview(false)}>
          <div className="modal-preview-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowOriginalPreview(false)}>✕</button>
            <a className="modal-preview-open" href={selectedPhoto.url} target="_blank" rel="noreferrer">
              在新窗口打开原图
            </a>
            <img src={selectedPhoto.url} alt={selectedPhoto.name} className="modal-preview-image" />
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

export default memo(PhotoGallery);
