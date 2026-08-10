import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from "react";
import "./authenticated.css";
import { listPhotos, getCachedPhotos, getPersistedPhotos, uploadPhotoWithProgress, deletePhoto, movePhotoToFolder, renameFolderApi, setPhotoFavorite, listManagedShareLinks, extractVideoThumbnail, setVideoThumbnail, getAuthGeneration, subscribeToAuthChanges, selectFresherMediaUrl, proxyPhoto, authCacheOwner, isAuthorizationDriftError, AuthSessionChangedError, Photo, ManagedShareLink } from "./services/photoApi";
import { invalidatePhotoListCaches } from "./services/photoListCache";
import { shouldRefreshPhotoList } from "./services/photoLoadingPolicy";
import { subscribeToPreferredMediaRoute } from "./services/mediaRoute";
import { scorePhotoImportance, MOMENTS_MAX_PHOTOS } from "@cloudphoto/algorithm";
const loadPhotoGallery = () => import("./components/gallery/PhotoGallery");
const PhotoGallery = lazy(loadPhotoGallery);
const FolderView = lazy(() => import("./components/gallery/FolderView"));
const loadWhatsNewPopup = () => import("./components/whats-new/WhatsNewPopup");
const WhatsNewPopup = lazy(loadWhatsNewPopup);
import { FilterState, emptyFilter, GridSize } from "./components/gallery/FilterBar";
import GroupSwitcher from "./components/groups/GroupSwitcher";
import WorkspaceFab from "./components/home/floating/WorkspaceFab";
import WorkspaceSidebar from "./components/home/WorkspaceSidebar";
const SettingsDialog = lazy(() => import("./components/settings/SettingsDialog"));
import { useAuth } from "./contexts/AuthContext";
import { GroupProvider, useGroup } from "./contexts/GroupContext";
import { useToast } from "./contexts/ToastContext";
import OnThisDayCard from "./components/on-this-day/OnThisDayCard";
import ErrorBoundary from "./components/shared/ErrorBoundary";
import { getPwaInstallGuidance } from "./pwa/installPrompt";
import { usePwaInstall } from "./pwa/usePwaInstall";
import {
  activatePwaUpdate,
  isPwaUpdateReady,
  PWA_OFFLINE_READY_EVENT,
  PWA_UPDATE_READY_EVENT,
  type PwaUpdateBrowserWindow,
} from "./pwa/updatePolicy";
import {
  createInitialVoiceTransferStates,
  getActiveVoiceTransferState,
  setVoiceTransferState,
  type VoiceTransferSource,
  type VoiceTransferState,
} from "./transfer/voiceTransferState";
import {
  createInitialBatchMutationStates,
  getActiveBatchMutation,
  getBatchMutationLabel,
  getBatchMutationPercent,
  reduceBatchMutationEvent,
  type BatchMutationEvent,
  type BatchMutationSource,
} from "./transfer/batchMutationState";
const MemoryMap = lazy(() => import("./components/memory-map/MemoryMap"));
const TimeCapsule = lazy(() => import("./components/time-capsule/TimeCapsule"));
const AutoStory = lazy(() => import("./components/auto-story/AutoStory"));
const AddAdminDialog = lazy(() => import("./components/auth/AddAdminDialog"));
const InviteAcceptPage = lazy(() => import("./components/invites/InviteAcceptPage"));

const SUPER_ADMIN = "zhangchi";
const INSTALL_BANNER_DISMISSED_KEY = "cf_install_banner_dismissed";
const WHATS_NEW_IDLE_TIMEOUT_MS = 2_000;

function scheduleIdleMount(task: () => void) {
  let idleTaskHandle: number | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const runWhenCurrent = () => {
    if (cancelled) return;
    cancelled = true;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    task();
  };

  if (typeof window.requestIdleCallback === "function") {
    idleTaskHandle = window.requestIdleCallback(() => {
      runWhenCurrent();
    }, { timeout: WHATS_NEW_IDLE_TIMEOUT_MS });
  } else {
    timeoutHandle = setTimeout(runWhenCurrent, 0);
  }

  return () => {
    if (cancelled) return;
    cancelled = true;
    if (idleTaskHandle !== null && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(idleTaskHandle);
    }
    if (timeoutHandle) clearTimeout(timeoutHandle);
  };
}

class UploadWorkspaceChangedError extends Error {
  constructor() {
    super("空间已切换，上传已停止");
    this.name = "UploadWorkspaceChangedError";
  }
}

// ─── Video metadata extraction (MP4 / MOV / 3GP) ────────────────────────────
// Parses binary MP4 container to extract creation time (mvhd box) and GPS
// coordinates (©xyz atom inside udta box). Reads only the first 8 MB so
// large video files are handled efficiently.
async function extractVideoMetadata(file: File): Promise<{ takenAt?: string; gpsLat?: string; gpsLon?: string }> {
  try {
    const ab = await file.slice(0, Math.min(file.size, 8 * 1024 * 1024)).arrayBuffer();
    const u8 = new Uint8Array(ab);
    const dv = new DataView(ab);
    let pos = 0;
    while (pos + 8 <= u8.length) {
      const boxSize = dv.getUint32(pos);
      const type = String.fromCharCode(u8[pos+4], u8[pos+5], u8[pos+6], u8[pos+7]);
      if (boxSize === 1 || boxSize < 8) break; // 64-bit or corrupt
      if (type === "moov") return _parseMoovBox(dv, u8, pos + 8, Math.min(pos + boxSize, u8.length));
      pos += boxSize;
    }
  } catch { /* best-effort */ }
  return {};
}

