import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react";
import MediaThumb from "../shared/MediaThumb";
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
  uploadPhotoWithProgress,
  setPhotoVoiceMemo as apiSetVoiceMemo,
  updatePhotoTakenAt,
  updatePhotoGps,
  fetchMotionVideoBlob,
  getViewerSrc,
} from "../../services/photoApi";
import { DEFAULT_PAGE_SIZE, SCROLL_SENTINEL_MARGIN } from "@cloudphoto/algorithm";
import { addRecentShareLink } from "../../services/share/shareLinksStore";
import { copyText } from "../../services/share/clipboard";
import PhotoCard from "./PhotoCard";
import { useToast } from "../../contexts/ToastContext";
import { reverseGeocode } from "../../utils/geocode";
import PhotoTimeEditDialog from "../shared/PhotoTimeEditDialog";
import LocationSearchPanel from "../shared/LocationSearchPanel";
import BatchOperationsBar from "../shared/BatchOperationsBar";

interface Props {
  photos: Photo[];
  onDelete: (name: string) => void;
  onSubjectUpdate: (name: string, subject: string) => void;
  onRenamePhoto: (name: string, newOriginalName: string) => void;
  onTakenAtUpdate?: (name: string, takenAt: string) => void;
  onGpsUpdate?: (name: string, gpsLat: string, gpsLon: string) => void;
  onToggleFavorite: (name: string, favorite: boolean) => Promise<boolean>;
  onMovePhoto?: (name: string, toFolder: string) => Promise<boolean>;
  onBatchDelete?: (names: string[]) => Promise<void>;
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
  /** Whether to group/sort by photo taken time or upload time */
  sortKey?: "taken" | "uploaded";
  /** Thumbnail grid density */
  gridSize?: "sm" | "md" | "lg";
  /** Called with the number of moments cards currently shown (after filter + cap) */
  onMomentsCountChange?: (count: number) => void;
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

const PAGE_SIZE = DEFAULT_PAGE_SIZE;
const MOMENTS_MAX = 20;
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

function groupByDate(photos: Photo[], sortKey: "taken" | "uploaded" = "taken"): DateGroup[] {
  const map = new Map<string, Photo[]>();

  for (const photo of photos) {
    const raw = sortKey === "taken"
      ? (photo.takenAt ?? photo.createdAt ?? photo.lastModified)
      : (photo.createdAt ?? photo.lastModified);
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
  onTakenAtUpdate,
  onGpsUpdate,
  onToggleFavorite,
  onMovePhoto,
  onBatchDelete,
  onDownloadStateChange,
  onMomentsCountChange,
  onShareCreated,
  userName,
  showMemoryHighlights = true,
  showImportantMoments = false,
  momentsMode = false,
  momentsShareViews = {},
  focusPhotoName,
  focusRequestKey,
  reverseOrder = false,
  sortKey = "taken",
  gridSize = "md",
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
  const [editingTakenAt, setEditingTakenAt] = useState(false);
  const [savingTakenAt, setSavingTakenAt] = useState(false);
  const [editingGps, setEditingGps] = useState(false);
  const [savingGps, setSavingGps] = useState(false);
  const [geoAddress, setGeoAddress] = useState<string | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [copyingImage, setCopyingImage] = useState(false);
  const [showOriginalPreview, setShowOriginalPreview] = useState(false);
  const [motionVideoUrl, setMotionVideoUrl] = useState<string | null>(null);
  const [motionVideoLoading, setMotionVideoLoading] = useState(false);
  const [videoBuffering, setVideoBuffering] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [imageDimensions, setImageDimensions] = useState<{ w: number; h: number } | null>(null);
  const [modalImageLoaded, setModalImageLoaded] = useState(false);
  // Progressive GIF loading in the viewer: show thumbnail immediately, upgrade to full GIF silently
  const [gifViewerSrc, setGifViewerSrc] = useState<string>("");
  const gifViewerPreloadRef = useRef<HTMLImageElement | null>(null);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareHours, setShareHours] = useState("24");
  const [showSharePanel, setShowSharePanel] = useState(false);
  const [showMoveInput, setShowMoveInput] = useState(false);
  const [moveFolderInput, setMoveFolderInput] = useState("");
  const [moving, setMoving] = useState(false);
  const [showVoicePanel, setShowVoicePanel] = useState(false);
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "uploading">("idle");
  const touchStartX = useRef<number | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [momentsInsightsMap, setMomentsInsightsMap] = useState<Record<string, MomentInsight>>(() => readLocalMomentInsights());
  const momentsUnavailableNoticeShown = useRef(false);
  const [momentsFilters, setMomentsFilters] = useState<MomentsFilterState>(createDefaultMomentsFilters);

  // Batch selection
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBatchConfirm, setShowBatchConfirm] = useState(false);
  const [showBatchTimeEdit, setShowBatchTimeEdit] = useState(false);
  const [batchTimeInput, setBatchTimeInput] = useState("");
  const [showBatchGpsEdit, setShowBatchGpsEdit] = useState(false);
  const [batchGpsLat, setBatchGpsLat] = useState("");
  const [batchGpsLon, setBatchGpsLon] = useState("");

