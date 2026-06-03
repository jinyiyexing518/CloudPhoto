import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from "react";
import { listPhotos, uploadPhotoWithProgress, deletePhoto, movePhotoToFolder, renameFolderApi, setPhotoFavorite, listManagedShareLinks, Photo, ManagedShareLink } from "./services/photoApi";
import PhotoGallery from "./components/gallery/PhotoGallery";
const FolderView = lazy(() => import("./components/gallery/FolderView"));
import { FilterState, emptyFilter } from "./components/gallery/FilterBar";
import GroupSwitcher from "./components/groups/GroupSwitcher";
import WorkspaceFab from "./components/home/floating/WorkspaceFab";
import WorkspaceSidebar from "./components/home/WorkspaceSidebar";
const SettingsDialog = lazy(() => import("./components/settings/SettingsDialog"));
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { GroupProvider, useGroup } from "./contexts/GroupContext";
import { ToastProvider, useToast } from "./contexts/ToastContext";
import AuthPage from "./components/auth/AuthPage";
import WhatsNewPopup from "./components/whats-new/WhatsNewPopup";
import OnThisDayCard from "./components/on-this-day/OnThisDayCard";
import ErrorBoundary from "./components/shared/ErrorBoundary";
const MemoryMap = lazy(() => import("./components/memory-map/MemoryMap"));
const TimeCapsule = lazy(() => import("./components/time-capsule/TimeCapsule"));
const AutoStory = lazy(() => import("./components/auto-story/AutoStory"));
const AddAdminDialog = lazy(() => import("./components/auth/AddAdminDialog"));
const InviteAcceptPage = lazy(() => import("./components/invites/InviteAcceptPage"));

const SUPER_ADMIN = "zhangchi";
const INSTALL_BANNER_DISMISSED_KEY = "cf_install_banner_dismissed";

// Computed once at module load — avoids recalculating on every render
const _ua = navigator.userAgent.toLowerCase();
const IS_IOS = /iphone|ipad|ipod/.test(_ua);
const IS_ANDROID = /android/.test(_ua);
type ViewTab = "timeline" | "folder" | "moments" | "map" | "capsule" | "story";
type SettingsEntryTab = "profile" | "security" | "trash" | "diagnostics" | "app";
type SettingsFocusTarget = "overview" | "managed-shares" | "diagnostics";