function _parseMoovBox(dv: DataView, u8: Uint8Array, start: number, end: number) {
  let takenAt: string | undefined;
  let gpsLat: string | undefined;
  let gpsLon: string | undefined;
  let pos = start;
  while (pos + 8 <= end) {
    const boxSize = dv.getUint32(pos);
    if (boxSize < 8 || pos + boxSize > end) break;
    const type = String.fromCharCode(u8[pos+4], u8[pos+5], u8[pos+6], u8[pos+7]);
    if (type === "mvhd" && !takenAt) {
      // QuickTime epoch is 1904-01-01; offset to Unix epoch = 2082844800 s
      const QT = 2082844800;
      const ver = u8[pos + 8];
      const qtSec = ver === 1
        ? dv.getUint32(pos + 12) * 4294967296 + dv.getUint32(pos + 16)
        : dv.getUint32(pos + 12);
      const d = new Date((qtSec - QT) * 1000);
      if (!isNaN(d.getTime()) && d.getFullYear() >= 2000 && d.getFullYear() <= 2100) {
        const p = (n: number) => String(n).padStart(2, "0");
        takenAt = `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
      }
    }
    if (type === "udta") {
      // Search for ©xyz atom (0xa9 0x78 0x79 0x7a) inside udta
      let p2 = pos + 8;
      while (p2 + 8 <= pos + boxSize) {
        const s2 = dv.getUint32(p2);
        if (s2 < 8 || p2 + s2 > pos + boxSize) break;
        if (u8[p2+4] === 0xa9 && u8[p2+5] === 0x78 && u8[p2+6] === 0x79 && u8[p2+7] === 0x7a && p2 + 12 < p2 + s2) {
          // data: 2-byte length + 2-byte language + ISO-6709 GPS string
          const str = new TextDecoder("utf-8", { fatal: false }).decode(u8.slice(p2 + 12, p2 + s2));
          const m = str.match(/([+-]\d+\.?\d*)([+-]\d+\.?\d*)/);
          if (m) {
            const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
            if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) { gpsLat = String(lat); gpsLon = String(lon); }
          }
        }
        p2 += s2;
      }
    }
    pos += boxSize;
  }
  return { takenAt, gpsLat, gpsLon };
}
// ────────────────────────────────────────────────────────────────────────────

// Computed once at module load — avoids recalculating on every render
type ViewTab = "timeline" | "folder" | "moments" | "map" | "capsule" | "story";
type SettingsEntryTab = "profile" | "security" | "trash" | "diagnostics" | "app";
type SettingsFocusTarget = "overview" | "managed-shares" | "diagnostics";
type QuickDateFilter = "today" | "last7Days" | "thisWeek" | "thisMonth";

const QUICK_DATE_FILTER_OPTIONS: ReadonlyArray<{ key: QuickDateFilter; label: string; title: string }> = [
  { key: "today", label: "📅 今天", title: "今天（本地自然日）" },
  { key: "last7Days", label: "🕖 近7天", title: "近7天（含今天）" },
  { key: "thisWeek", label: "🗓 本周", title: "本周（周一至周日）" },
  { key: "thisMonth", label: "📆 本月", title: "本月（月初至月末）" },
];

function formatLocalDate(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toLocalDateKey(value?: string): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;

  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (dateOnlyMatch) {
    const [, yearText, monthText, dayText] = dateOnlyMatch;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const localDate = new Date(year, month - 1, day);
    if (
      localDate.getFullYear() !== year
      || localDate.getMonth() !== month - 1
      || localDate.getDate() !== day
    ) {
      return null;
    }
    return normalized;
  }

  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? formatLocalDate(date) : null;
}

function firstLocalDateKey(...values: Array<string | undefined>) {
  for (const value of values) {
    const dateKey = toLocalDateKey(value);
    if (dateKey) return dateKey;
  }
  return null;
}

function getPhotoUploadDateKey(photo: Photo) {
  return firstLocalDateKey(photo.createdAt, photo.lastModified);
}

function getPhotoDateKey(photo: Photo, sortKey: "taken" | "uploaded") {
  return sortKey === "uploaded"
    ? getPhotoUploadDateKey(photo)
    : firstLocalDateKey(photo.takenAt, photo.createdAt, photo.lastModified);
}

function getPhotoUploadTimestamp(photo: Photo) {
  for (const value of [photo.createdAt, photo.lastModified]) {
    if (!value) continue;
    const timestamp = new Date(value).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function getQuickDateRanges(referenceDate = new Date()): Record<QuickDateFilter, { dateFrom: string; dateTo: string }> {
  const today = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  const mondayOffset = (today.getDay() + 6) % 7;

  return {
    today: {
      dateFrom: formatLocalDate(today),
      dateTo: formatLocalDate(today),
    },
    last7Days: {
      dateFrom: formatLocalDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6)),
      dateTo: formatLocalDate(today),
    },
    thisWeek: {
      dateFrom: formatLocalDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - mondayOffset)),
      dateTo: formatLocalDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 6 - mondayOffset)),
    },
    thisMonth: {
      dateFrom: formatLocalDate(new Date(today.getFullYear(), today.getMonth(), 1)),
      dateTo: formatLocalDate(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
    },
  };
}

interface HomeDiagnosticsSnapshot {
  localMomentsCount: number;
  persistenceStatus: "unknown" | "local-only" | "server-synced" | "server-unavailable";
  persistenceUpdatedAt?: string;
}

function AppContent() {
  const { user, logout } = useAuth();
  useEffect(() => {
    void loadPhotoGallery();
  }, []);
  const photoCacheScope = user ? authCacheOwner(user.id, user.role) : "";
  const { currentGroupId, groups, groupsLoaded } = useGroup();
  const currentGroupIdRef = useRef(currentGroupId);
  currentGroupIdRef.current = currentGroupId;
  const showToast = useToast();
  const [showAddAdmin, setShowAddAdmin] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsEntryTab>("profile");
  const [settingsFocusTarget, setSettingsFocusTarget] = useState<SettingsFocusTarget>("overview");
  const [settingsFocusItemId, setSettingsFocusItemId] = useState<string | undefined>(undefined);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [updateReady, setUpdateReady] = useState<boolean>(() => isPwaUpdateReady(window as PwaUpdateBrowserWindow));
  const [installBannerDismissed, setInstallBannerDismissed] = useState<boolean>(() => localStorage.getItem(INSTALL_BANNER_DISMISSED_KEY) === "1");
  const pwaInstall = usePwaInstall();
  const canInstall = pwaInstall.mode === "native";
  const isStandalone = pwaInstall.mode === "installed";
  const previousInstallMode = useRef(pwaInstall.mode);

  // Location banner: shown briefly when entering a group or personal space
  const [locationBanner, setLocationBanner] = useState<string | null>(null);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewTabsRef = useRef<HTMLDivElement | null>(null);
  const [viewTabsScrollable, setViewTabsScrollable] = useState(false);
  const [viewTabsShowLeft, setViewTabsShowLeft] = useState(false);
  const [viewTabsShowRight, setViewTabsShowRight] = useState(false);
  const [headerHidden, setHeaderHidden] = useState(false);
  const scrollHideRef = useRef(0);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!groupsLoaded) return;
    const group = groups.find((g) => g.id === currentGroupId);
    const label = currentGroupId === "" ? "📷 个人空间" : `👥 ${group?.name ?? "群组"}`;
    setLocationBanner(label);
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    bannerTimer.current = setTimeout(() => setLocationBanner(null), 2200);
    return () => { if (bannerTimer.current) clearTimeout(bannerTimer.current); };
  }, [currentGroupId, groupsLoaded]); // groups intentionally omitted — only care when user switches

  useEffect(() => {
    const onUpdateReady = () => {
      setUpdateReady(true);
    };
    const onOfflineReady = () => showToast("已启用离线基础访问", "success");

    window.addEventListener(PWA_UPDATE_READY_EVENT, onUpdateReady as EventListener);
    window.addEventListener(PWA_OFFLINE_READY_EVENT, onOfflineReady as EventListener);
    if (isPwaUpdateReady(window as PwaUpdateBrowserWindow)) setUpdateReady(true);

    return () => {
      window.removeEventListener(PWA_UPDATE_READY_EVENT, onUpdateReady as EventListener);
      window.removeEventListener(PWA_OFFLINE_READY_EVENT, onOfflineReady as EventListener);
    };
  }, [showToast]);

  useEffect(() => {
    if (previousInstallMode.current !== "installed" && pwaInstall.mode === "installed") {
      showToast("Cloud Photo 已安装到设备", "success");
    }
    previousInstallMode.current = pwaInstall.mode;
  }, [pwaInstall.mode, showToast]);

  // Invite token from URL ?invite=<token>
  const [inviteToken, setInviteToken] = useState<string | null>(() => {
    const p = new URLSearchParams(window.location.search);
    return p.get("invite");
  });
  const dismissInvite = () => {
    setInviteToken(null);
    // Remove ?invite= from URL without reload
    const url = new URL(window.location.href);
    url.searchParams.delete("invite");
    window.history.replaceState({}, "", url.toString());
  };

  // Persist active tab per user across refreshes
  const tabKey = `cf_tab_${user?.username ?? "guest"}`;
  const [activeTab, setActiveTab] = useState<ViewTab>(() => {
    const stored = localStorage.getItem(tabKey);
    if (stored === "folder" || stored === "timeline" || stored === "moments") return stored;
    return "timeline";
  });
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showWhatsNewPopup, setShowWhatsNewPopup] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ bytesLoaded: number; bytesTotal: number; filesDone: number; filesTotal: number; folder: string; currentFile?: string } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [voiceTransferStates, setVoiceTransferStates] = useState(createInitialVoiceTransferStates);
  const [batchMutationStates, setBatchMutationStates] = useState(createInitialBatchMutationStates);
  const [filters, setFilters] = useState<FilterState>(emptyFilter);
  const [momentsShareViews, setMomentsShareViews] = useState<Record<string, number>>({});
  const [momentsDisplayCount, setMomentsDisplayCount] = useState<number | null>(null);
  const [managedShareLinks, setManagedShareLinks] = useState<ManagedShareLink[]>([]);
  const [managedShareLinksCount, setManagedShareLinksCount] = useState(0);
  const [managedShareViewsTotal, setManagedShareViewsTotal] = useState(0);
  const [topSharedPhotoName, setTopSharedPhotoName] = useState<string | null>(null);
  const [homeDiagnostics, setHomeDiagnostics] = useState<HomeDiagnosticsSnapshot>({
    localMomentsCount: 0,
    persistenceStatus: "unknown",
  });
  const [timelineFocusPhotoName, setTimelineFocusPhotoName] = useState<string | null>(null);
  const [timelineFocusRequestKey, setTimelineFocusRequestKey] = useState(0);
  const scrollLockYRef = useRef(0);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const lastPhotoRefreshRef = useRef<number>(0);
  const focusClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  // Deferred mount: FolderView is lazy-loaded, so we only mount it on the user's first visit
  // to the folder tab. Once mounted it stays mounted (tab-caching). Avoids a failed dynamic
  // import error ("main渲染失败") on app startup when the network/VM is briefly unavailable.
  const [folderMounted, setFolderMounted] = useState(() => activeTab === "folder");
  // Moments performs a full-photo statistics request, so do not mount it behind
  // display:none until the user actually opens the tab.
  const [momentsMounted, setMomentsMounted] = useState(() => activeTab === "moments");
  const [dragFileCount, setDragFileCount] = useState(0);
  const whatsNewMountRequest = useRef(0);
  const cancelIdleWhatsNewMount = useRef<(() => void) | null>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const [uploadTotalSize, setUploadTotalSize] = useState<string | null>(null);
  const [uploadPaused, setUploadPaused] = useState(false);
  const [uploadSpeed, setUploadSpeed] = useState("");
  const pausedRef = useRef(false);
  const resumeCallbackRef = useRef<(() => void) | null>(null);
  const uploadBatchRef = useRef<{
    controller: AbortController;
    workspaceId: string;
  } | null>(null);
  const speedRef = useRef<{ ts: number; bytes: number; ema: number }>({ ts: 0, bytes: 0, ema: 0 });
  const [weeklyCardExpanded, setWeeklyCardExpanded] = useState(false);
  const [photoSortAsc, setPhotoSortAsc] = useState(false);
  const [photoSortKey, setPhotoSortKey] = useState<"taken" | "uploaded">("taken");
  const [gridSize, setGridSize] = useState<GridSize>(() => (localStorage.getItem("cf_grid_size") as GridSize | null) ?? "md");
  const handleGridSizeChange = (size: GridSize) => { setGridSize(size); localStorage.setItem("cf_grid_size", size); };
  const uploadToFolderRef = useRef<((files: FileList, folder: string, subject?: string) => Promise<void>) | null>(null);
  const refreshAfterBatchMutationRef = useRef(false);
  const voiceTransferState = getActiveVoiceTransferState(voiceTransferStates);
  const activeBatchMutation = getActiveBatchMutation(batchMutationStates);
  const batchMutationActiveRef = useRef(false);
  batchMutationActiveRef.current = activeBatchMutation !== null;
  const transferring = uploadProgress !== null
    || downloading
    || deleteProgress !== null
    || voiceTransferState !== "idle"
    || activeBatchMutation !== null;

  const handleVoiceStateChange = useCallback((source: VoiceTransferSource, state: VoiceTransferState) => {
    setVoiceTransferStates((current) => setVoiceTransferState(current, source, state));
  }, []);
  const handleTimelineVoiceStateChange = useCallback(
    (state: VoiceTransferState) => handleVoiceStateChange("timeline", state),
    [handleVoiceStateChange],
  );
  const handleMomentsVoiceStateChange = useCallback(
    (state: VoiceTransferState) => handleVoiceStateChange("moments", state),
    [handleVoiceStateChange],
  );
  const handleFolderVoiceStateChange = useCallback(
    (state: VoiceTransferState) => handleVoiceStateChange("folder", state),
    [handleVoiceStateChange],
  );
  const handleBatchMutationChange = useCallback((source: BatchMutationSource, event: BatchMutationEvent) => {
    setBatchMutationStates((current) => reduceBatchMutationEvent(current, source, event));
  }, []);
  const handleTimelineBatchMutationChange = useCallback(
    (event: BatchMutationEvent) => handleBatchMutationChange("timeline", event),
    [handleBatchMutationChange],
  );
  const handleMomentsBatchMutationChange = useCallback(
    (event: BatchMutationEvent) => handleBatchMutationChange("moments", event),
    [handleBatchMutationChange],
  );
  const handleFolderBatchMutationChange = useCallback(
    (event: BatchMutationEvent) => handleBatchMutationChange("folder", event),
    [handleBatchMutationChange],
  );
  const transferGuardMessage = voiceTransferState === "recording"
    ? "录音中，请先结束录音"
    : voiceTransferState === "uploading"
      ? "语音备注上传中，请勿离开当前页面"
      : activeBatchMutation
        ? `${getBatchMutationLabel(activeBatchMutation.kind)}进行中（${activeBatchMutation.done}/${activeBatchMutation.total}），请勿离开当前页面`
        : "传输进行中，请稍候";
  const blockIfTransferring = useCallback(() => {
    if (!transferring) return false;
    showToast(transferGuardMessage, "info");
    return true;
  }, [showToast, transferGuardMessage, transferring]);

  const handleGroupSwitch = useCallback((nextGroupId: string) => {
    if (nextGroupId === currentGroupId) return true;
    if (blockIfTransferring()) return false;
    return true;
  }, [blockIfTransferring, currentGroupId]);

  useEffect(() => {
    const batch = uploadBatchRef.current;
    if (
      batch
      && batch.workspaceId !== currentGroupId
      && !batch.controller.signal.aborted
    ) {
      batch.controller.abort(new UploadWorkspaceChangedError());
    }
  }, [currentGroupId]);

  useEffect(() => () => {
    uploadBatchRef.current?.controller.abort(
      new DOMException("页面已关闭，上传已停止", "AbortError"),
    );
  }, []);

  const switchTab = (tab: ViewTab) => {
    if (tab === activeTab) return;
    if (blockIfTransferring()) return;
    setActiveTab(tab);
    localStorage.setItem(tabKey, tab);
    window.scrollTo({ top: 0, behavior: "smooth" });
    // Close sidebar when switching to folder view
    if (tab === "folder") setSidebarOpen(false);
  };

  // Scroll a clicked tab button to the horizontal center of its scroll container
  const scrollTabToCenter = (el: HTMLElement, container: HTMLElement) => {
    const targetLeft = el.offsetLeft - (container.clientWidth - el.offsetWidth) / 2;
    container.scrollTo({ left: targetLeft, behavior: "smooth" });
  };

  useEffect(() => {
    if (activeTab === "timeline" || activeTab === "moments") {
      // Only auto-open on explicit switch (not from persisted localStorage restore)
    }
  // intentionally empty — auto-open was removed to avoid jarring on load
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-hide header + tab bar: hide on scroll-down, reveal on scroll-up
  useEffect(() => {
    function handleScrollHide() {
      if (sidebarOpen) return;
      const y = window.scrollY;
      const delta = y - scrollHideRef.current;
      scrollHideRef.current = y;
      // Always show near top of page
      if (y < 60) { setHeaderHidden(false); return; }
      if (delta > 4) {
        setHeaderHidden(true);
      } else if (delta < -4) {
        setHeaderHidden(false);
      }
    }
    window.addEventListener("scroll", handleScrollHide, { passive: true });
    return () => window.removeEventListener("scroll", handleScrollHide);
  }, [sidebarOpen]);

  useEffect(() => {
    whatsNewMountRequest.current += 1;
    const requestId = whatsNewMountRequest.current;
    cancelIdleWhatsNewMount.current?.();
    cancelIdleWhatsNewMount.current = null;
    setShowWhatsNewPopup(false);
    if (loading) return;

    cancelIdleWhatsNewMount.current = scheduleIdleMount(() => {
      if (whatsNewMountRequest.current !== requestId) return;
      setShowWhatsNewPopup(true);
    });

    return () => {
      cancelIdleWhatsNewMount.current?.();
      cancelIdleWhatsNewMount.current = null;
    };
  }, [loading]);
  // Always show header when sidebar opens
  useEffect(() => { if (sidebarOpen) setHeaderHidden(false); }, [sidebarOpen]);
  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    if (userMenuOpen) document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [userMenuOpen]);

  useEffect(() => {
    if (!sidebarOpen) return;
    scrollLockYRef.current = window.scrollY;
    // Desktop: overflow:hidden prevents wheel/keyboard scroll.
    // iOS Safari: position:fixed on body breaks overflow:scroll in fixed children (the sidebar),
    // so we suppress scroll via touchmove instead.
    document.body.style.overflow = "hidden";
    const preventBodyScroll = (e: TouchEvent) => {
      const sidebarContent = document.querySelector(".workspace-sidebar-content");
      if (sidebarContent && sidebarContent.contains(e.target as Node)) return;
      e.preventDefault();
    };
    document.addEventListener("touchmove", preventBodyScroll, { passive: false });
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("touchmove", preventBodyScroll);
      window.scrollTo({ top: scrollLockYRef.current, behavior: "auto" });
    };
  }, [sidebarOpen]);

  // Derived lists for filter dropdowns
  const uploaders = useMemo(
    () => [...new Set(photos.map((p) => p.createdBy).filter(Boolean) as string[])].sort(),
    [photos]
  );
  const subjects = useMemo(
    () => [...new Set(photos.map((p) => p.subject).filter(Boolean) as string[])].sort(),
    [photos]
  );

  const filteredPhotos = useMemo(() => {
    return photos.filter((p) => {
      const name = (p.originalName || p.name.replace(/^\d+-/, "")).toLowerCase();
      const dateKey = getPhotoDateKey(p, photoSortKey);

      if (filters.name && !name.includes(filters.name.toLowerCase())) return false;
      if (filters.subject && !(p.subject ?? "").toLowerCase().includes(filters.subject.toLowerCase())) return false;
      if (filters.uploader && p.createdBy !== filters.uploader) return false;
      if ((filters.dateFrom || filters.dateTo) && !dateKey) return false;
      if (filters.dateFrom && dateKey && dateKey < filters.dateFrom) return false;
      if (filters.dateTo && dateKey && dateKey > filters.dateTo) return false;
      if (filters.favoriteOnly && !p.favorite) return false;
      if (filters.missingSubjectOnly && Boolean(p.subject?.trim())) return false;
      if (filters.uncategorizedOnly && Boolean((p.folder ?? "").trim())) return false;
      if (filters.noGpsOnly && Boolean(p.gpsLat)) return false;
      if (filters.folder && (p.folder ?? "").trim() !== filters.folder) return false;
      return true;
    });
  }, [photos, filters, photoSortKey]);

  const todayUploads = useMemo(() => {
    const today = getQuickDateRanges().today.dateFrom;
    return photos.filter((photo) => getPhotoUploadDateKey(photo) === today);
  }, [photos]);

  const greetingText = useMemo(() => {
    const h = new Date().getHours();
    if (h < 6) return "夜深了";
    if (h < 12) return "早上好";
    if (h < 18) return "下午好";
    return "晚上好";
  }, []);

  const weeklyStats = useMemo(() => {
    const range = getQuickDateRanges().thisWeek;
    const thisWeek = photos.filter((photo) => {
      const dateKey = getPhotoUploadDateKey(photo);
      return dateKey !== null && dateKey >= range.dateFrom && dateKey <= range.dateTo;
    }).length;
    const favorites = photos.filter((p) => p.favorite).length;
    return { thisWeek, favorites };
  }, [photos]);

  const storageUsed = useMemo(() => {
    const totalBytes = photos.reduce((sum, p) => sum + (p.size ?? 0), 0);
    if (totalBytes < 1024 * 1024) return `${(totalBytes / 1024).toFixed(0)} KB`;
    if (totalBytes < 1024 * 1024 * 1024) return `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }, [photos]);

  const availableFolders = useMemo(
    () => [...new Set(photos.map((p) => (p.folder ?? "").trim()).filter(Boolean))].sort(),
    [photos]
  );

  const importantPhotos = useMemo(() => {
    return [...photos]
      .map((p) => ({ p, score: scorePhotoImportance(p) }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.p)
      .slice(0, MOMENTS_MAX_PHOTOS);
  }, [photos]);

  const folderCount = useMemo(
    () => new Set(photos.map((photo) => (photo.folder ?? "").trim()).filter(Boolean)).size,
    [photos],
  );

  useEffect(() => {
    const updateViewTabAffordance = () => {
      const node = viewTabsRef.current;
      if (!node) return;
      const canScroll = node.scrollWidth > node.clientWidth + 8;
      setViewTabsScrollable(canScroll);
      setViewTabsShowLeft(canScroll && node.scrollLeft > 8);
      setViewTabsShowRight(canScroll && node.scrollLeft + node.clientWidth < node.scrollWidth - 8);
    };

    updateViewTabAffordance();
    window.addEventListener("resize", updateViewTabAffordance);
    return () => window.removeEventListener("resize", updateViewTabAffordance);
  }, [activeTab, filteredPhotos.length, folderCount, importantPhotos.length]);

  // Mount expensive panels on first visit, then retain their local UI state.
  useEffect(() => {
    if (activeTab === "folder") setFolderMounted(true);
    if (activeTab === "moments") setMomentsMounted(true);
  }, [activeTab]);

  const missingSubjectCount = useMemo(
    () => photos.filter((photo) => !photo.subject?.trim()).length,
    [photos],
  );

  const uncategorizedCount = useMemo(
    () => photos.filter((photo) => !(photo.folder ?? "").trim()).length,
    [photos],
  );

  const timelineHasActiveFilters = useMemo(
    () => Boolean(filters.name || filters.subject || filters.uploader || filters.dateFrom || filters.dateTo || filters.favoriteOnly || filters.missingSubjectOnly || filters.uncategorizedOnly || filters.noGpsOnly),
    [filters],
  );

  const activeFiltersCount = useMemo(() => {
    let count = 0;
    if (filters.name) count++;
    if (filters.subject) count++;
    if (filters.uploader) count++;
    if (filters.dateFrom || filters.dateTo) count++;
    if (filters.favoriteOnly) count++;
    if (filters.missingSubjectOnly) count++;
    if (filters.uncategorizedOnly) count++;
    if (filters.noGpsOnly) count++;
    return count;
  }, [filters]);

  const quickDateRanges = getQuickDateRanges();
  const activeQuickDateFilter = QUICK_DATE_FILTER_OPTIONS.find(({ key }) => {
    const range = quickDateRanges[key];
    return filters.dateFrom === range.dateFrom && filters.dateTo === range.dateTo;
  })?.key ?? null;

  const toggleQuickDateFilter = useCallback((period: QuickDateFilter) => {
    setFilters((current) => {
      const range = getQuickDateRanges()[period];
      const isActive = current.dateFrom === range.dateFrom && current.dateTo === range.dateTo;
      return {
        ...current,
        dateFrom: isActive ? "" : range.dateFrom,
        dateTo: isActive ? "" : range.dateTo,
      };
    });
  }, []);

  const showTodayUploads = useCallback(() => {
    setPhotoSortKey("uploaded");
    toggleQuickDateFilter("today");
  }, [toggleQuickDateFilter]);

  const recentUploads = useMemo(() => {
    const range = getQuickDateRanges().last7Days;
    return photos.filter((photo) => {
      const dateKey = getPhotoUploadDateKey(photo);
      return dateKey !== null && dateKey >= range.dateFrom && dateKey <= range.dateTo;
    });
  }, [photos]);

  const latestUploadText = useMemo(() => {
    const latestPhoto = [...photos].sort((a, b) => getPhotoUploadTimestamp(b) - getPhotoUploadTimestamp(a))[0];
    if (!latestPhoto) return "暂无上传记录";
    const timestamp = getPhotoUploadTimestamp(latestPhoto);
    return timestamp ? new Date(timestamp).toLocaleString("zh-CN") : "暂无上传时间";
  }, [photos]);

  const expiringSoonShareLinks = useMemo(() => {
    const now = Date.now();
    const twoDaysMs = 48 * 60 * 60 * 1000;
    return managedShareLinks.filter((item) => {
      const expiresAt = new Date(item.expiresAt).getTime();
      return item.status === "active" && Number.isFinite(expiresAt) && expiresAt > now && expiresAt - now <= twoDaysMs;
    });
  }, [managedShareLinks]);

  const momentsStats = useMemo(() => {
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const favoriteCount = importantPhotos.filter((p) => !!p.favorite).length;
    const withSubjectCount = importantPhotos.filter((p) => !!p.subject).length;
    const recentCount = importantPhotos.filter((p) => {
      const ts = new Date(p.createdAt ?? p.lastModified ?? 0).getTime();
      return Number.isFinite(ts) && now - ts <= thirtyDaysMs;
    }).length;
    return {
      total: importantPhotos.length,
      favoriteCount,
      withSubjectCount,
      recentCount,
      filteredTotal: filteredPhotos.length,
    };
  }, [importantPhotos, filteredPhotos.length]);

  const fetchAbortRef = useRef<AbortController | null>(null);
  const photoStateRevisionRef = useRef(0);
  const mutatePhotos = useCallback((updater: (previous: Photo[]) => Photo[]) => {
    photoStateRevisionRef.current += 1;
    fetchAbortRef.current?.abort();
    void invalidatePhotoListCaches();
    setPhotos(updater);
  }, []);

  useEffect(() => {
    photoStateRevisionRef.current += 1;
    fetchAbortRef.current?.abort();
    setPhotos([]);
  }, [photoCacheScope]);

  useEffect(() => subscribeToPreferredMediaRoute(() => {
    setPhotos((current) => current.map(proxyPhoto));
  }), []);

  const fetchPhotos = useCallback(async () => {
    if (batchMutationActiveRef.current) return;
    // Cancel any in-flight previous request before starting another full Blob listing.
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    const stateRevision = photoStateRevisionRef.current;
    const isCurrent = () => (
      !controller.signal.aborted
      && photoStateRevisionRef.current === stateRevision
    );
    lastPhotoRefreshRef.current = Date.now();

    let stale = getCachedPhotos(currentGroupId, photoCacheScope);
    let hasStale = stale !== null && stale.length > 0;
    if (hasStale && isCurrent()) {
      setPhotos(stale!);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setLoadError(false);

    try {
      // The memory cache disappears on reload. Restore the recent user-scoped
      // Cache Storage entry first so the gallery can paint while Azure refreshes.
      if (!hasStale) {
        stale = await getPersistedPhotos(currentGroupId, photoCacheScope, isCurrent);
        if (!isCurrent()) return;
        hasStale = stale !== null && stale.length > 0;
        if (hasStale) {
          setPhotos(stale!);
          setLoading(false);
        }
      }

      const data = await listPhotos(currentGroupId, {
        cacheScope: photoCacheScope,
        signal: controller.signal,
        isCurrent,
      });
      if (!isCurrent()) return;
      setPhotos(data);
    } catch (error) {
      // Superseded group/focus loads are intentionally aborted and must not
      // surface a false network error regardless of the transport's error type.
      if (controller.signal.aborted) return;
      if (isAuthorizationDriftError(error)) {
        setPhotos([]);
        return;
      }
      // Always show the error — even when stale data is shown the user needs to
      // know the refresh failed (otherwise they'd silently see outdated photos).
      showToast("加载照片失败，请检查网络或服务器状态", "error");
      if (!hasStale) setLoadError(true);
    } finally {
      if (fetchAbortRef.current === controller) {
        fetchAbortRef.current = null;
        setLoading(false);
      }
    }
  }, [currentGroupId, photoCacheScope, showToast]);

  useEffect(() => {
    void fetchPhotos();
    return () => fetchAbortRef.current?.abort();
  }, [fetchPhotos]);

  useEffect(() => {
    if (activeBatchMutation || !refreshAfterBatchMutationRef.current) return;
    refreshAfterBatchMutationRef.current = false;
    void fetchPhotos();
  }, [activeBatchMutation, fetchPhotos]);

  // Browsers commonly emit both visibilitychange and focus when returning to
  // the app. Both events share one 60 s gate so they cannot launch duplicate
  // full photo-list requests.
  useEffect(() => {
    let wasHidden = false;
    const refreshIfStale = () => {
      if (shouldRefreshPhotoList(lastPhotoRefreshRef.current)) {
        void fetchPhotos();
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        wasHidden = true;
      } else if (wasHidden) {
        wasHidden = false;
        refreshIfStale();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", refreshIfStale);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", refreshIfStale);
    };
  }, [fetchPhotos]);

  // Reset all active filters when the user switches groups (B5 / F9)
  useEffect(() => { setFilters(emptyFilter); }, [currentGroupId]);

  useEffect(() => {
    let disposed = false;
    const loadManagedShareSummary = async () => {
      try {
        const links = await listManagedShareLinks();
        if (disposed) return;
        const safeLinks = Array.isArray(links) ? links : [];
        setManagedShareLinks(safeLinks);
        setManagedShareLinksCount(safeLinks.filter((item) => item.status === "active").length);
        setManagedShareViewsTotal(safeLinks.reduce((sum, item) => sum + (item.viewCount ?? 0), 0));
        const topLink = [...safeLinks].sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0))[0];
        setTopSharedPhotoName(topLink?.displayName ?? null);
      } catch {
        if (!disposed) {
          setManagedShareLinks([]);
          setManagedShareLinksCount(0);
          setManagedShareViewsTotal(0);
          setTopSharedPhotoName(null);
        }
      }
    };
    void loadManagedShareSummary();
    return () => {
      disposed = true;
    };
  }, [currentGroupId]);

  useEffect(() => {
    const loadHomeDiagnostics = () => {
      let localMomentsCount = 0;
      let persistenceStatus: HomeDiagnosticsSnapshot["persistenceStatus"] = "unknown";
      let persistenceUpdatedAt: string | undefined;

      try {
        const rawMoments = localStorage.getItem("cloudphoto_moments_insights_v1");
        if (rawMoments) {
          const parsed = JSON.parse(rawMoments) as Record<string, unknown>;
          localMomentsCount = Object.keys(parsed ?? {}).length;
        }
      } catch {
        localMomentsCount = 0;
      }

      try {
        const rawDiagnostics = localStorage.getItem("cloudphoto_moments_diagnostics_v1");
        if (rawDiagnostics) {
          const parsed = JSON.parse(rawDiagnostics) as { status?: HomeDiagnosticsSnapshot["persistenceStatus"]; updatedAt?: string };
          persistenceStatus = parsed.status ?? "unknown";
          persistenceUpdatedAt = parsed.updatedAt;
        }
      } catch {
        persistenceStatus = "unknown";
      }

      setHomeDiagnostics({
        localMomentsCount,
        persistenceStatus,
        persistenceUpdatedAt,
      });
    };

    loadHomeDiagnostics();
    window.addEventListener("storage", loadHomeDiagnostics);
    window.addEventListener("focus", loadHomeDiagnostics);
    return () => {
      window.removeEventListener("storage", loadHomeDiagnostics);
      window.removeEventListener("focus", loadHomeDiagnostics);
    };
  }, []);

  useEffect(() => {
    if (activeTab !== "moments") return;
    let disposed = false;
    const loadMomentsViews = async () => {
      try {
        const linksRaw = await listManagedShareLinks();
        const links = Array.isArray(linksRaw) ? linksRaw : [];
        const counts = links.reduce<Record<string, number>>((acc, item) => {
          const key = item.blobName;
          if (!key) return acc;
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {});
        if (!disposed) setMomentsShareViews(counts);
      } catch {
        if (!disposed) setMomentsShareViews({});
      }
    };
    void loadMomentsViews();
    return () => {
      disposed = true;
    };
  }, [activeTab]);

  useEffect(() => {
    if (!transferring) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [transferring]);

  // Auto-clear focus highlight 2.2 s after it is set (animation is 1.6 s)
  useEffect(() => {
    if (!timelineFocusPhotoName) return;
    if (focusClearTimerRef.current) clearTimeout(focusClearTimerRef.current);
    focusClearTimerRef.current = setTimeout(() => setTimelineFocusPhotoName(null), 2200);
    return () => {
      if (focusClearTimerRef.current) clearTimeout(focusClearTimerRef.current);
    };
  }, [timelineFocusPhotoName]);

  // Scroll-to-top button visibility + reading progress (direct DOM, no setState)
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setShowScrollTop(y > 500);
      if (progressBarRef.current) {
        const docHeight = document.documentElement.scrollHeight - window.innerHeight;
        const progress = docHeight > 0 ? Math.min(100, (y / docHeight) * 100) : 0;
        progressBarRef.current.style.width = `${progress}%`;
        progressBarRef.current.style.opacity = progress > 0 ? "1" : "0";
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Keyboard shortcuts: R=refresh, ?=help, 1/2/3=tabs, S=sidebar, Backspace=clear, Esc=close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as Element)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.key === "r" || e.key === "R") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (blockIfTransferring()) return;
        void fetchPhotos();
      }
      if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setShowShortcutsHelp((v) => !v);
      }
      if (e.key === "1" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        switchTab("timeline");
      }
      if (e.key === "2" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        switchTab("folder");
      }
      if (e.key === "3" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        switchTab("moments");
      }
      if (e.key === "4" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        switchTab("map");
      }
      if (e.key === "5" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        switchTab("capsule");
      }
      if (e.key === "6" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        switchTab("story");
      }
      if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      }
      if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (activeFiltersCount > 0) {
          e.preventDefault();
          setFilters(emptyFilter);
          window.scrollTo({ top: 0, behavior: "smooth" });
          showToast("已清空所有筛选", "success");
        }
      }
      if (e.key === "Escape") {
        setSidebarOpen(false);
        setShowShortcutsHelp(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFiltersCount, blockIfTransferring, fetchPhotos, showToast, transferring]);

  // Global drag-over: desktop-only (only attach on non-touch devices)
  useEffect(() => {
    // Skip on touch-primary devices to avoid interfering with touch scroll
    if (window.matchMedia("(hover: none)").matches) return;
    let enterCount = 0;
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      enterCount++;
      setIsDragOver(true);
      setDragFileCount(e.dataTransfer.items ? Array.from(e.dataTransfer.items).filter((i) => i.kind === "file").length : 0);
    };
    const onDragLeave = () => {
      enterCount = Math.max(0, enterCount - 1);
      if (enterCount === 0) setIsDragOver(false);
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      enterCount = 0;
      setIsDragOver(false);
      if (e.dataTransfer?.files.length) {
        e.preventDefault();
        if (activeTab !== "folder") {
          if (blockIfTransferring()) return;
          setActiveTab("folder");
          localStorage.setItem(tabKey, "folder");
          showToast("已切换到文件夹视图，选择文件夹后上传", "success");
        }
      }
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [activeTab, blockIfTransferring, showToast, tabKey]);

  // Global paste: Ctrl+V image upload (screenshots, etc.)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // Skip if user is typing in an input/textarea
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || (active as HTMLElement).isContentEditable)) return;
      if (!e.clipboardData) return;
      const items = Array.from(e.clipboardData.items);
      const imageItem = items.find((item) => item.type.startsWith("image/"));
      if (!imageItem) return;
      e.preventDefault();
      const blob = imageItem.getAsFile();
      if (!blob) return;
      if (batchMutationActiveRef.current) {
        showToast(transferGuardMessage, "info");
        return;
      }
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const ext = imageItem.type.split("/")[1] ?? "png";
      const file = new File([blob], `paste-${ts}.${ext}`, { type: imageItem.type });
      const dt = new DataTransfer();
      dt.items.add(file);
      void uploadToFolderRef.current?.(dt.files, "");
      showToast(`📋 粘贴上传: ${file.name}`, "success");
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [showToast, transferGuardMessage]);

  const handleUploadToFolder = async (files: FileList, folder: string, subject?: string) => {
    if (batchMutationActiveRef.current) {
      showToast(transferGuardMessage, "info");
      return;
    }
    const IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif", "image/bmp", "image/tiff"]);
    const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-msvideo", "video/mpeg", "video/3gpp", "video/3gpp2"]);
    const ALLOWED_TYPES = new Set([...IMAGE_TYPES, ...VIDEO_TYPES]);
    const IMAGE_MAX = 20 * 1024 * 1024;   // 20 MB
    const VIDEO_MAX = 200 * 1024 * 1024;  // 200 MB

    const formatSpeed = (bps: number) => {
      if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
      if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
      return `${Math.round(bps)} B/s`;
    };
    const fileArray = Array.from(files);
    const invalidType = fileArray.filter((f) => !ALLOWED_TYPES.has(f.type));
    const oversized = fileArray.filter((f) => {
      if (!ALLOWED_TYPES.has(f.type)) return false;
      return f.size > (VIDEO_TYPES.has(f.type) ? VIDEO_MAX : IMAGE_MAX);
    });
    if (invalidType.length > 0 || oversized.length > 0) {
      const msgs: string[] = [];
      if (invalidType.length) msgs.push(`不支持的文件类型: ${invalidType.map((f) => f.name).join(", ")}`);
      if (oversized.length) msgs.push(`文件过大(图片>20MB,视频>200MB): ${oversized.map((f) => f.name).join(", ")}`);
      showToast(msgs.join("; "), "error");
    }
    const valid = fileArray.filter((f) => {
      if (!ALLOWED_TYPES.has(f.type)) return false;
      return f.size <= (VIDEO_TYPES.has(f.type) ? VIDEO_MAX : IMAGE_MAX);
    });
    if (valid.length === 0) return;
    if (uploadBatchRef.current) {
      showToast("已有上传任务正在进行，请等待完成后再试", "error");
      return;
    }
    const uploadAuthGeneration = getAuthGeneration();
    const uploadDisplayName = user?.displayName || undefined;
    const uploadWorkspaceId = currentGroupId;
    const uploadGroupId = uploadWorkspaceId || undefined;
    const batchController = new AbortController();
    uploadBatchRef.current = {
      controller: batchController,
      workspaceId: uploadWorkspaceId,
    };
    const unsubscribeAuth = subscribeToAuthChanges(() => {
      if (
        uploadAuthGeneration !== getAuthGeneration()
        && !batchController.signal.aborted
      ) {
        batchController.abort(new AuthSessionChangedError());
      }
    });
    const batchAbortReason = () => (
      batchController.signal.reason instanceof Error
        ? batchController.signal.reason
        : new AuthSessionChangedError()
    );
    const ownsUploadBatch = () => uploadBatchRef.current?.controller === batchController;
    const isBatchCancellation = (error: unknown) => (
      error instanceof AuthSessionChangedError
      || (error instanceof DOMException && error.name === "AbortError")
      || batchController.signal.aborted
    );
    const waitForRetry = (delayMs: number | null): Promise<void> => new Promise((resolve, reject) => {
      let timerId: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timerId) clearTimeout(timerId);
        window.removeEventListener("online", complete);
        batchController.signal.removeEventListener("abort", abort);
      };
      const complete = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(batchAbortReason());
      };
      if (batchController.signal.aborted) {
        abort();
        return;
      }
      batchController.signal.addEventListener("abort", abort, { once: true });
      if (delayMs === null) {
        if (navigator.onLine) complete();
        else window.addEventListener("online", complete, { once: true });
      } else {
        timerId = setTimeout(complete, delayMs);
      }
    });
    const waitForResume = (): Promise<void> => new Promise((resolve, reject) => {
      const cleanup = () => batchController.signal.removeEventListener("abort", abort);
      const abort = () => {
        cleanup();
        resumeCallbackRef.current = null;
        reject(batchAbortReason());
      };
      if (batchController.signal.aborted) {
        abort();
        return;
      }
      batchController.signal.addEventListener("abort", abort, { once: true });
      resumeCallbackRef.current = () => {
        cleanup();
        resumeCallbackRef.current = null;
        resolve();
      };
    });
    let batchCancelled = false;
    try {
    const bytesTotal = valid.reduce((sum, f) => sum + f.size, 0);
    const totalMB = (bytesTotal / (1024 * 1024)).toFixed(1);
    setUploadTotalSize(`${valid.length} 个 · ${totalMB} MB`);
    setUploadProgress({ bytesLoaded: 0, bytesTotal, filesDone: 0, filesTotal: valid.length, folder, currentFile: valid[0]?.name });

    // Reset speed tracking and pause state for this batch
    speedRef.current = { ts: Date.now(), bytes: 0, ema: 0 };
    pausedRef.current = false;
    setUploadPaused(false);
    setUploadSpeed("");

    const failed: string[] = [];
    let completedBytes = 0;
    for (let i = 0; i < valid.length; i++) {
      if (currentGroupIdRef.current !== uploadWorkspaceId) {
        batchController.abort(new UploadWorkspaceChangedError());
      }
      if (batchController.signal.aborted) {
        batchCancelled = true;
        break;
      }
      // ── Pause gate: wait here until resumed ──────────────────────────────
      if (pausedRef.current) {
        try {
          await waitForResume();
        } catch {
          batchCancelled = true;
          break;
        }
      }

      setUploadProgress({ bytesLoaded: completedBytes, bytesTotal, filesDone: i, filesTotal: valid.length, folder, currentFile: valid[i].name });
      const fileBase = completedBytes;
      const uploadId = crypto.randomUUID();
      try {
        const videoThumbnailPromise = valid[i].type.startsWith("video/")
          ? extractVideoThumbnail(valid[i]).catch(() => null)
          : Promise.resolve<Blob | null>(null);

        // Extract GPS from EXIF (images) or MP4/MOV container (videos)
        let gpsLat: string | undefined;
        let gpsLon: string | undefined;
        let videoTakenAt: string | undefined;
        if (valid[i].type.startsWith("image/")) {
          try {
            const exifrLib = await import("exifr");
            const gps = await exifrLib.gps(valid[i]);
            if (gps?.latitude != null && gps?.longitude != null
                && isFinite(gps.latitude) && isFinite(gps.longitude)) {
              gpsLat = String(gps.latitude);
              gpsLon = String(gps.longitude);
            }
          } catch { /* EXIF extraction is best-effort */ }
        } else if (valid[i].type.startsWith("video/")) {
          try {
            const meta = await extractVideoMetadata(valid[i]);
            gpsLat = meta.gpsLat;
            gpsLon = meta.gpsLon;
            videoTakenAt = meta.takenAt;
          } catch { /* best-effort */ }
        }

        // ── Upload with retry (up to 3 attempts, auto-waits for network) ──
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const uploadedPhoto = await uploadPhotoWithProgress(
              valid[i],
              (loaded) => {
                // Speed tracking (EMA, update every 500 ms)
                const now = Date.now();
                const elapsed = (now - speedRef.current.ts) / 1000;
                if (elapsed >= 0.5) {
                  const totalLoaded = fileBase + loaded;
                  const rawBps = (totalLoaded - speedRef.current.bytes) / elapsed;
                  speedRef.current.ema = speedRef.current.ema === 0 ? rawBps : speedRef.current.ema * 0.7 + rawBps * 0.3;
                  speedRef.current.ts = now;
                  speedRef.current.bytes = totalLoaded;
                  if (currentGroupIdRef.current === uploadWorkspaceId) {
                    setUploadSpeed(formatSpeed(speedRef.current.ema));
                  }
                }
                if (
                  !batchController.signal.aborted
                  && currentGroupIdRef.current === uploadWorkspaceId
                ) {
                  setUploadProgress({ bytesLoaded: fileBase + loaded, bytesTotal, filesDone: i, filesTotal: valid.length, folder, currentFile: valid[i].name });
                }
              },
              uploadDisplayName,
              subject || undefined,
              folder || undefined,
              uploadGroupId,
              gpsLat,
              gpsLon,
              batchController.signal,
              videoTakenAt,
              uploadId,
            );
            // Immediately add the uploaded photo so the folder view refreshes live
            if (
              !batchController.signal.aborted
              && currentGroupIdRef.current === uploadWorkspaceId
            ) {
              mutatePhotos(prev => prev.some(p => p.name === uploadedPhoto.name) ? prev : [...prev, uploadedPhoto]);
            }

            // The local frame was prepared while the original uploaded. Persist it
            // only after the server has created the original blob.
            if (valid[i].type.startsWith("video/")) {
              void (async () => {
                const thumb = await videoThumbnailPromise;
                if (!thumb) return;
                if (
                  uploadAuthGeneration !== getAuthGeneration()
                  || currentGroupIdRef.current !== uploadWorkspaceId
                ) return;
                const thumbnailUrl = await setVideoThumbnail(uploadedPhoto.name, thumb);
                if (
                  thumbnailUrl
                  && uploadAuthGeneration === getAuthGeneration()
                  && currentGroupIdRef.current === uploadWorkspaceId
                ) {
                  mutatePhotos(prev => prev.map(p =>
                    p.name === uploadedPhoto.name
                      ? {
                          ...p,
                          thumbnailUrl: selectFresherMediaUrl(p.thumbnailUrl, thumbnailUrl),
                        }
                      : p,
                  ));
                }
              })().catch(() => { /* best-effort */ });
            }

            lastErr = undefined;
            break; // success — exit retry loop
          } catch (e) {
            lastErr = e;
            if (isBatchCancellation(e)) break;
            if (attempt < 2) {
              if (!navigator.onLine) {
                // Wait until network comes back before retrying
                setUploadSpeed("等待网络…");
                await waitForRetry(null);
                setUploadSpeed("");
              } else {
                // Brief back-off between retries
                await waitForRetry(3000 * (attempt + 1));
              }
            }
          }
        }
        if (lastErr) throw lastErr;

        completedBytes += valid[i].size;
      } catch (error) {
        if (isBatchCancellation(error)) {
          batchCancelled = true;
          break;
        }
        failed.push(valid[i].name);
        completedBytes += valid[i].size;
      }
    }
    if (currentGroupIdRef.current !== uploadWorkspaceId) {
      batchController.abort(new UploadWorkspaceChangedError());
      batchCancelled = true;
    }
    if (batchCancelled) {
      if (ownsUploadBatch()) {
        setUploadProgress(null);
        setUploadTotalSize(null);
        setUploadSpeed("");
        setUploadPaused(false);
        pausedRef.current = false;
      }
      const reason = batchAbortReason();
      showToast(
        reason instanceof UploadWorkspaceChangedError
          ? reason.message
          : "登录状态已变更，上传已停止",
        "error",
      );
      return;
    }
    setUploadProgress({ bytesLoaded: bytesTotal, bytesTotal, filesDone: valid.length, filesTotal: valid.length, folder });
    await fetchPhotos();
    setUploadProgress(null);
    setUploadTotalSize(null);
    setUploadSpeed("");
    setUploadPaused(false);
    pausedRef.current = false;
    if (failed.length > 0) {
      showToast(`上传失败 (${failed.length}/${valid.length}): ${failed.join(", ")}`, "error");
    } else {
      const hasVideo = valid.some((f) => VIDEO_TYPES.has(f.type));
      showToast(`成功上传 ${valid.length} 个${hasVideo ? "文件" : "张照片"}`, "success");
    }
    } finally {
      unsubscribeAuth();
      if (ownsUploadBatch()) {
        resumeCallbackRef.current = null;
        uploadBatchRef.current = null;
      }
    }
  };
  // Keep ref up to date so paste handler always calls latest version
  uploadToFolderRef.current = handleUploadToFolder;

  const handleToggleUploadPause = () => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setUploadPaused(next);
    if (!next && resumeCallbackRef.current) {
      // Unblock the pause gate in the upload loop
      resumeCallbackRef.current();
      resumeCallbackRef.current = null;
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await deletePhoto(name);
      mutatePhotos((prev) => prev.filter((p) => p.name !== name));
      showToast("照片已删除", "success");
    } catch {
      showToast("删除失败，请重试", "error");
    }
  };

  const handleBatchDeleteWithProgress = async (names: string[]) => {
    if (names.length === 0) return;
    setDeleteProgress({ done: 0, total: names.length, label: "删除中" });
    let failed = 0;
    for (let i = 0; i < names.length; i++) {
      try {
        await deletePhoto(names[i]);
        mutatePhotos((prev) => prev.filter((p) => p.name !== names[i]));
      } catch { failed++; }
      setDeleteProgress({ done: i + 1, total: names.length, label: "删除中" });
    }
    setDeleteProgress(null);
    if (failed > 0) showToast(`${failed} 张删除失败`, "error");
    else showToast(`已删除 ${names.length} 张照片`, "success");
  };

  const handleSubjectUpdate = (name: string, subject: string) => {
    mutatePhotos((prev) =>
      prev.map((p) => (p.name === name ? { ...p, subject } : p))
    );
  };

  const handleTakenAtUpdate = (name: string, takenAt: string) => {
    mutatePhotos((prev) =>
      prev.map((p) => (p.name === name ? { ...p, takenAt } : p))
    );
  };

  const handleGpsUpdate = (name: string, gpsLat: string, gpsLon: string) => {
    mutatePhotos((prev) =>
      prev.map((p) => (p.name === name ? { ...p, gpsLat, gpsLon } : p))
    );
  };

  const handleRenamePhoto = (name: string, newOriginalName: string) => {
    mutatePhotos((prev) =>
      prev.map((p) => (p.name === name ? { ...p, originalName: newOriginalName } : p))
    );
  };

  const handleThumbnailUpdate = useCallback((name: string, thumbnailUrl: string) => {
    mutatePhotos((previous) => previous.map((photo) =>
      photo.name === name
        ? { ...photo, thumbnailUrl: selectFresherMediaUrl(photo.thumbnailUrl, thumbnailUrl) }
        : photo
    ));
  }, [mutatePhotos]);

  const handleMomentShareCreated = (photoName: string) => {
    setMomentsShareViews((prev) => ({
      ...prev,
      [photoName]: (prev[photoName] ?? 0) + 1,
    }));
  };

  const handleToggleFavorite = async (name: string, favorite: boolean): Promise<boolean> => {
    mutatePhotos((prev) => prev.map((p) => (p.name === name ? { ...p, favorite } : p)));
    try {
      await setPhotoFavorite(name, favorite, user?.displayName || undefined);
      return true;
    } catch {
      showToast(favorite ? "收藏失败" : "取消收藏失败", "error");
      await fetchPhotos();
      return false;
    }
  };

  const handleMovePhoto = async (name: string, toFolder: string): Promise<boolean> => {
    // Optimistic update (folder display only; name updated after server confirms)
    mutatePhotos((prev) => prev.map((p) => p.name === name ? { ...p, folder: toFolder } : p));
    try {
      const { newName } = await movePhotoToFolder(name, toFolder, user?.displayName || undefined);
      mutatePhotos((prev) => prev.map((p) => p.name === name ? { ...p, name: newName, folder: toFolder } : p));
      return true;
    } catch {
      showToast("移动照片失败", "error");
      if (batchMutationActiveRef.current) {
        refreshAfterBatchMutationRef.current = true;
      } else {
        await fetchPhotos();
      }
      return false;
    }
  };

  const handleRenameFolder = async (oldFolder: string, newFolder: string) => {
    try {
      const res = await renameFolderApi(oldFolder, newFolder, currentGroupId || undefined);
      showToast(`文件夹已重命名（${res.renamed} 张照片已更新）`, "success");
      await fetchPhotos();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "重命名失败", "error");
      throw e; // Let FolderView know it failed
    }
  };

  const handleInstallApp = async () => {
    try {
      const result = await pwaInstall.requestInstall();
      if (result.status === "guidance") {
        setShowInstallGuide(true);
      } else if (result.status === "prompted" && result.outcome === "accepted") {
        showToast("已确认安装，请按浏览器提示完成", "success");
      } else if (result.status === "prompted") {
        showToast("已取消安装，仍可从用户菜单或“设置 → 应用”再次打开", "info");
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "无法打开安装提示，请查看安装指引", "error");
      setShowInstallGuide(true);
    }
  };

  const handleRefreshToUpdate = async () => {
    const result = await activatePwaUpdate(window as PwaUpdateBrowserWindow, { transferring });
    if (result === "blocked-transferring") {
      showToast("传输进行中，请在传输完成后更新", "info");
      return;
    }
    if (result === "missing-updater") {
      showToast("更新服务暂不可用，请稍后再试", "error");
      return;
    }
    setUpdateReady(false);
  };

  const handleLaterUpdate = () => {
    setUpdateReady(false);
  };

  const dismissInstallBanner = () => {
    setInstallBannerDismissed(true);
    localStorage.setItem(INSTALL_BANNER_DISMISSED_KEY, "1");
  };

  const openSettingsTab = (tab: SettingsEntryTab, focusTarget: SettingsFocusTarget = "overview", focusItemId?: string) => {
    setSettingsInitialTab(tab);
    setSettingsFocusTarget(focusTarget);
    setSettingsFocusItemId(focusItemId);
    setShowSettings(true);
  };

  const jumpToTimelinePhoto = (photoName: string, nextFilters?: Partial<FilterState>) => {
    setFilters({
      ...emptyFilter,
      ...nextFilters,
    });
    setTimelineFocusPhotoName(photoName);
    setTimelineFocusRequestKey(Date.now());
    switchTab("timeline");
  };

  const jumpToRecentUploads = () => {
    setPhotoSortKey("uploaded");
    const targetPhoto = [...recentUploads].sort((a, b) => getPhotoUploadTimestamp(b) - getPhotoUploadTimestamp(a))[0];
    if (!targetPhoto) {
      switchTab("timeline");
      return;
    }
    const recentRange = getQuickDateRanges().last7Days;
    jumpToTimelinePhoto(targetPhoto.name, {
      dateFrom: recentRange.dateFrom,
      dateTo: recentRange.dateTo,
    });
  };

  const jumpToMissingSubjectPhotos = () => {
    const targetPhoto = [...photos]
      .filter((photo) => !photo.subject?.trim())
      .sort((a, b) => getPhotoUploadTimestamp(b) - getPhotoUploadTimestamp(a))[0];
    if (!targetPhoto) {
      switchTab("timeline");
      return;
    }
    jumpToTimelinePhoto(targetPhoto.name, {
      missingSubjectOnly: true,
    });
  };

  const jumpToOrganize = () => {
    if (missingSubjectCount > 0) {
      jumpToMissingSubjectPhotos();
    } else if (uncategorizedCount > 0) {
      jumpToUncategorizedPhotos();
    } else {
      switchTab("timeline");
    }
  };

  const jumpToUncategorizedPhotos = () => {
    const targetPhoto = [...photos]
      .filter((photo) => !(photo.folder ?? "").trim())
      .sort((a, b) => getPhotoUploadTimestamp(b) - getPhotoUploadTimestamp(a))[0];
    if (!targetPhoto) {
      switchTab("timeline");
      return;
    }
    jumpToTimelinePhoto(targetPhoto.name, {
      uncategorizedOnly: true,
    });
  };

  const installGuideText = useMemo(
    () => getPwaInstallGuidance(pwaInstall.platform),
    [pwaInstall.platform],
  );

  const installBannerText = useMemo(() => {
    if (pwaInstall.mode === "ios") return "可安装为 App：在 Safari 中点“分享 → 添加到主屏幕”。";
    if (canInstall) return "可安装为 App：点击“立即安装”后，可从桌面图标直接打开。";
    return "可安装为 App：打开安装指引，按设备步骤安装到桌面/主屏幕。";
  }, [canInstall, pwaInstall.mode]);

  return (
    <div className={`app${headerHidden ? " header-hidden" : ""}`}>
      {/* Reading progress bar – width/opacity driven by direct DOM ref, no setState */}
      <div ref={progressBarRef} className="scroll-progress-bar" style={{ width: "0%", opacity: 0 }} />

      {/* Global drag-drop overlay */}
      {isDragOver && (
        <div className="drag-overlay">
          <div className="drag-overlay-content">
            <div className="drag-overlay-icon">📂</div>
            <p className="drag-overlay-title">{dragFileCount > 0 ? `拖入 ${dragFileCount} 个文件` : "松开后跳转到文件夹视图上传"}</p>
            <p className="drag-overlay-sub">支持 JPG、PNG、WebP、HEIC 等格式</p>
          </div>
        </div>
      )}

      {/* Keyboard shortcuts help overlay */}
      {showShortcutsHelp && (
        <div className="dialog-overlay" onClick={() => setShowShortcutsHelp(false)}>
          <div className="shortcuts-help-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="shortcuts-help-header">
              <span>⌨️ 键盘快捷键</span>
              <button type="button" className="dialog-close-btn" onClick={() => setShowShortcutsHelp(false)} aria-label="关闭键盘快捷键">✕</button>
            </div>
            <ul className="shortcuts-list">
              <li><kbd>R</kbd><span>刷新照片列表</span></li>
              <li><kbd>?</kbd><span>显示 / 关闭本面板</span></li>
              <li><kbd>1 / 2 / 3</kbd><span>切换时间线 / 文件夹 / 重要片段</span></li>
              <li><kbd>4 / 5 / 6</kbd><span>记忆地图 / 时光胶囊 / 自动故事</span></li>
              <li><kbd>S</kbd><span>开启 / 关闭侧边栏</span></li>
              <li><kbd>⌫ Backspace</kbd><span>清空所有筛选条件</span></li>
              <li><kbd>Esc</kbd><span>关闭侧边栏 / 弹框</span></li>
              <li><kbd>← →</kbd><span>照片详情上一张 / 下一张</span></li>
            </ul>
          </div>
        </div>
      )}
      {locationBanner && (
        <div className="location-banner" key={locationBanner}>
          {locationBanner}
        </div>
      )}
      <header className="app-header">
        <svg className="app-logo-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 15.2c1.77 0 3.2-1.43 3.2-3.2s-1.43-3.2-3.2-3.2S8.8 10.23 8.8 12s1.43 3.2 3.2 3.2zM9 3L7.17 5H4C2.9 5 2 5.9 2 7v13c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2h-3.17L15 3H9zm3 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 8.5 12 8.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5z"/>
        </svg>
        <h1>
          Cloud Photo
          <span className="header-greeting">{greetingText} 👋</span>
        </h1>
        <GroupSwitcher onBeforeSelect={handleGroupSwitch} disabled={transferring} />
        <span className="photo-count">
          {photos.length.toLocaleString()} 张
          {recentUploads.length > 0 && (
            <span className="photo-count-recent">+{recentUploads.length} 近7天</span>
          )}
        </span>
        {/* ── Avatar user-menu ── */}
        <div className="user-avatar-wrap" ref={userMenuRef}>
          <button
            className={`user-avatar-btn${user?.role === "admin" ? " user-avatar-btn--admin" : ""}`}
            onClick={() => setUserMenuOpen((v) => !v)}
            aria-haspopup="true"
            aria-expanded={userMenuOpen}
            aria-label={`${userMenuOpen ? "关闭" : "打开"}用户菜单：${user?.displayName ?? "用户"}`}
            title={user?.displayName}
          >
            {user?.displayName?.[0]?.toUpperCase() ?? "U"}
          </button>
          {userMenuOpen && (
            <div className="user-menu-dropdown">
              <div className="user-menu-header">
                <div className="user-menu-name">{user?.displayName}</div>
                <div className="user-menu-sub">
                  <span>@{user?.username}</span>
                  {user?.role === "admin" && <span className="role-badge">Admin</span>}
                </div>
              </div>
              <button className="user-menu-item" onClick={() => { setShowSettings(true); setUserMenuOpen(false); }}>
                <span className="user-menu-item-icon">⚙️</span> 设置
              </button>
              <button
                className="user-menu-item"
                disabled={isStandalone}
                onClick={() => { setUserMenuOpen(false); void handleInstallApp(); }}
              >
                <span className="user-menu-item-icon">{isStandalone ? "✅" : "📲"}</span>
                {isStandalone ? "已安装应用" : "安装应用"}
              </button>
              <button className="user-menu-item" onClick={() => { setShowShortcutsHelp(true); setUserMenuOpen(false); }}>
                <span className="user-menu-item-icon">⌨️</span> 快捷键
              </button>
              {user?.username === SUPER_ADMIN && (
                <>
                  <div className="user-menu-divider" />
                  <button className="user-menu-item" onClick={() => { setShowAddAdmin(true); setUserMenuOpen(false); }}>
                    <span className="user-menu-item-icon">➕</span> 添加管理员
                  </button>
                </>
              )}
              <div className="user-menu-divider" />
              <button className="user-menu-item user-menu-item--danger" onClick={() => { logout(); setUserMenuOpen(false); }}>
                <span className="user-menu-item-icon">🚪</span> 退出登录
              </button>
            </div>
          )}
        </div>
      </header>

      {showAddAdmin && <Suspense fallback={null}><AddAdminDialog onClose={() => setShowAddAdmin(false)} /></Suspense>}
      {showSettings && (
        <Suspense fallback={null}><SettingsDialog
          onClose={() => setShowSettings(false)}
          onPhotosRestored={fetchPhotos}
          canInstall={canInstall}
          isStandalone={isStandalone}
          installOutcome={pwaInstall.outcome}
          initialTab={settingsInitialTab}
          initialFocusTarget={settingsFocusTarget}
          initialFocusItemId={settingsFocusItemId}
          onInstallApp={() => void handleInstallApp()}
        /></Suspense>
      )}
      {inviteToken && <Suspense fallback={null}><InviteAcceptPage token={inviteToken} onDone={dismissInvite} /></Suspense>}
      {showInstallGuide && (
        <div className="dialog-overlay" onClick={() => setShowInstallGuide(false)}>
          <div className="add-admin-dialog install-guide-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="add-admin-header">
              <span>安装使用指引</span>
              <button type="button" className="dialog-close-btn" onClick={() => setShowInstallGuide(false)} aria-label="关闭安装使用指引">✕</button>
            </div>
            <p className="add-admin-hint">{isStandalone ? "当前已是 App 模式" : "可同时作为网站和 App 使用"}</p>
            <ol className="install-guide-list">
              {installGuideText.map((item) => <li key={item}>{item}</li>)}
            </ol>
            <p className="install-guide-note">提示：上传或下载过程中，请不要刷新页面或关闭应用窗口。</p>
          </div>
        </div>
      )}

      <main className="app-main">
        {transferring && (
          <div className="transfer-banner">
            {deleteProgress ? (
              <>
                <div className="transfer-banner-row">
                  <span className="transfer-banner-icon">🗑️</span>
                  <div className="transfer-banner-body">
                    <span className="transfer-banner-text">
                      {deleteProgress.label} ({deleteProgress.done}/{deleteProgress.total})
                    </span>
                  </div>
                  <span className="transfer-banner-pct">
                    {Math.round((deleteProgress.done / deleteProgress.total) * 100)}%
                  </span>
                </div>
                <div className="transfer-banner-track">
                  <div
                    className="transfer-banner-fill"
                    style={{ width: `${Math.round((deleteProgress.done / deleteProgress.total) * 100)}%` }}
                  />
                </div>
              </>
            ) : uploadProgress ? (
              <>
                <div className="transfer-banner-row">
                  <span className="transfer-banner-icon">⬆️</span>
                  <div className="transfer-banner-body">
                    <span className="transfer-banner-text">
                      {uploadPaused
                        ? `已暂停 (${uploadProgress.filesDone + 1}/${uploadProgress.filesTotal})`
                        : uploadProgress.currentFile
                          ? `上传中 ${uploadProgress.currentFile} (${uploadProgress.filesDone + 1}/${uploadProgress.filesTotal})`
                          : `上传完成 (${uploadProgress.filesTotal}/${uploadProgress.filesTotal})`}
                    </span>
                    {uploadTotalSize && (
                      <span className="transfer-banner-size">
                        {(uploadProgress.bytesLoaded / 1024 / 1024).toFixed(1)} / {(uploadProgress.bytesTotal / 1024 / 1024).toFixed(1)} MB
                        {uploadSpeed ? <span className="transfer-banner-speed"> · {uploadSpeed}</span> : null}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="transfer-banner-pause"
                    onClick={handleToggleUploadPause}
                    aria-label={uploadPaused ? "继续上传" : "暂停上传（当前文件传完后暂停）"}
                    title={uploadPaused ? "继续上传" : "暂停上传（当前文件传完后暂停）"}
                  >
                    {uploadPaused ? (
                      /* Play triangle */
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                        <polygon points="3,1 13,7 3,13" />
                      </svg>
                    ) : (
                      /* Pause two bars */
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                        <rect x="2" y="1" width="4" height="12" rx="1" />
                        <rect x="8" y="1" width="4" height="12" rx="1" />
                      </svg>
                    )}
                  </button>
                  <span className="transfer-banner-pct">
                    {Math.round((uploadProgress.bytesLoaded / uploadProgress.bytesTotal) * 100)}%
                  </span>
                </div>
                <div className="transfer-banner-track">
                  <div
                    className="transfer-banner-fill"
                    style={{ width: `${Math.round((uploadProgress.bytesLoaded / uploadProgress.bytesTotal) * 100)}%` }}
                  />
                </div>
              </>
            ) : voiceTransferState === "recording" ? (
              <div className="transfer-banner-row">
                <span className="transfer-banner-icon">🎙️</span>
                <span className="transfer-banner-text">录音中，请先结束录音</span>
              </div>
            ) : voiceTransferState === "uploading" ? (
              <div className="transfer-banner-row">
                <span className="transfer-banner-icon">🎤</span>
                <span className="transfer-banner-text">语音备注上传中，请勿关闭页面</span>
              </div>
            ) : activeBatchMutation ? (
              <>
                <div className="transfer-banner-row">
                  <span className="transfer-banner-icon">🛠️</span>
                  <div className="transfer-banner-body">
                    <span className="transfer-banner-text">
                      {getBatchMutationLabel(activeBatchMutation.kind)} {activeBatchMutation.done}/{activeBatchMutation.total}
                    </span>
                    {activeBatchMutation.failed > 0 && (
                      <span className="transfer-banner-size">失败 {activeBatchMutation.failed} 张</span>
                    )}
                  </div>
                  <span className="transfer-banner-pct">{getBatchMutationPercent(activeBatchMutation)}%</span>
                </div>
                <div className="transfer-banner-track">
                  <div
                    className="transfer-banner-fill"
                    style={{ width: `${getBatchMutationPercent(activeBatchMutation)}%` }}
                  />
                </div>
              </>
            ) : downloading ? (
              <div className="transfer-banner-row">
                <span className="transfer-banner-icon">⬇️</span>
                <span className="transfer-banner-text">下载中，请勿关闭页面</span>
              </div>
            ) : null}
          </div>
        )}

        {updateReady && (
          <div className="pwa-update-banner">
            <span>{transferring ? "检测到新版本，传输完成后可更新。" : "检测到新版本，点击即可更新。"}</span>
            <div className="pwa-install-actions">
              <button disabled={transferring} onClick={() => void handleRefreshToUpdate()}>
                {transferring ? "传输完成后更新" : "立即更新"}
              </button>
              <button className="pwa-install-later" onClick={handleLaterUpdate}>稍后提醒</button>
            </div>
          </div>
        )}

        {!isStandalone && !installBannerDismissed && (
          <div className="pwa-install-banner">
            <span>{installBannerText}</span>
            <div className="pwa-install-actions">
              {canInstall ? (
                <button onClick={() => void handleInstallApp()}>立即安装</button>
              ) : (
                <button onClick={() => setShowInstallGuide(true)}>查看安装指引</button>
              )}
              <button className="pwa-install-later" onClick={dismissInstallBanner}>稍后</button>
            </div>
          </div>
        )}

        {/* Tab bar */}
        <div className="view-tabs-shell-wrap">
        <div className={`view-tabs-shell${viewTabsScrollable ? " view-tabs-shell--scrollable" : ""}`}>
          {viewTabsScrollable && (
            <div className="view-tabs-meta">
              <span className="view-tabs-hint">← 左右滑动 →</span>
            </div>
          )}
          <div className="view-tabs-scroll-area">
          <div className={`view-tabs-fade view-tabs-fade--left${viewTabsShowLeft ? " is-visible" : ""}`} />
          <div className={`view-tabs-fade view-tabs-fade--right${viewTabsShowRight ? " is-visible" : ""}`} />
          <div className="view-tabs" ref={viewTabsRef} onScroll={() => {
            const node = viewTabsRef.current;
            if (!node) return;
            setViewTabsShowLeft(node.scrollLeft > 8);
            setViewTabsShowRight(node.scrollLeft + node.clientWidth < node.scrollWidth - 8);
          }}>
          <button
            className={`view-tab${activeTab === "timeline" ? " active" : ""}`}
            onClick={(e) => { switchTab("timeline"); if (viewTabsRef.current) scrollTabToCenter(e.currentTarget, viewTabsRef.current); }}
          >
            <span>🕐 时间线</span>
            <span className="view-tab-count">{filteredPhotos.length}</span>
            {activeFiltersCount > 0 && <span className="view-tab-filter-dot" />}
          </button>
          <button
            className={`view-tab${activeTab === "folder" ? " active" : ""}`}
            onClick={(e) => { switchTab("folder"); if (viewTabsRef.current) scrollTabToCenter(e.currentTarget, viewTabsRef.current); }}
          >
            <span>📁 文件夹</span>
            <span className="view-tab-count">{folderCount}</span>
          </button>
          <button
            className={`view-tab${activeTab === "moments" ? " active" : ""}`}
            onClick={(e) => { switchTab("moments"); if (viewTabsRef.current) scrollTabToCenter(e.currentTarget, viewTabsRef.current); }}
          >
            <span>⭐ 重要片段</span>
            <span className="view-tab-count">{momentsDisplayCount ?? Math.min(importantPhotos.length, 20)}</span>
          </button>
          <button
            className={`view-tab${activeTab === "map" ? " active" : ""}`}
            onClick={(e) => { switchTab("map"); if (viewTabsRef.current) scrollTabToCenter(e.currentTarget, viewTabsRef.current); }}
          >
            <span>🗺️ 记忆地图</span>
            <span className="view-tab-count">{photos.filter((p) => p.gpsLat).length || ""}</span>
          </button>
          <button
            className={`view-tab${activeTab === "capsule" ? " active" : ""}`}
            onClick={(e) => { switchTab("capsule"); if (viewTabsRef.current) scrollTabToCenter(e.currentTarget, viewTabsRef.current); }}
          >
            <span>💌 时光胶囊</span>
          </button>
          <button
            className={`view-tab${activeTab === "story" ? " active" : ""}`}
            onClick={(e) => { switchTab("story"); if (viewTabsRef.current) scrollTabToCenter(e.currentTarget, viewTabsRef.current); }}
          >
            <span>🎬 自动故事</span>
          </button>
          </div>
          </div>
          {activeTab === "timeline" && (
            <div className="quick-date-chips">
              {QUICK_DATE_FILTER_OPTIONS.map(({ key, label, title }) => (
                <button
                  key={key}
                  className={`quick-chip${activeQuickDateFilter === key ? " active" : ""}`}
                  onClick={() => toggleQuickDateFilter(key)}
                  aria-pressed={activeQuickDateFilter === key}
                  title={`${title}，按${photoSortKey === "taken" ? "拍摄" : "上传"}时间筛选`}
                >{label}</button>
              ))}
              <button
                className={`quick-chip${filters.favoriteOnly ? " active" : ""}`}
                onClick={() => setFilters((f) => ({ ...f, favoriteOnly: !f.favoriteOnly }))}
              >⭐ 收藏</button>
              {availableFolders.slice(0, 4).map((folder) => (
                <button
                  key={folder}
                  className={`quick-chip quick-chip--folder${filters.folder === folder ? " active" : ""}`}
                  onClick={() => setFilters((f) => ({ ...f, folder: f.folder === folder ? "" : folder }))}
                  title={folder}
                >📁 {folder.split("/").filter(Boolean).pop() ?? folder}</button>
              ))}
              {missingSubjectCount > 0 && (
                <button
                  className={`quick-chip quick-chip--organize${filters.missingSubjectOnly ? " active" : ""}`}
                  onClick={() => setFilters((f) => ({ ...f, missingSubjectOnly: !f.missingSubjectOnly, uncategorizedOnly: false }))}
                >🏷 无主题 {missingSubjectCount}</button>
              )}
              {uncategorizedCount > 0 && (
                <button
                  className={`quick-chip quick-chip--organize${filters.uncategorizedOnly ? " active" : ""}`}
                  onClick={() => setFilters((f) => ({ ...f, uncategorizedOnly: !f.uncategorizedOnly, missingSubjectOnly: false }))}
                >📂 未分类 {uncategorizedCount}</button>
              )}
              {activeFiltersCount > 0 && (
                <button className="quick-chip quick-chip--clear" onClick={() => setFilters(emptyFilter)}>✕ 清空</button>
              )}
              {/* Sort key toggle */}
              <button
                className={`quick-chip${photoSortKey === "taken" ? " quick-chip--sort active" : ""}`}
                onClick={() => setPhotoSortKey("taken")}
                title="按照片拍摄时间排序和筛选日期"
              >📷 拍摄时间</button>
              <button
                className={`quick-chip${photoSortKey === "uploaded" ? " quick-chip--sort active" : ""}`}
                onClick={() => setPhotoSortKey("uploaded")}
                title="按上传时间排序和筛选日期"
              >☁ 上传时间</button>
              {/* Sort order toggle */}
              <button
                className={`quick-chip quick-chip--sort${photoSortAsc ? " active" : ""}`}
                onClick={() => setPhotoSortAsc((v) => !v)}
                title={photoSortAsc ? "当前：时间正序" : "当前：时间倒序"}
              >{photoSortAsc ? "↑ 最早" : "↓ 最新"}</button>
            </div>
          )}
        </div>{/* /view-tabs-shell */}

        {activeTab === "timeline" && photos.length > 0 && (
            <div className="weekly-summary-card">
              <button
                className="weekly-summary-toggle"
                onClick={() => setWeeklyCardExpanded((v) => !v)}
              >
                <span className="weekly-summary-title">📊 本周概况</span>
                {!weeklyCardExpanded && (
                  <span className="weekly-summary-peek">{weeklyStats.thisWeek} 张上传 · ⭐ {weeklyStats.favorites} 收藏 · 💾 {storageUsed}</span>
                )}
                <span className="weekly-summary-chevron">{weeklyCardExpanded ? "▲" : "▼"}</span>
              </button>
              {weeklyCardExpanded && (
                <div className="weekly-summary-body">
                  <div className="weekly-summary-row">
                    <span>📸 本周上传</span><strong>{weeklyStats.thisWeek} 张</strong>
                  </div>
                  <div className="weekly-summary-row">
                    <span>⭐ 总收藏</span><strong>{weeklyStats.favorites} 张</strong>
                  </div>
                  <div className="weekly-summary-row">
                    <span>📁 文件夹</span><strong>{availableFolders.length} 个</strong>
                  </div>
                  <div className="weekly-summary-row">
                    <span>💾 占用存储</span><strong>{storageUsed}</strong>
                  </div>
                  {todayUploads.length > 0 && (
                    <div className="weekly-summary-row weekly-summary-row--highlight">
                      <span>🌟 今日上传</span><strong>{todayUploads.length} 张</strong>
                    </div>
                  )}
                  <button
                    className="share-summary-btn"
                    onClick={() => {
                      const text = `📷 Cloud Photo 周报\n本周上传：${weeklyStats.thisWeek} 张\n总收藏：${weeklyStats.favorites} 张\n文件夹：${availableFolders.length} 个\n总照片：${photos.length} 张\n占用存储：${storageUsed}`;
                      void navigator.clipboard.writeText(text).then(() => showToast("周报已复制到剪贴板 📋", "success"));
                    }}
                  >📋 复制周报</button>
                </div>
              )}
            </div>
          )}

        </div>{/* /view-tabs-shell-wrap */}

        <div className="workspace-layout">
          <div className="workspace-main">
            {(activeTab === "timeline" || activeTab === "moments") && (
              <WorkspaceFab
                activeTab={activeTab as "timeline" | "moments"}
                hidden={sidebarOpen}
                filterCount={activeTab === "timeline" ? activeFiltersCount : 0}
                onOpenSidebar={() => setSidebarOpen(true)}
                onPrimaryChipClick={activeTab === "timeline" ? jumpToRecentUploads : () => openSettingsTab("app", "managed-shares", managedShareLinks[0]?.id)}
                onSecondaryChipClick={activeTab === "timeline" ? jumpToOrganize : () => openSettingsTab("diagnostics", "diagnostics")}
              />
            )}

            <ErrorBoundary label="main">
            {loading ? (
          <div className="loading">
            <div className="loading-spinner" />
            <span>加载中…</span>
          </div>
        ) : loadError ? (
          <div className="load-error">
            <p>加载照片失败</p>
            <button className="retry-btn" onClick={() => void fetchPhotos()}>重试</button>
          </div>
        ) : photos.length === 0 ? (
          <div className="empty-gallery">
            <div className="empty-gallery-icon">📷</div>
            <p className="empty-gallery-title">还没有照片</p>
            <p className="empty-gallery-sub">前往文件夹视图，开始上传你的第一张照片吧</p>
            <div className="empty-gallery-actions">
              <button className="empty-gallery-btn" onClick={() => switchTab("folder")}>去上传照片</button>
            </div>
          </div>
        ) : (
          <>
            {/* ── Timeline panel ── kept mounted so thumbnail imgLoaded state and browser-cached
                images survive tab switches. Only hidden via CSS, never unmounted. */}
            <div style={{ display: activeTab === "timeline" ? "" : "none" }}>
              {activeTab === "timeline" && filteredPhotos.length === 0 ? (
                <div className="empty-gallery empty-gallery--actionable">
                  <div className="empty-gallery-icon">🔎</div>
                  <p className="empty-gallery-title">当前筛选没有匹配照片</p>
                  <p className="empty-gallery-sub">可以一键清空筛选，或者去文件夹视图继续上传和整理。</p>
                  <div className="empty-gallery-actions">
                    {timelineHasActiveFilters && (
                      <button className="empty-gallery-btn" onClick={() => setFilters(emptyFilter)}>
                        清空筛选
                      </button>
                    )}
                    <button className="empty-gallery-btn empty-gallery-btn--secondary" onClick={() => switchTab("folder")}>
                      去文件夹视图
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {todayUploads.length > 0 && !filters.dateFrom && !filters.dateTo && (
                    <div className="today-uploads-notice">
                      <span>📸 今天上传了 <strong>{todayUploads.length}</strong> 张</span>
                      <button
                        className="today-uploads-jump"
                        onClick={showTodayUploads}
                      >仅查看今日</button>
                    </div>
                  )}
                  <OnThisDayCard photos={photos} onJumpToPhoto={jumpToTimelinePhoto} />
                  <Suspense fallback={<div className="loading"><div className="loading-spinner" /><span>正在加载照片视图…</span></div>}>
                    <PhotoGallery
                      photos={filteredPhotos}
                      onDelete={handleDelete}
                      onBatchDelete={handleBatchDeleteWithProgress}
                      onSubjectUpdate={handleSubjectUpdate}
                      onTakenAtUpdate={handleTakenAtUpdate}
                      onGpsUpdate={handleGpsUpdate}
                      onRenamePhoto={handleRenamePhoto}
                      onToggleFavorite={handleToggleFavorite}
                      onMovePhoto={handleMovePhoto}
                      onDownloadStateChange={setDownloading}
                      onVoiceStateChange={handleTimelineVoiceStateChange}
                      onBatchMutationChange={handleTimelineBatchMutationChange}
                      batchMutationActive={batchMutationStates.timeline !== null}
                      onShareCreated={handleMomentShareCreated}
                      onThumbnailUpdate={handleThumbnailUpdate}
                      userName={user?.displayName}
                      showImportantMoments={false}
                      reverseOrder={photoSortAsc}
                      sortKey={photoSortKey}
                      gridSize={gridSize}
                      focusPhotoName={timelineFocusPhotoName ?? undefined}
                      focusRequestKey={timelineFocusRequestKey}
                    />
                  </Suspense>
                </>
              )}
            </div>

            {/* ── Moments panel ── mounted on first visit, then kept mounted */}
            {(momentsMounted || activeTab === "moments") && (
            <div style={{ display: activeTab === "moments" ? "" : "none" }}>
              <Suspense fallback={<div className="loading"><div className="loading-spinner" /><span>正在加载照片视图…</span></div>}>
                <PhotoGallery
                  photos={importantPhotos}
                  onDelete={handleDelete}
                  onBatchDelete={handleBatchDeleteWithProgress}
                  onSubjectUpdate={handleSubjectUpdate}
                  onTakenAtUpdate={handleTakenAtUpdate}
                  onGpsUpdate={handleGpsUpdate}
                  onRenamePhoto={handleRenamePhoto}
                  onToggleFavorite={handleToggleFavorite}
                  onMovePhoto={handleMovePhoto}
                  onDownloadStateChange={setDownloading}
                  onVoiceStateChange={handleMomentsVoiceStateChange}
                  onBatchMutationChange={handleMomentsBatchMutationChange}
                  batchMutationActive={batchMutationStates.moments !== null}
                  onShareCreated={handleMomentShareCreated}
                  onThumbnailUpdate={handleThumbnailUpdate}
                  userName={user?.displayName}
                  showMemoryHighlights={false}
                  showImportantMoments={false}
                  momentsMode
                  momentsShareViews={momentsShareViews}
                  onMomentsCountChange={setMomentsDisplayCount}
                  gridSize={gridSize}
                />
              </Suspense>
            </div>
            )}

            {/* ── Folder panel ── mounted on first visit, then kept mounted */}
            {(folderMounted || activeTab === "folder") && (
            <div style={{ display: activeTab === "folder" ? "" : "none" }}>
              <Suspense fallback={null}><FolderView
                key={currentGroupId || "personal"}
                photos={photos}
                onDelete={handleDelete}
                onBatchDelete={handleBatchDeleteWithProgress}
                onSubjectUpdate={handleSubjectUpdate}
                onTakenAtUpdate={handleTakenAtUpdate}
                onRenamePhoto={handleRenamePhoto}
                onToggleFavorite={handleToggleFavorite}
                onUploadToFolder={handleUploadToFolder}
                uploadProgress={uploadProgress}
                onMovePhoto={handleMovePhoto}
                onRenameFolder={handleRenameFolder}
                onDownloadStateChange={setDownloading}
                onVoiceStateChange={handleFolderVoiceStateChange}
                onBatchMutationChange={handleFolderBatchMutationChange}
                batchMutationActive={batchMutationStates.folder !== null}
                onShareCreated={handleMomentShareCreated}
                onThumbnailUpdate={handleThumbnailUpdate}
                userName={user?.displayName}
                currentGroupId={currentGroupId || undefined}
                contextKey={currentGroupId || "personal"}
              /></Suspense>
            </div>
            )}

            {/* ── Map / Capsule / Story: lazy-conditional (heavier bundles, visited less often) */}
            {activeTab === "map" && (
              <Suspense fallback={<div className="loading"><div className="loading-spinner" /><span>加载地图…</span></div>}>
                <MemoryMap
                  photos={photos}
                  groupId={currentGroupId || ""}
                  onViewPhoto={jumpToTimelinePhoto}
                  onGpsUpdate={(name, lat, lon) =>
                    mutatePhotos((prev) => prev.map((p) => p.name === name ? { ...p, gpsLat: lat, gpsLon: lon } : p))
                  }
                />
              </Suspense>
            )}
            {activeTab === "capsule" && user && (
              <Suspense fallback={null}>
                <TimeCapsule photos={photos} userId={user.id} onViewPhoto={jumpToTimelinePhoto} />
              </Suspense>
            )}
            {activeTab === "story" && (
              <Suspense fallback={null}>
                <AutoStory photos={photos} />
              </Suspense>
            )}
          </>
        )}
            </ErrorBoundary>
          </div>

          <WorkspaceSidebar
            activeTab={(activeTab === "map" || activeTab === "capsule" || activeTab === "story" ? "timeline" : activeTab) as "timeline" | "folder" | "moments"}
            isOpen={sidebarOpen}
            filters={filters}
            onFiltersChange={setFilters}
            uploaders={uploaders}
            subjects={subjects}
            totalPhotos={photos.length}
            filteredPhotos={filteredPhotos.length}
            recentUploadsCount={recentUploads.length}
            latestUploadText={latestUploadText}
            missingSubjectCount={missingSubjectCount}
            uncategorizedCount={uncategorizedCount}
            managedShareLinksCount={managedShareLinksCount}
            managedShareViewsTotal={managedShareViewsTotal}
            expiringSoonShareLinksCount={expiringSoonShareLinks.length}
            topSharedPhotoName={topSharedPhotoName}
            homeDiagnostics={homeDiagnostics}
            momentsStats={momentsStats}
            onJumpRecentUploads={jumpToRecentUploads}
            onJumpMissingSubject={jumpToMissingSubjectPhotos}
            onJumpUncategorized={jumpToUncategorizedPhotos}
            onOpenManagedShares={() => openSettingsTab("app", "managed-shares", managedShareLinks[0]?.id)}
            onOpenDiagnostics={() => openSettingsTab("diagnostics", "diagnostics")}
            onClose={() => setSidebarOpen(false)}
            gridSize={gridSize}
            onGridSizeChange={handleGridSizeChange}
          />
        </div>
      </main>

      {showScrollTop && (
        <button
          className="scroll-top-btn"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          title="返回顶部"
          aria-label="返回顶部"
        >顶部</button>
      )}
      {showWhatsNewPopup && <Suspense fallback={null}><WhatsNewPopup /></Suspense>}
    </div>
  );
}

function AuthenticatedApp() {
  return (
    <GroupProvider>
      <AppContent />
    </GroupProvider>
  );
}

export default AuthenticatedApp;