  useEffect(() => {
    onDownloadStateChange?.(downloading);
    return () => onDownloadStateChange?.(false);
  }, [downloading, onDownloadStateChange]);

  // Lock body scroll + compensate scrollbar width when modal is open
  useEffect(() => {
    if (!selectedPhoto) return;
    const sw = window.innerWidth - document.documentElement.clientWidth;
    const prevOverflow = document.body.style.overflow;
    const prevPadding = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";
    document.body.style.paddingRight = `${sw}px`;
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPadding;
    };
  }, [selectedPhoto]);
  const allSelected = selected.size > 0 && selected.size === photos.length;
  const exitSelectMode = () => { setSelectMode(false); setSelected(new Set()); };
  const selectedTotalSize = useMemo(() => {
    const bytes = photos.filter((p) => selected.has(p.name)).reduce((s, p) => s + (p.size ?? 0), 0);
    if (bytes === 0) return null;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  }, [photos, selected]);
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
    const names = Array.from(selected);
    exitSelectMode();
    setShowBatchConfirm(false);
    if (onBatchDelete) {
      void onBatchDelete(names);
    } else {
      for (const name of names) onDelete(name);
      showToast(`已删除 ${names.length} 张照片`, "success");
    }
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
      const getDate = (p: Photo) => sortKey === "taken"
        ? (p.takenAt ?? p.createdAt ?? p.lastModified) ?? ""
        : (p.createdAt ?? p.lastModified) ?? "";
      const da = getDate(a);
      const db = getDate(b);
      return reverseOrder ? da.localeCompare(db) : db.localeCompare(da);
    });
  }, [photos, reverseOrder, sortKey]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [photos]);

  // Auto-load next page when the sentinel div scrolls into view
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((v) => v + PAGE_SIZE);
        }
      },
      { rootMargin: SCROLL_SENTINEL_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [flatPhotos]);

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

  // Debounce localStorage writes — synchronous JSON.stringify+write on every view
  // blocked the main thread and caused noticeable jank.
  const writeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (writeDebounceRef.current) clearTimeout(writeDebounceRef.current);
    writeDebounceRef.current = setTimeout(() => {
      writeLocalMomentInsights(momentsInsightsMap);
      writeMomentsDiagnostics("local-only", { photoCount: Object.keys(momentsInsightsMap).length });
    }, 1500);
    return () => {
      if (writeDebounceRef.current) clearTimeout(writeDebounceRef.current);
    };
  }, [momentsInsightsMap]);

  useEffect(() => {
    if (!momentsMode) return;
    let cancelled = false;
    const load = async () => {
      try {
        const map = await listMomentInsights(flatPhotos.map((photo) => photo.name));
        if (!cancelled) {
          writeMomentsDiagnostics("server-synced", { photoCount: Object.keys(map).length });
          // Merge server data into local state — never discard locally-tracked views
          // that haven't been synced to the server yet (take max per photo).
          if (Object.keys(map).length > 0) {
            setMomentsInsightsMap((prev) => {
              const merged: Record<string, MomentInsight> = { ...prev };
              for (const [photoName, serverItem] of Object.entries(map)) {
                merged[photoName] = mergeMomentInsight(prev[photoName], serverItem);
              }
              return merged;
            });
          }
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

    return ranked.slice(0, MOMENTS_MAX).map((item, index) => ({ ...item, rank: index + 1 }));
  }, [flatPhotos, getMomentScore, momentsFilters, momentsInsightsMap, momentsShareViews, visibleCount]);

  // Report actual displayed moments count to parent (for tab badge)
  useEffect(() => {
    if (momentsMode) onMomentsCountChange?.(momentCards.length);
  }, [momentCards.length, momentsMode, onMomentsCountChange]);

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
      writeMomentsDiagnostics("server-synced", {});
      // Use functional updater — no need to read momentsInsightsMap in closure
      setMomentsInsightsMap((prev) => ({
        ...prev,
        [photoName]: mergeMomentInsight(prev[photoName], serverItem),
      }));
    }).catch((e) => {
      if (e instanceof ManagedMomentsUnavailableError && !momentsUnavailableNoticeShown.current) {
        momentsUnavailableNoticeShown.current = true;
        writeMomentsDiagnostics("server-unavailable", { message: e.message });
        showToast("照片浏览量暂时不可持久化，当前设备会先本地记录浏览变化", "info");
      }
    });
  }, [userName]);  // momentsInsightsMap removed — functional updaters give latest state

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
    setEditingTakenAt(false);
    setEditingGps(false);
    setMoveFolderInput(photo.folder ?? "");
    setShowOriginalPreview(false);
    setDownloading(false);
    setMotionVideoUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    setMotionVideoLoading(false);
    setVideoBuffering(false);
    setImageDimensions(null);
    setModalImageLoaded(false);
    setGifViewerSrc("");
  }, [modalPhotos, trackMomentView]);

  // Progressive GIF loading in the viewer is intentionally removed.
  // Showing the static thumbnail first made users think animation was broken.
  // The viewer shows selectedPhoto.url directly; the browser streams the GIF
  // and animation starts as soon as the first frames arrive.
  // (Gallery cards still do progressive loading via gifDisplaySrc in PhotoCard.)
  void gifViewerSrc; void setGifViewerSrc; void gifViewerPreloadRef;

  // Keyboard navigation when modal is open
  useEffect(() => {
    if (selectedIdx === null) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches("input,textarea")) return;
      if (e.key === "Escape") { setSelectedIdx(null); setSelectedPhoto(null); }
      if (e.key === "ArrowLeft" && selectedIdx > 0) navigateToPhoto(selectedIdx - 1);
      if (e.key === "ArrowRight" && selectedIdx < modalPhotos.length - 1) navigateToPhoto(selectedIdx + 1);
      if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey) {
        if (selectedPhoto) {
          const next = !selectedPhoto.favorite;
          void onToggleFavorite(selectedPhoto.name, next).then((ok) => {
            if (ok) setSelectedPhoto((prev) => prev ? { ...prev, favorite: next } : prev);
          });
        }
      }
      if (e.key === "Delete" && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (selectedPhoto) {
          const displayName = selectedPhoto.originalName || (selectedPhoto.name.split("/").pop() ?? selectedPhoto.name).replace(/^\d+-/, "");
          if (window.confirm(`确认删除照片：${displayName}？`)) {
            onDelete(selectedPhoto.name);
            setSelectedIdx(null);
            setSelectedPhoto(null);
          }
        }
      }
      if ((e.key === "d" || e.key === "D") && !e.ctrlKey && !e.metaKey && selectedPhoto) {
        const filename = selectedPhoto.originalName || selectedPhoto.name.replace(/^\d+-/, "");
        void downloadPhotoApi(selectedPhoto.name, filename);
      }
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        setShowShortcutHelp((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedIdx, modalPhotos.length, navigateToPhoto, selectedPhoto, onToggleFavorite, onDelete]);

  // Ctrl+A to select all photos in batch mode (when modal is closed)
  useEffect(() => {
    if (!selectMode || selectedIdx !== null) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        if ((e.target as HTMLElement).matches("input,textarea")) return;
        e.preventDefault();
        toggleSelectAll();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectMode, selectedIdx, toggleSelectAll]);

  // Reverse geocode GPS coordinates to human-readable address
  useEffect(() => {
    setGeoAddress(null);
    const lat = parseFloat(selectedPhoto?.gpsLat ?? "");
    const lon = parseFloat(selectedPhoto?.gpsLon ?? "");
    if (!isFinite(lat) || !isFinite(lon)) return;
    setGeoLoading(true);
    void reverseGeocode(lat, lon).then((addr) => {
      setGeoAddress(addr);
      setGeoLoading(false);
    });
  }, [selectedPhoto?.gpsLat, selectedPhoto?.gpsLon]);

  // Preload adjacent photos for faster navigation
  useEffect(() => {
    if (selectedIdx === null) return;
    const toPreload = [selectedIdx - 1, selectedIdx + 1]
      .filter((i) => i >= 0 && i < modalPhotos.length)
      .map((i) => modalPhotos[i])
      .filter((p) => p && !p.contentType?.startsWith("video/"));
    toPreload.forEach((p) => {
      const img = new Image();
      // Use thumbnailUrl/previewUrl (same as viewer picks) — NOT the full original.
      // p.url can be 10-20 MB; getViewerSrc() picks ~50 KB thumb or ~400 KB preview.
      img.src = getViewerSrc(p);
    });
  }, [selectedIdx, modalPhotos]);

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
    setShowVoicePanel(false);
    setVoiceState("idle");
    setVoiceError(null);
    setMotionVideoUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    setMotionVideoLoading(false);
    setGifViewerSrc("");
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

  const saveTakenAt = async (isoStr: string) => {
    if (!selectedPhoto) return;
    setSavingTakenAt(true);
    try {
      // Store as naive datetime (no Z) so all clients display in local time
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) { showToast("无效的日期时间", "error"); return; }
      const pad = (n: number) => String(n).padStart(2, "0");
      const naive = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      await updatePhotoTakenAt(selectedPhoto.name, naive, userName);
      onTakenAtUpdate?.(selectedPhoto.name, naive);
      setSelectedPhoto({ ...selectedPhoto, takenAt: naive });
      setEditingTakenAt(false);
    } catch {
      showToast("更新拍摄时间失败", "error");
    } finally {
      setSavingTakenAt(false);
    }
  };

  const saveGps = async (lat: string, lon: string) => {
    if (!selectedPhoto) return;
    setSavingGps(true);
    try {
      await updatePhotoGps(selectedPhoto.name, lat, lon);
      onGpsUpdate?.(selectedPhoto.name, lat, lon);
      setSelectedPhoto({ ...selectedPhoto, gpsLat: lat, gpsLon: lon });
      setEditingGps(false);
      setGeoAddress(null);
    } catch {
      showToast("更新位置失败", "error");
    } finally {
      setSavingGps(false);
    }
  };

  const handleBatchSetTakenAt = async () => {
    if (!batchTimeInput || selected.size === 0) return;
    const d = new Date(batchTimeInput);
    if (isNaN(d.getTime())) { showToast("无效的日期时间", "error"); return; }
    const pad = (n: number) => String(n).padStart(2, "0");
    const naive = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const selectedList = flatPhotos.filter((p) => selected.has(p.name));
    let failed = 0;
    for (const p of selectedList) {
      try {
        await updatePhotoTakenAt(p.name, naive, userName);
        onTakenAtUpdate?.(p.name, naive);
      } catch { failed++; }
    }
    setShowBatchTimeEdit(false);
    setBatchTimeInput("");
    if (failed > 0) showToast(`批量修改时间完成，失败 ${failed} 张`, "error");
    else showToast(`已修改 ${selectedList.length} 张照片的拍摄时间`, "success");
  };

  const handleBatchSetGps = async (overrideLat?: string, overrideLon?: string) => {
    const effectiveLat = overrideLat ?? batchGpsLat;
    const effectiveLon = overrideLon ?? batchGpsLon;
    if (!effectiveLat || !effectiveLon || selected.size === 0) return;
    const lat = parseFloat(effectiveLat);
    const lon = parseFloat(effectiveLon);
    if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      showToast("坐标无效：纬度 ±90°，经度 ±180°", "error");
      return;
    }
    const selectedList = flatPhotos.filter((p) => selected.has(p.name));
    let failed = 0;
    for (const p of selectedList) {
      try {
        await updatePhotoGps(p.name, effectiveLat, effectiveLon);
        onGpsUpdate?.(p.name, effectiveLat, effectiveLon);
      } catch { failed++; }
    }
    setShowBatchGpsEdit(false);
    setBatchGpsLat("");
    setBatchGpsLon("");
    if (failed > 0) showToast(`批量修改位置完成，失败 ${failed} 张`, "error");
    else showToast(`已修改 ${selectedList.length} 张照片的位置`, "success");
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

  const handleCopyImage = async () => {
    if (!selectedPhoto || selectedPhoto.contentType?.startsWith("video/")) return;
    if (!navigator.clipboard?.write) { showToast("当前浏览器不支持复制图片", "error"); return; }
    setCopyingImage(true);
    try {
      const resp = await fetch(selectedPhoto.url);
      const blob = await resp.blob();
      // Chrome requires image/png for ClipboardItem; convert if needed
      const type = blob.type.startsWith("image/") ? blob.type : "image/png";
      await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
      showToast("图片已复制到剪贴板 📋", "success");
    } catch {
      showToast("复制失败，请重试", "error");
    } finally {
      setCopyingImage(false);
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

  const startRecording = async () => {
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.addEventListener("dataavailable", (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); });
      mediaRecorderRef.current = recorder;
      recorder.start();
      setVoiceState("recording");
    } catch {
      setVoiceError("无法访问麦克风，请检查权限");
    }
  };

  const stopAndUploadRecording = async () => {
    if (!selectedPhoto || !mediaRecorderRef.current) return;
    const recorder = mediaRecorderRef.current;
    setVoiceState("uploading");
    await new Promise<void>((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.stop();
    });
    recorder.stream?.getTracks().forEach((t) => t.stop());
    const mimeType = recorder.mimeType || "audio/webm";
    const ext = mimeType.includes("mp4") ? ".mp4" : ".webm";
    const blob = new Blob(audioChunksRef.current, { type: mimeType });
    const file = new File([blob], `voice${ext}`, { type: mimeType });
    const photoRef = selectedPhoto;
    try {
      const result = await uploadPhotoWithProgress(file, () => {}, userName, undefined, "_voice", photoRef.groupId);
      await apiSetVoiceMemo(photoRef.name, result.name, userName);
      setSelectedPhoto((prev) => prev ? { ...prev, voiceMemoName: result.name, voiceMemoUrl: result.url } : null);
    } catch {
      setVoiceError("语音备注上传失败，请重试");
    } finally {
      setVoiceState("idle");
    }
  };

  const deleteVoiceMemo = async () => {
    if (!selectedPhoto) return;
    try {
      await apiSetVoiceMemo(selectedPhoto.name, "", userName);
      setSelectedPhoto((prev) => prev ? { ...prev, voiceMemoName: undefined, voiceMemoUrl: undefined } : null);
    } catch {
      setVoiceError("删除语音备注失败");
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

  const groups = groupByDate(visiblePhotos, sortKey);
  if (reverseOrder) groups.reverse();
  const hasMore = !momentsMode && visibleCount < flatPhotos.length;

  return (
    <>
      {/* Batch selection toolbar */}
      <BatchOperationsBar
        selectMode={selectMode}
        onToggleSelectMode={() => { setSelectMode((v) => !v); setSelected(new Set()); }}
        selectedCount={selected.size}
        selectedTotalSize={selectedTotalSize ?? undefined}
        allSelected={allSelected}
        onToggleSelectAll={toggleSelectAll}
        onBatchRename={() => void handleBatchRename()}
        showBatchTimeEdit={showBatchTimeEdit}
        onToggleBatchTimeEdit={() => { setShowBatchTimeEdit((v) => !v); setShowBatchGpsEdit(false); }}
        batchTimeInput={batchTimeInput}
        onBatchTimeInputChange={setBatchTimeInput}
        onApplyBatchTime={() => void handleBatchSetTakenAt()}
        onCancelBatchTime={() => { setShowBatchTimeEdit(false); setBatchTimeInput(""); }}
        showBatchGpsEdit={showBatchGpsEdit}
        onToggleBatchGpsEdit={() => { setShowBatchGpsEdit((v) => !v); setShowBatchTimeEdit(false); }}
        onApplyBatchGps={(lat, lon) => { setBatchGpsLat(lat); setBatchGpsLon(lon); void handleBatchSetGps(lat, lon); }}
        onCancelBatchGpsEdit={() => { setShowBatchGpsEdit(false); setBatchGpsLat(""); setBatchGpsLon(""); }}
        showBatchConfirm={showBatchConfirm}
        onRequestDelete={() => setShowBatchConfirm(true)}
        onCancelDelete={() => setShowBatchConfirm(false)}
        onConfirmDelete={handleBatchDelete}
      />

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
                  <div className="media-thumb-wrap">
                    <MediaThumb url={photo.url} alt={display} contentType={photo.contentType} className="moments-thumb" />
                  </div>
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
        <>
          {groups.length > 0 && !selectMode && (
            <div className="gallery-summary-bar">
              共 <strong>{visiblePhotos.length}</strong> 张照片 · <strong>{groups.length}</strong> 个日期
            </div>
          )}
          {groups.map((group) => (
          <section key={group.key} className="date-group">
            <h2 className="date-group-label">
              <span className="date-group-dot" />
              {group.label}
              <span className="date-group-count">{group.photos.length}</span>
              {selectMode && (
                <button
                  className="date-group-select-all"
                  onClick={() => {
                    const names = group.photos.map((p) => p.name);
                    const allIn = names.every((n) => selected.has(n));
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (allIn) names.forEach((n) => next.delete(n));
                      else names.forEach((n) => next.add(n));
                      return next;
                    });
                  }}
                >
                  {group.photos.every((p) => selected.has(p.name)) ? "取消全选" : "全选本日"}
                </button>
              )}
            </h2>
            <div className={`photo-grid${gridSize === "sm" ? " photo-grid--sm" : gridSize === "lg" ? " photo-grid--lg" : ""}`}>
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
          ))}
        </>
      )}

      {hasMore && (
        <div ref={sentinelRef} className="timeline-more-wrap">
          <span className="timeline-more-hint">
            已显示 {visibleCount} / {flatPhotos.length} 张，向下滚动加载更多
          </span>
        </div>
      )}

      {selectedPhoto && (
        <div
          className="modal-overlay"
          onClick={() => { setSelectedIdx(null); setSelectedPhoto(null); setShowOriginalPreview(false); }}
        >
          <div
            className={`modal-content${isFullscreen ? " modal-content--fullscreen" : ""}`}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close"
              onClick={() => { setSelectedIdx(null); setSelectedPhoto(null); setShowOriginalPreview(false); setIsFullscreen(false); }}
            >
              ✕
            </button>
            <button
              className="modal-fullscreen-btn"
              onClick={() => setIsFullscreen((v) => !v)}
              title={isFullscreen ? "退出全屏" : "全屏"}
            >
              {isFullscreen ? "✕✕" : "⛶"}
            </button>
            {selectedIdx !== null && (
              <span className="modal-nav-counter">{selectedIdx + 1} / {modalPhotos.length}</span>
            )}
            {selectedIdx !== null && selectedIdx > 0 && (
              <button className="modal-nav modal-nav--prev" onClick={() => navigateToPhoto(selectedIdx - 1)} title={`上一张：${modalPhotos[selectedIdx - 1]?.originalName || (modalPhotos[selectedIdx - 1]?.name.split("/").pop() ?? "").replace(/^\d+-/, "")} (←)`}>‹</button>
            )}
            {selectedIdx !== null && selectedIdx < modalPhotos.length - 1 && (
              <button className="modal-nav modal-nav--next" onClick={() => navigateToPhoto(selectedIdx + 1)} title={`下一张：${modalPhotos[selectedIdx + 1]?.originalName || (modalPhotos[selectedIdx + 1]?.name.split("/").pop() ?? "").replace(/^\d+-/, "")} (→)`}>›</button>
            )}
            <div className="modal-image-pane"
              onTouchStart={(e) => { touchStartX.current = e.touches[0].clientX; }}
              onTouchEnd={(e) => {
                if (touchStartX.current === null || selectedIdx === null) return;
                const dx = e.changedTouches[0].clientX - touchStartX.current;
                touchStartX.current = null;
                if (Math.abs(dx) < 50) return; // too short
                if (dx < 0 && selectedIdx < modalPhotos.length - 1) navigateToPhoto(selectedIdx + 1);
                if (dx > 0 && selectedIdx > 0) navigateToPhoto(selectedIdx - 1);
              }}
            >
              {selectedPhoto.contentType?.startsWith("video/") ? (
                <div className="modal-video-wrap">
                  <video
                    key={selectedPhoto.url}
                    src={selectedPhoto.url}
                    className="modal-image modal-video"
                    controls
                    playsInline
                    preload="metadata"
                    poster={selectedPhoto.thumbnailUrl ?? undefined}
                    onPlay={() => setVideoBuffering(true)}
                    onPlaying={() => setVideoBuffering(false)}
                    onWaiting={() => setVideoBuffering(true)}
                    onCanPlay={() => setVideoBuffering(false)}
                  />
                  {videoBuffering && (
                    <div className="modal-video-spinner">
                      <div className="modal-video-spinner-ring" />
                      <span>加载中…</span>
                    </div>
                  )}
                </div>
              ) : selectedPhoto.contentType === "image/gif" || selectedPhoto.isAnimated ? (
                <>
                  {/* Motion JPEG (Google/Samsung/etc.): show video player if available */}
                  {(selectedPhoto.contentType === "image/jpeg" || selectedPhoto.contentType === "image/jpg") && selectedPhoto.isAnimated ? (
                    motionVideoUrl ? (
                      <video
                        key={motionVideoUrl}
                        src={motionVideoUrl}
                        className="modal-image modal-video"
                        autoPlay
                        muted
                        loop
                        playsInline
                        controls
                      />
                    ) : (
                      <>
                        <img
                          key={selectedPhoto.url}
                          src={selectedPhoto.url}
                          alt={selectedPhoto.name}
                          className="modal-image modal-image--gif"
                          onClick={() => setShowOriginalPreview(true)}
                          title="点击预览原图"
                        />
                        <button
                          className="motion-play-btn"
                          disabled={motionVideoLoading}
                          onClick={async () => {
                            setMotionVideoLoading(true);
                            const result = await fetchMotionVideoBlob(selectedPhoto.name);
                            if (!result.url) {
                              showToast(result.error ?? "动态视频提取失败", "error");
                            }
                            setMotionVideoUrl(result.url);
                            setMotionVideoLoading(false);
                          }}
                          title="播放动态视频"
                        >
                          {motionVideoLoading ? "⏳ 加载中…" : "▶ 播放动态"}
                        </button>
                      </>
                    )
                  ) : (
                    <img
                      key={selectedPhoto.url}
                      src={selectedPhoto.url}
                      alt={selectedPhoto.name}
                      className="modal-image modal-image--gif"
                      onClick={() => setShowOriginalPreview(true)}
                      title="点击预览原图"
                    />
                  )}
                  <span className="modal-gif-badge">
                    {(selectedPhoto.contentType === "image/jpeg" || selectedPhoto.contentType === "image/jpg") && selectedPhoto.isAnimated
                      ? (motionVideoUrl ? "动态照片 ▶ 播放中" : "动态照片 📱")
                      : "动图 ▶ 循环播放"}
                  </span>
                </>
              ) : (
                <>
                  {/* Blurred thumbnail shown instantly while full-res original loads */}
                  {!modalImageLoaded && selectedPhoto.thumbnailUrl && (
                    <img
                      src={selectedPhoto.thumbnailUrl}
                      alt=""
                      aria-hidden="true"
                      className="modal-image modal-image--placeholder"
                    />
                  )}
                  {/* Spinner only when there is no thumbnail to show */}
                  {!modalImageLoaded && !selectedPhoto.thumbnailUrl && <div className="modal-image-spinner" />}
                  <img
                    src={getViewerSrc(selectedPhoto)}
                    alt={selectedPhoto.name}
                    className={`modal-image${modalImageLoaded ? " modal-image--fadein" : " modal-image--loading"}`}
                    onClick={() => setShowOriginalPreview(true)}
                    title="点击预览原图"
                    onLoad={(e) => {
                      const img = e.currentTarget;
                      setImageDimensions({ w: img.naturalWidth, h: img.naturalHeight });
                      setModalImageLoaded(true);
                    }}
                  />
                </>
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
                <span className="modal-size">{formatSize(selectedPhoto.size)}{imageDimensions ? ` · ${imageDimensions.w}×${imageDimensions.h}` : ""}</span>
                {selectedPhoto.contentType && (
                  <span className="modal-format-tag">
                    {selectedPhoto.contentType.split("/")[1]?.toUpperCase().replace("JPEG", "JPG").replace("QUICKTIME", "MOV") ?? selectedPhoto.contentType}
                  </span>
                )}
              </div>

              <div className="modal-action-strip">
                <button
                  className="modal-action-btn"
                  onClick={() => void handleDownload()}
                  disabled={downloading}
                >
                  {downloading ? "⏳" : "⬇"} 下载{selectedPhoto.size ? ` (${formatSize(selectedPhoto.size)})` : ""}
                </button>
                {!selectedPhoto.contentType?.startsWith("video/") && (
                  <button
                    className="modal-action-btn"
                    onClick={() => void handleCopyImage()}
                    disabled={copyingImage}
                    title="复制图片到剪贴板"
                  >
                    {copyingImage ? "⏳" : "📋"} 复制
                  </button>
                )}
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
                {!selectedPhoto.contentType?.startsWith("video/") && !selectedPhoto.isAnimated && selectedPhoto.contentType !== "image/gif" && (
                  <button
                    className="modal-action-btn"
                    onClick={() => setShowOriginalPreview(true)}
                  >
                    🔍 预览
                  </button>
                )}
                <button
                  className={`modal-action-btn${showVoicePanel ? " modal-action-btn--active" : ""}${voiceState === "recording" ? " modal-action-btn--recording" : ""}`}
                  onClick={() => setShowVoicePanel((v) => !v)}
                  disabled={voiceState === "uploading"}
                >
                  {voiceState === "recording" ? "🔴 录音中" : selectedPhoto.voiceMemoUrl ? "🎤 备注✓" : "🎤 语音"}
                </button>
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

              {showVoicePanel && (
                <div className="modal-panel-box">
                  {selectedPhoto.voiceMemoUrl ? (
                    <div className="modal-voice-section">
                      <audio controls src={selectedPhoto.voiceMemoUrl} className="modal-voice-player" />
                      <button className="modal-action-btn modal-action-btn--danger" onClick={() => void deleteVoiceMemo()}>
                        🗑 删除备注
                      </button>
                    </div>
                  ) : voiceState === "idle" ? (
                    <button className="modal-action-btn" style={{ width: "100%", justifyContent: "center" }} onClick={() => void startRecording()}>
                      🎤 开始录音
                    </button>
                  ) : voiceState === "recording" ? (
                    <div className="modal-voice-section">
                      <span className="modal-privacy-notice" style={{ background: "#fff1f2", borderColor: "#fecdd3", color: "#be123c", flex: 1, marginBottom: 0 }}>
                        🔴 录音中... 点击停止上传
                      </span>
                      <button className="modal-action-btn modal-action-btn--danger" onClick={() => void stopAndUploadRecording()}>
                        ⏹ 停止
                      </button>
                    </div>
                  ) : (
                    <p className="modal-privacy-notice" style={{ background: "#f0f9ff", borderColor: "#bae6fd", color: "#0369a1" }}>
                      ⏳ 正在上传语音备注...
                    </p>
                  )}
                  {voiceError && (
                    <p className="modal-privacy-notice" style={{ borderColor: "#fca5a5", color: "#dc2626", background: "#fff5f5", marginTop: 4 }}>
                      {voiceError}
                    </p>
                  )}
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
                    <span className="modal-detail-label">拍摄时间</span>
                    <span className="modal-detail-value modal-subject-cell">
                      <span>{selectedPhoto.takenAt ? formatDate(selectedPhoto.takenAt) : <em className="modal-empty">未记录</em>}</span>
                      <button className="modal-edit-btn" onClick={() => setEditingTakenAt(true)}>✏</button>
                    </span>
                    {editingTakenAt && (
                      <PhotoTimeEditDialog
                        currentIso={selectedPhoto.takenAt}
                        saving={savingTakenAt}
                        onSave={(iso) => void saveTakenAt(iso)}
                        onClose={() => setEditingTakenAt(false)}
                      />
                    )}

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

                    {selectedPhoto.gpsLat && selectedPhoto.gpsLon &&
                      isFinite(parseFloat(selectedPhoto.gpsLat)) && isFinite(parseFloat(selectedPhoto.gpsLon)) && (
                      <>
                        <span className="modal-detail-label">位置</span>
                        <span className="modal-detail-value" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span>
                              {geoLoading ? "正在定位..." : (geoAddress ?? `${parseFloat(selectedPhoto.gpsLat).toFixed(4)}°, ${parseFloat(selectedPhoto.gpsLon).toFixed(4)}°`)}
                            </span>
                            <a
                              href={`https://maps.google.com/?q=${selectedPhoto.gpsLat},${selectedPhoto.gpsLon}`}
                              target="_blank"
                              rel="noreferrer"
                              className="modal-edit-btn"
                              title="在 Google 地图中查看"
                            >🗺</a>
                            <button className="modal-edit-btn" title={editingGps ? "关闭位置搜索" : "修改位置"} onClick={() => setEditingGps((v) => !v)}>{editingGps ? "✕" : "✏"}</button>
                          </span>
                          {editingGps && (
                            <LocationSearchPanel
                              saving={savingGps}
                              onSelect={(lat, lon) => void saveGps(lat, lon)}
                              onClose={() => setEditingGps(false)}
                            />
                          )}
                        </span>
                      </>
                    )}
                    {!selectedPhoto.gpsLat && (
                      <>
                        <span className="modal-detail-label">位置</span>
                        <span className="modal-detail-value" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <em className="modal-empty">未记录</em>
                            <button className="modal-edit-btn" title={editingGps ? "关闭位置搜索" : "添加位置"} onClick={() => setEditingGps((v) => !v)}>{editingGps ? "✕" : "+ 添加"}</button>
                          </span>
                          {editingGps && (
                            <LocationSearchPanel
                              saving={savingGps}
                              onSelect={(lat, lon) => void saveGps(lat, lon)}
                              onClose={() => setEditingGps(false)}
                            />
                          )}
                        </span>
                      </>
                    )}
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

      {/* Keyboard shortcut help overlay */}
      {showShortcutHelp && (
        <div className="shortcut-help-overlay" onClick={() => setShowShortcutHelp(false)}>
          <div className="shortcut-help-panel" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowShortcutHelp(false)}>✕</button>
            <h3 className="shortcut-help-title">键盘快捷键</h3>
            <table className="shortcut-help-table">
              <tbody>
                <tr><td><kbd>←</kbd> / <kbd>→</kbd></td><td>切换上/下一张</td></tr>
                <tr><td><kbd>F</kbd></td><td>收藏 / 取消收藏</td></tr>
                <tr><td><kbd>D</kbd></td><td>下载原图</td></tr>
                <tr><td><kbd>Delete</kbd></td><td>删除照片</td></tr>
                <tr><td><kbd>Esc</kbd></td><td>关闭预览</td></tr>
                <tr><td><kbd>Ctrl</kbd>+<kbd>A</kbd></td><td>批量模式下全选</td></tr>
                <tr><td><kbd>?</kbd></td><td>显示/关闭此帮助</td></tr>
              </tbody>
            </table>
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