interface HomeDiagnosticsSnapshot {
  localMomentsCount: number;
  persistenceStatus: "unknown" | "local-only" | "server-synced" | "server-unavailable";
  persistenceUpdatedAt?: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function AppContent() {
  const { user, logout } = useAuth();
  const { currentGroupId, groups, groupsLoaded } = useGroup();
  const showToast = useToast();
  const [showAddAdmin, setShowAddAdmin] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsEntryTab>("profile");
  const [settingsFocusTarget, setSettingsFocusTarget] = useState<SettingsFocusTarget>("overview");
  const [settingsFocusItemId, setSettingsFocusItemId] = useState<string | undefined>(undefined);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [installBannerDismissed, setInstallBannerDismissed] = useState<boolean>(() => localStorage.getItem(INSTALL_BANNER_DISMISSED_KEY) === "1");
  const deferredInstallPrompt = useRef<BeforeInstallPromptEvent | null>(null);
  const isIOS = IS_IOS;
  const isAndroid = IS_ANDROID;

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
    const standalone = window.matchMedia("(display-mode: standalone)").matches
      || ((navigator as Navigator & { standalone?: boolean }).standalone === true);
    setIsStandalone(standalone);

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      deferredInstallPrompt.current = event as BeforeInstallPromptEvent;
      setCanInstall(true);
    };
    const onAppInstalled = () => {
      deferredInstallPrompt.current = null;
      setCanInstall(false);
      setIsStandalone(true);
      showToast("Cloud Photo 已安装到设备", "success");
    };
    const onUpdateReady = () => {
      setUpdateReady(true);
    };
    const onOfflineReady = () => showToast("已启用离线基础访问", "success");

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt as EventListener);
    window.addEventListener("appinstalled", onAppInstalled);
    window.addEventListener("cloudphoto-pwa-update-ready", onUpdateReady as EventListener);
    window.addEventListener("cloudphoto-pwa-offline-ready", onOfflineReady as EventListener);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt as EventListener);
      window.removeEventListener("appinstalled", onAppInstalled);
      window.removeEventListener("cloudphoto-pwa-update-ready", onUpdateReady as EventListener);
      window.removeEventListener("cloudphoto-pwa-offline-ready", onOfflineReady as EventListener);
    };
  }, [showToast]);

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
  const [loadError, setLoadError] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ bytesLoaded: number; bytesTotal: number; filesDone: number; filesTotal: number; folder: string; currentFile?: string } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [filters, setFilters] = useState<FilterState>(emptyFilter);
  const [momentsShareViews, setMomentsShareViews] = useState<Record<string, number>>({});
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
  const lastFocusRefreshRef = useRef<number>(0);
  const focusClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const [uploadTotalSize, setUploadTotalSize] = useState<string | null>(null);
  const [uploadPaused, setUploadPaused] = useState(false);
  const [uploadSpeed, setUploadSpeed] = useState("");
  const pausedRef = useRef(false);
  const resumeCallbackRef = useRef<(() => void) | null>(null);
  const speedRef = useRef<{ ts: number; bytes: number; ema: number }>({ ts: 0, bytes: 0, ema: 0 });
  const [weeklyCardExpanded, setWeeklyCardExpanded] = useState(false);
  const [photoSortAsc, setPhotoSortAsc] = useState(false);
  const transferring = uploadProgress !== null || downloading || deleteProgress !== null;

  const switchTab = (tab: ViewTab) => {
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
      const date = p.createdAt ?? p.lastModified;

      if (filters.name && !name.includes(filters.name.toLowerCase())) return false;
      if (filters.subject && !(p.subject ?? "").toLowerCase().includes(filters.subject.toLowerCase())) return false;
      if (filters.uploader && p.createdBy !== filters.uploader) return false;
      if (filters.dateFrom && date && date.slice(0, 10) < filters.dateFrom) return false;
      if (filters.dateTo && date && date.slice(0, 10) > filters.dateTo) return false;
      if (filters.favoriteOnly && !p.favorite) return false;
      if (filters.missingSubjectOnly && Boolean(p.subject?.trim())) return false;
      if (filters.uncategorizedOnly && Boolean((p.folder ?? "").trim())) return false;
      if (filters.folder && (p.folder ?? "").trim() !== filters.folder) return false;
      return true;
    });
  }, [photos, filters]);

  const todayUploads = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return photos.filter((p) => (p.createdAt ?? p.lastModified ?? "").slice(0, 10) === today);
  }, [photos]);

  const greetingText = useMemo(() => {
    const h = new Date().getHours();
    if (h < 6) return "夜深了";
    if (h < 12) return "早上好";
    if (h < 18) return "下午好";
    return "晚上好";
  }, []);

  const weeklyStats = useMemo(() => {
    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const thisWeek = photos.filter((p) => {
      const ts = new Date(p.createdAt ?? p.lastModified ?? 0).getTime();
      return Number.isFinite(ts) && now - ts <= weekMs;
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
    const scored = [...photos].map((p) => {
      const ts = new Date(p.createdAt ?? p.lastModified ?? 0).getTime();
      const recencyDays = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
      const score = (p.favorite ? 120 : 0) + (p.subject ? 20 : 0) + Math.max(0, 40 - recencyDays);
      return { p, score };
    });
    return scored.sort((a, b) => b.score - a.score).map((x) => x.p).slice(0, 120);
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

  const missingSubjectCount = useMemo(
    () => photos.filter((photo) => !photo.subject?.trim()).length,
    [photos],
  );

  const uncategorizedCount = useMemo(
    () => photos.filter((photo) => !(photo.folder ?? "").trim()).length,
    [photos],
  );

  const timelineHasActiveFilters = useMemo(
    () => Boolean(filters.name || filters.subject || filters.uploader || filters.dateFrom || filters.dateTo || filters.favoriteOnly || filters.missingSubjectOnly || filters.uncategorizedOnly),
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
    return count;
  }, [filters]);

  const activeDateChip = useMemo(() => {
    const now = new Date().toISOString().slice(0, 10);
    const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const month = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (filters.dateFrom === now && filters.dateTo === now) return "today";
    if (filters.dateFrom === week && filters.dateTo === now) return "week";
    if (filters.dateFrom === month && filters.dateTo === now) return "month";
    return null;
  }, [filters.dateFrom, filters.dateTo]);

  const applyQuickDateFilter = useCallback((period: "today" | "week" | "month" | null) => {
    const now = new Date().toISOString().slice(0, 10);
    if (period === "today") {
      setFilters((f) => ({ ...f, dateFrom: now, dateTo: now }));
    } else if (period === "week") {
      const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      setFilters((f) => ({ ...f, dateFrom: from, dateTo: now }));
    } else if (period === "month") {
      const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      setFilters((f) => ({ ...f, dateFrom: from, dateTo: now }));
    } else {
      setFilters((f) => ({ ...f, dateFrom: "", dateTo: "" }));
    }
  }, []);

  const recentUploads = useMemo(() => {
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    return photos.filter((photo) => {
      const ts = new Date(photo.createdAt ?? photo.lastModified ?? 0).getTime();
      return Number.isFinite(ts) && now - ts <= sevenDaysMs;
    });
  }, [photos]);

  const latestUploadText = useMemo(() => {
    const latestPhoto = [...photos].sort((a, b) => {
      const at = new Date(a.createdAt ?? a.lastModified ?? 0).getTime();
      const bt = new Date(b.createdAt ?? b.lastModified ?? 0).getTime();
      return bt - at;
    })[0];
    if (!latestPhoto) return "暂无上传记录";
    const ts = latestPhoto.createdAt ?? latestPhoto.lastModified;
    return ts ? new Date(ts).toLocaleString("zh-CN") : "暂无上传时间";
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
  const fetchPhotos = useCallback(async () => {
    // Cancel any in-flight previous request
    fetchAbortRef.current?.abort();
    fetchAbortRef.current = new AbortController();
    try {
      setLoading(true);
      setLoadError(false);
      const data = await listPhotos(currentGroupId);
      setPhotos(data);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      showToast("加载照片失败，请检查网络或服务器状态", "error");
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [currentGroupId, showToast]);

  useEffect(() => { void fetchPhotos(); }, [fetchPhotos]);

  // Reset all active filters when the user switches groups (B5 / F9)
  useEffect(() => { setFilters(emptyFilter); }, [currentGroupId]);

  // Auto-dismiss install banner after 10 s if the user hasn’t acted (F6)
  const bannerAutoDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isStandalone || installBannerDismissed) return;
    bannerAutoDismissRef.current = setTimeout(() => {
      setInstallBannerDismissed(true);
    }, 10_000);
    return () => {
      if (bannerAutoDismissRef.current) clearTimeout(bannerAutoDismissRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Auto-refresh when window regains focus (max once per 60 s)
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusRefreshRef.current > 60_000) {
        lastFocusRefreshRef.current = now;
        void fetchPhotos();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchPhotos]);

  // Keyboard shortcuts: R=refresh, ?=help, 1/2/3=tabs, S=sidebar, Backspace=clear, Esc=close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as Element)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.key === "r" || e.key === "R") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
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
  }, [fetchPhotos, activeFiltersCount, showToast, transferring]);

  // Global drag-over: desktop-only (only attach on non-touch devices)
  useEffect(() => {
    // Skip on touch-primary devices to avoid interfering with touch scroll
    if (window.matchMedia("(hover: none)").matches) return;
    let enterCount = 0;
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      enterCount++;
      setIsDragOver(true);
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
        setActiveTab("folder");
        localStorage.setItem(tabKey, "folder");
        showToast("已切换到文件夹视图，选择文件夹后上传", "success");
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
  }, [tabKey, showToast]);

  const handleUploadToFolder = async (files: FileList, folder: string, subject?: string) => {
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
      // ── Pause gate: wait here until resumed ──────────────────────────────
      if (pausedRef.current) {
        await new Promise<void>(resolve => { resumeCallbackRef.current = resolve; });
      }

      setUploadProgress({ bytesLoaded: completedBytes, bytesTotal, filesDone: i, filesTotal: valid.length, folder, currentFile: valid[i].name });
      const fileBase = completedBytes;
      try {
        // Extract GPS from EXIF if available (images only)
        let gpsLat: string | undefined;
        let gpsLon: string | undefined;
        if (valid[i].type.startsWith("image/")) {
          try {
            const exifrLib = await import("exifr");
            const gps = await exifrLib.gps(valid[i]);
            if (gps?.latitude != null && gps?.longitude != null) {
              gpsLat = String(gps.latitude);
              gpsLon = String(gps.longitude);
            }
          } catch { /* EXIF extraction is best-effort */ }
        }

        // ── Upload with retry (up to 3 attempts, auto-waits for network) ──
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const controller = new AbortController();
            await uploadPhotoWithProgress(
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
                  setUploadSpeed(formatSpeed(speedRef.current.ema));
                }
                setUploadProgress({ bytesLoaded: fileBase + loaded, bytesTotal, filesDone: i, filesTotal: valid.length, folder, currentFile: valid[i].name });
              },
              user?.displayName || undefined,
              subject || undefined,
              folder || undefined,
              currentGroupId || undefined,
              gpsLat,
              gpsLon,
              controller.signal,
            );
            lastErr = undefined;
            break; // success — exit retry loop
          } catch (e) {
            lastErr = e;
            if (attempt < 2) {
              if (!navigator.onLine) {
                // Wait until network comes back before retrying
                setUploadSpeed("等待网络…");
                await new Promise<void>(resolve => {
                  const h = () => { window.removeEventListener("online", h); resolve(); };
                  window.addEventListener("online", h);
                });
                setUploadSpeed("");
              } else {
                // Brief back-off between retries
                await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
              }
            }
          }
        }
        if (lastErr) throw lastErr;

        completedBytes += valid[i].size;
      } catch {
        failed.push(valid[i].name);
        completedBytes += valid[i].size;
      }
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
  };

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
      setPhotos((prev) => prev.filter((p) => p.name !== name));
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
        setPhotos((prev) => prev.filter((p) => p.name !== names[i]));
      } catch { failed++; }
      setDeleteProgress({ done: i + 1, total: names.length, label: "删除中" });
    }
    setDeleteProgress(null);
    if (failed > 0) showToast(`${failed} 张删除失败`, "error");
    else showToast(`已删除 ${names.length} 张照片`, "success");
  };

  const handleSubjectUpdate = (name: string, subject: string) => {
    setPhotos((prev) =>
      prev.map((p) => (p.name === name ? { ...p, subject } : p))
    );
  };

  const handleRenamePhoto = (name: string, newOriginalName: string) => {
    setPhotos((prev) =>
      prev.map((p) => (p.name === name ? { ...p, originalName: newOriginalName } : p))
    );
  };

  const handleMomentShareCreated = (photoName: string) => {
    setMomentsShareViews((prev) => ({
      ...prev,
      [photoName]: (prev[photoName] ?? 0) + 1,
    }));
  };

  const handleToggleFavorite = async (name: string, favorite: boolean): Promise<boolean> => {
    setPhotos((prev) => prev.map((p) => (p.name === name ? { ...p, favorite } : p)));
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
    setPhotos((prev) => prev.map((p) => p.name === name ? { ...p, folder: toFolder } : p));
    try {
      const { newName } = await movePhotoToFolder(name, toFolder, user?.displayName || undefined);
      setPhotos((prev) => prev.map((p) => p.name === name ? { ...p, name: newName, folder: toFolder } : p));
      return true;
    } catch {
      showToast("移动照片失败", "error");
      await fetchPhotos();
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
    const promptEvent = deferredInstallPrompt.current;
    if (!promptEvent) return;
    await promptEvent.prompt();
    const result = await promptEvent.userChoice;
    if (result.outcome === "accepted") {
      showToast("正在安装 Cloud Photo", "success");
    }
  };

  const handleRefreshToUpdate = async () => {
    const updateSW = (window as Window & { __CF_UPDATE_SW__?: (reloadPage?: boolean) => Promise<void> }).__CF_UPDATE_SW__;
    if (!updateSW) {
      window.location.reload();
      return;
    }
    await updateSW(true);
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
    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const targetPhoto = [...recentUploads].sort((a, b) => new Date(b.createdAt ?? b.lastModified ?? 0).getTime() - new Date(a.createdAt ?? a.lastModified ?? 0).getTime())[0];
    if (!targetPhoto) {
      switchTab("timeline");
      return;
    }
    jumpToTimelinePhoto(targetPhoto.name, {
      dateFrom: sevenDaysAgo.toISOString().slice(0, 10),
      dateTo: today.toISOString().slice(0, 10),
    });
  };

  const jumpToMissingSubjectPhotos = () => {
    const targetPhoto = [...photos]
      .filter((photo) => !photo.subject?.trim())
      .sort((a, b) => new Date(b.createdAt ?? b.lastModified ?? 0).getTime() - new Date(a.createdAt ?? a.lastModified ?? 0).getTime())[0];
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
      .sort((a, b) => new Date(b.createdAt ?? b.lastModified ?? 0).getTime() - new Date(a.createdAt ?? a.lastModified ?? 0).getTime())[0];
    if (!targetPhoto) {
      switchTab("timeline");
      return;
    }
    jumpToTimelinePhoto(targetPhoto.name, {
      uncategorizedOnly: true,
    });
  };

  const installGuideText = useMemo(() => {
    if (isIOS) {
      return [
        "使用 Safari 打开本网站",
        "点击底部分享按钮",
        "选择“添加到主屏幕”",
        "返回桌面后从图标启动",
      ];
    }
    if (isAndroid) {
      return [
        "使用 Chrome/Edge 打开本网站",
        "点击地址栏安装图标，或菜单里的“安装应用”",
        "安装后可从桌面图标启动",
      ];
    }
    return [
      "使用 Chrome 或 Edge 打开本网站",
      "点击地址栏安装图标，或菜单里的“安装应用”",
      "安装后可在桌面/开始菜单启动",
    ];
  }, [isAndroid, isIOS]);

  const installBannerText = useMemo(() => {
    if (isIOS) return "可安装为 App：在 Safari 中点“分享 -> 添加到主屏幕”。";
    if (canInstall) return "可安装为 App：点击“立即安装”后，可从桌面图标直接打开。";
    return "可安装为 App：打开安装指引，按设备步骤安装到桌面/主屏幕。";
  }, [canInstall, isIOS]);

  return (
    <div className={`app${headerHidden ? " header-hidden" : ""}`}>
      {/* Reading progress bar – width/opacity driven by direct DOM ref, no setState */}
      <div ref={progressBarRef} className="scroll-progress-bar" style={{ width: "0%", opacity: 0 }} />

      {/* Global drag-drop overlay */}
      {isDragOver && (
        <div className="drag-overlay">
          <div className="drag-overlay-content">
            <div className="drag-overlay-icon">📂</div>
            <p className="drag-overlay-title">松开后跳转到文件夹视图上传</p>
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
              <button className="dialog-close-btn" onClick={() => setShowShortcutsHelp(false)}>✕</button>
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
        <GroupSwitcher />
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
          initialTab={settingsInitialTab}
          initialFocusTarget={settingsFocusTarget}
          initialFocusItemId={settingsFocusItemId}
          onInstallApp={() => void handleInstallApp()}
          onOpenInstallGuide={() => setShowInstallGuide(true)}
        /></Suspense>
      )}
      {inviteToken && <Suspense fallback={null}><InviteAcceptPage token={inviteToken} onDone={dismissInvite} /></Suspense>}
      {showInstallGuide && (
        <div className="dialog-overlay" onClick={() => setShowInstallGuide(false)}>
          <div className="add-admin-dialog install-guide-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="add-admin-header">
              <span>安装使用指引</span>
              <button className="dialog-close-btn" onClick={() => setShowInstallGuide(false)}>✕</button>
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
                    className="transfer-banner-pause"
                    onClick={handleToggleUploadPause}
                    title={uploadPaused ? "继续上传" : "暂停上传（当前文件传完后暂停）"}
                  >
                    {/* \uFE0E = variation-selector-15: force text (not emoji) rendering */}
                    {uploadPaused ? "▶︎" : "⏸︎"}
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
            ) : (
              <div className="transfer-banner-row">
                <span className="transfer-banner-icon">⬇️</span>
                <span className="transfer-banner-text">下载中，请勿关闭页面</span>
              </div>
            )}
          </div>
        )}

        {updateReady && (
          <div className="pwa-update-banner">
            <span>检测到新版本，点击即可更新。</span>
            <div className="pwa-install-actions">
              <button onClick={() => void handleRefreshToUpdate()}>立即更新</button>
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
            <span className="view-tab-count">{importantPhotos.length}</span>
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
              <button
                className={`quick-chip${activeDateChip === "today" ? " active" : ""}`}
                onClick={() => applyQuickDateFilter(activeDateChip === "today" ? null : "today")}
              >今日</button>
              <button
                className={`quick-chip${activeDateChip === "week" ? " active" : ""}`}
                onClick={() => applyQuickDateFilter(activeDateChip === "week" ? null : "week")}
              >本周</button>
              <button
                className={`quick-chip${activeDateChip === "month" ? " active" : ""}`}
                onClick={() => applyQuickDateFilter(activeDateChip === "month" ? null : "month")}
              >本月</button>
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

            <ErrorBoundary key={activeTab} label={activeTab}>
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
        ) : activeTab === "timeline" && filteredPhotos.length === 0 ? (
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
            ) : activeTab === "timeline" ? (
              <>
                {todayUploads.length > 0 && activeTab === "timeline" && !filters.dateFrom && (
                  <div className="today-uploads-notice">
                    <span>📸 今天上传了 <strong>{todayUploads.length}</strong> 张</span>
                    <button
                      className="today-uploads-jump"
                      onClick={() => applyQuickDateFilter(activeDateChip === "today" ? null : "today")}
                    >{activeDateChip === "today" ? "取消筛选" : "仅查看今日"}</button>
                  </div>
                )}
                <OnThisDayCard photos={photos} onJumpToPhoto={jumpToTimelinePhoto} />
              <PhotoGallery
                photos={filteredPhotos}
                onDelete={handleDelete}
                onBatchDelete={handleBatchDeleteWithProgress}
                onSubjectUpdate={handleSubjectUpdate}
                onRenamePhoto={handleRenamePhoto}
                onToggleFavorite={handleToggleFavorite}
                onMovePhoto={handleMovePhoto}
                onDownloadStateChange={setDownloading}
                onShareCreated={handleMomentShareCreated}
                userName={user?.displayName}
                showImportantMoments={false}
                reverseOrder={photoSortAsc}
                focusPhotoName={timelineFocusPhotoName ?? undefined}
                focusRequestKey={timelineFocusRequestKey}
              />
              </>
            ) : activeTab === "moments" ? (
              <PhotoGallery
                photos={importantPhotos}
                onDelete={handleDelete}
                onBatchDelete={handleBatchDeleteWithProgress}
                onSubjectUpdate={handleSubjectUpdate}
                onRenamePhoto={handleRenamePhoto}
                onToggleFavorite={handleToggleFavorite}
                onMovePhoto={handleMovePhoto}
                onDownloadStateChange={setDownloading}
                onShareCreated={handleMomentShareCreated}
                userName={user?.displayName}
                showMemoryHighlights={false}
                showImportantMoments={false}
                momentsMode
                momentsShareViews={momentsShareViews}
              />
            ) : activeTab === "folder" ? (
              <Suspense fallback={null}><FolderView
                key={currentGroupId || "personal"}
                photos={photos}
                onDelete={handleDelete}
                onBatchDelete={handleBatchDeleteWithProgress}
                onSubjectUpdate={handleSubjectUpdate}
                onRenamePhoto={handleRenamePhoto}
                onToggleFavorite={handleToggleFavorite}
                onUploadToFolder={handleUploadToFolder}
                uploadProgress={uploadProgress}
                onMovePhoto={handleMovePhoto}
                onRenameFolder={handleRenameFolder}
                onDownloadStateChange={setDownloading}
                onShareCreated={handleMomentShareCreated}
                userName={user?.displayName}
                currentGroupId={currentGroupId || undefined}
                contextKey={currentGroupId || "personal"}
              /></Suspense>
            ) : null}
            {activeTab === "map" && (
              <Suspense fallback={<div className="loading"><div className="loading-spinner" /><span>加载地图…</span></div>}>
                <MemoryMap
                  photos={photos}
                  groupId={currentGroupId || ""}
                  onViewPhoto={jumpToTimelinePhoto}
                  onGpsUpdate={(name, lat, lon) =>
                    setPhotos((prev) => prev.map((p) => p.name === name ? { ...p, gpsLat: lat, gpsLon: lon } : p))
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
      <WhatsNewPopup />
    </div>
  );
}

function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="app-splash">
        <div className="app-splash-icon">📷</div>
        <div className="app-splash-title">Cloud Photo</div>
        <div className="app-splash-dots">
          <span /><span /><span />
        </div>
      </div>
    );
  }

  return user ? <AppContent /> : <AuthPage />;
}

function AppWithProvider() {
  return (
    <ToastProvider>
      <AuthProvider>
        <GroupProvider>
          <App />
        </GroupProvider>
      </AuthProvider>
    </ToastProvider>
  );
}

export default AppWithProvider;
