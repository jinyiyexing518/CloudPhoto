import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { listPhotos, uploadPhoto, deletePhoto, movePhotoToFolder, renameFolderApi, setPhotoFavorite, listManagedShareLinks, Photo, ManagedShareLink } from "./services/photoApi";
import PhotoGallery from "./components/gallery/PhotoGallery";
import FolderView from "./components/gallery/FolderView";
import FilterBar, { FilterState, emptyFilter } from "./components/gallery/FilterBar";
import GroupSwitcher from "./components/groups/GroupSwitcher";
import SettingsDialog from "./components/settings/SettingsDialog";
import InviteAcceptPage from "./components/invites/InviteAcceptPage";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { GroupProvider, useGroup } from "./contexts/GroupContext";
import { ToastProvider, useToast } from "./contexts/ToastContext";
import AuthPage from "./components/auth/AuthPage";
import AddAdminDialog from "./components/auth/AddAdminDialog";

const SUPER_ADMIN = "zhangchi";
const INSTALL_BANNER_DISMISSED_KEY = "cf_install_banner_dismissed";
type ViewTab = "timeline" | "folder" | "moments";
type SettingsEntryTab = "profile" | "security" | "trash" | "diagnostics" | "app";
type SettingsFocusTarget = "overview" | "managed-shares" | "diagnostics";

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
  const [dashboardExpanded, setDashboardExpanded] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsEntryTab>("profile");
  const [settingsFocusTarget, setSettingsFocusTarget] = useState<SettingsFocusTarget>("overview");
  const [settingsFocusItemId, setSettingsFocusItemId] = useState<string | undefined>(undefined);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [installBannerDismissed, setInstallBannerDismissed] = useState<boolean>(() => localStorage.getItem(INSTALL_BANNER_DISMISSED_KEY) === "1");
  const deferredInstallPrompt = useRef<BeforeInstallPromptEvent | null>(null);
  const ua = navigator.userAgent.toLowerCase();
  const isIOS = /iphone|ipad|ipod/.test(ua);
  const isAndroid = /android/.test(ua);

  // Location banner: shown briefly when entering a group or personal space
  const [locationBanner, setLocationBanner] = useState<string | null>(null);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const switchTab = (tab: ViewTab) => {
    if (transferring) {
      showToast("传输进行中，请等待上传/下载完成后再切换页面", "error");
      return;
    }
    setActiveTab(tab);
    localStorage.setItem(tabKey, tab);
  };
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number; folder: string } | null>(null);
  const [downloading, setDownloading] = useState(false);
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
  const transferring = uploadProgress !== null || downloading;

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
      return true;
    });
  }, [photos, filters]);

  const importantPhotos = useMemo(() => {
    const scored = [...photos].map((p) => {
      const ts = new Date(p.createdAt ?? p.lastModified ?? 0).getTime();
      const recencyDays = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
      const score = (p.favorite ? 120 : 0) + (p.subject ? 20 : 0) + Math.max(0, 40 - recencyDays);
      return { p, score };
    });
    return scored.sort((a, b) => b.score - a.score).map((x) => x.p).slice(0, 120);
  }, [photos]);

  const groupLabel = useMemo(() => {
    if (currentGroupId === "") return "个人空间";
    return groups.find((group) => group.id === currentGroupId)?.name ?? "群组空间";
  }, [currentGroupId, groups]);

  const folderCount = useMemo(
    () => new Set(photos.map((photo) => (photo.folder ?? "").trim()).filter(Boolean)).size,
    [photos],
  );

  const favoriteCount = useMemo(
    () => photos.filter((photo) => photo.favorite).length,
    [photos],
  );

  const missingSubjectCount = useMemo(
    () => photos.filter((photo) => !photo.subject?.trim()).length,
    [photos],
  );

  const uncategorizedCount = useMemo(
    () => photos.filter((photo) => !(photo.folder ?? "").trim()).length,
    [photos],
  );

  const subjectCount = useMemo(
    () => photos.filter((photo) => Boolean(photo.subject?.trim())).length,
    [photos],
  );

  const timelineHasActiveFilters = useMemo(
    () => Boolean(filters.name || filters.subject || filters.uploader || filters.dateFrom || filters.dateTo || filters.favoriteOnly),
    [filters],
  );

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

  const recentActivity = useMemo<HomeActivityItem[]>(() => {
    const uploadItems = [...photos]
      .filter((photo) => photo.createdAt || photo.lastModified)
      .sort((a, b) => new Date(b.createdAt ?? b.lastModified ?? 0).getTime() - new Date(a.createdAt ?? a.lastModified ?? 0).getTime())
      .slice(0, 3)
      .map((photo) => ({
        id: `upload:${photo.name}`,
        icon: "📤",
        title: `${photo.originalName || (photo.name.split("/").pop() ?? photo.name).replace(/^\d+-/, "")} 已上传`,
        meta: `${photo.createdBy ?? "未知上传者"} · ${new Date(photo.createdAt ?? photo.lastModified ?? 0).toLocaleString("zh-CN")}`,
        timestamp: new Date(photo.createdAt ?? photo.lastModified ?? 0).getTime(),
        action: () => jumpToTimelinePhoto(photo.name, {
          dateFrom: new Date(new Date(photo.createdAt ?? photo.lastModified ?? 0).getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
          dateTo: new Date(photo.createdAt ?? photo.lastModified ?? 0).toISOString().slice(0, 10),
        }),
      }));

    const shareItems = [...managedShareLinks]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 2)
      .map((item) => ({
        id: `share:${item.id}`,
        icon: "🔗",
        title: `${item.displayName} 已创建分享`,
        meta: `${item.createdByName} · ${new Date(item.createdAt).toLocaleString("zh-CN")}`,
        timestamp: new Date(item.createdAt).getTime(),
        action: () => openSettingsTab("app", "managed-shares", item.id),
      }));

    const syncItem = homeDiagnostics.persistenceUpdatedAt
      ? [{
          id: "sync-status",
          icon: "🩺",
          title: homeDiagnostics.persistenceStatus === "server-synced" ? "浏览同步正常" : "浏览同步状态已更新",
          meta: `${homeDiagnostics.localMomentsCount} 条本地记录 · ${new Date(homeDiagnostics.persistenceUpdatedAt).toLocaleString("zh-CN")}`,
          timestamp: new Date(homeDiagnostics.persistenceUpdatedAt).getTime(),
          action: () => openSettingsTab("diagnostics", "diagnostics"),
        }]
      : [];

    return [...uploadItems, ...shareItems, ...syncItem]
      .filter((item) => Number.isFinite(item.timestamp))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 6);
  }, [homeDiagnostics.localMomentsCount, homeDiagnostics.persistenceStatus, homeDiagnostics.persistenceUpdatedAt, managedShareLinks, photos]);

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

  const fetchPhotos = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(false);
      const data = await listPhotos(currentGroupId);
      setPhotos(data);
    } catch {
      showToast("加载照片失败，请检查网络或服务器状态", "error");
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [currentGroupId, showToast]);

  useEffect(() => { void fetchPhotos(); }, [fetchPhotos]);

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
          acc[key] = (acc[key] ?? 0) + (item.viewCount ?? 0);
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

  const handleUploadToFolder = async (files: FileList, folder: string, subject?: string) => {
    const ALLOWED_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif", "image/bmp", "image/tiff"]);
    const MAX_SIZE_BYTES = 20 * 1024 * 1024;
    const fileArray = Array.from(files);
    const invalidType = fileArray.filter((f) => !ALLOWED_TYPES.has(f.type));
    const oversized = fileArray.filter((f) => ALLOWED_TYPES.has(f.type) && f.size > MAX_SIZE_BYTES);
    if (invalidType.length > 0 || oversized.length > 0) {
      const msgs: string[] = [];
      if (invalidType.length) msgs.push(`非图片文件: ${invalidType.map((f) => f.name).join(", ")}`);
      if (oversized.length) msgs.push(`文件过大(>20MB): ${oversized.map((f) => f.name).join(", ")}`);
      showToast(msgs.join("; "), "error");
    }
    const valid = fileArray.filter((f) => ALLOWED_TYPES.has(f.type) && f.size <= MAX_SIZE_BYTES);
    if (valid.length === 0) return;
    setUploadProgress({ done: 0, total: valid.length, folder });
    const failed: string[] = [];
    for (let i = 0; i < valid.length; i++) {
      try {
        await uploadPhoto(valid[i], user?.displayName || undefined, subject || undefined, folder || undefined, currentGroupId || undefined);
      } catch {
        failed.push(valid[i].name);
      }
      setUploadProgress({ done: i + 1, total: valid.length, folder });
    }
    await fetchPhotos();
    setUploadProgress(null);
    if (failed.length > 0) {
      showToast(`上传失败 (${failed.length}/${valid.length}): ${failed.join(", ")}`, "error");
    } else {
      showToast(`成功上传 ${valid.length} 张照片`, "success");
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
    <div className="app">
      {locationBanner && (
        <div className="location-banner" key={locationBanner}>
          {locationBanner}
        </div>
      )}
      <header className="app-header">
        <h1>Cloud Photo</h1>
        <GroupSwitcher />
        <span className="photo-count">{photos.length} photos</span>
        <div className="user-badge">
          <span className="user-name-btn">
            👤 {user?.displayName}
            {user?.role === "admin" && <span className="role-badge">Admin</span>}
          </span>
          {user?.username === SUPER_ADMIN && (
            <button className="add-admin-btn" onClick={() => setShowAddAdmin(true)} title="添加 Admin">
              + Admin
            </button>
          )}
          <button className="logout-btn" onClick={logout} title="退出登录">退出</button>
          <button className="settings-btn" onClick={() => setShowSettings(true)} title="设置">⚙️</button>
        </div>
      </header>

      {showAddAdmin && <AddAdminDialog onClose={() => setShowAddAdmin(false)} />}
      {showSettings && (
        <SettingsDialog
          onClose={() => setShowSettings(false)}
          onPhotosRestored={fetchPhotos}
          canInstall={canInstall}
          isStandalone={isStandalone}
          initialTab={settingsInitialTab}
          initialFocusTarget={settingsFocusTarget}
          initialFocusItemId={settingsFocusItemId}
          onInstallApp={() => void handleInstallApp()}
          onOpenInstallGuide={() => setShowInstallGuide(true)}
        />
      )}
      {inviteToken && <InviteAcceptPage token={inviteToken} onDone={dismissInvite} />}
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
        <div className="view-tabs">
          <button
            className={`view-tab${activeTab === "timeline" ? " active" : ""}`}
            onClick={() => switchTab("timeline")}
          >
            <span>🕐 时间线</span>
            <span className="view-tab-count">{filteredPhotos.length}</span>
          </button>
          <button
            className={`view-tab${activeTab === "folder" ? " active" : ""}`}
            onClick={() => switchTab("folder")}
          >
            <span>📁 文件夹</span>
            <span className="view-tab-count">{folderCount}</span>
          </button>
          <button
            className={`view-tab${activeTab === "moments" ? " active" : ""}`}
            onClick={() => switchTab("moments")}
          >
            <span>⭐ 重要片段</span>
            <span className="view-tab-count">{importantPhotos.length}</span>
          </button>
        </div>

        <section className="focus-toolbar">
          <div className="focus-toolbar-main">
            <div className="focus-toolbar-title-row">
              <h2 className="focus-toolbar-title">{groupLabel}</h2>
              <span className={`focus-toolbar-mode${isStandalone ? " focus-toolbar-mode--app" : ""}`}>
                {isStandalone ? "App 模式" : "网页模式"}
              </span>
            </div>
            <div className="focus-toolbar-badges">
              <span className="focus-toolbar-badge">{photos.length} 张照片</span>
              <span className="focus-toolbar-badge">{folderCount} 个文件夹</span>
              <span className="focus-toolbar-badge">{favoriteCount} 张收藏</span>
              <span className="focus-toolbar-badge">{subjectCount} 个主题</span>
            </div>
          </div>
          <div className="focus-toolbar-actions">
            {activeTab !== "folder" && (
              <button className="focus-toolbar-btn" onClick={() => switchTab("folder")}>
                去整理照片
              </button>
            )}
            <button className="focus-toolbar-btn focus-toolbar-btn--secondary" onClick={jumpToRecentUploads}>
              最近上传
            </button>
            <button className="focus-toolbar-btn focus-toolbar-btn--ghost" onClick={() => setDashboardExpanded((value) => !value)}>
              {dashboardExpanded ? "收起洞察" : "展开洞察"}
            </button>
          </div>
        </section>

        {dashboardExpanded && (
          <section className="dashboard-drawer">
        <section className="insights-hub">
          <article className="insights-hub-card insights-hub-card--recent">
            <div className="insights-hub-kicker">最近上传</div>
            <div className="insights-hub-value">近 7 天新增 {recentUploads.length} 张</div>
            <div className="insights-hub-meta">最近一次上传：{latestUploadText}</div>
            <button className="insights-hub-btn" onClick={jumpToRecentUploads}>查看最近上传</button>
          </article>

          <article className="insights-hub-card insights-hub-card--share">
            <div className="insights-hub-kicker">分享表现</div>
            <div className="insights-hub-value">有效链接 {managedShareLinksCount} 条</div>
            <div className="insights-hub-meta">累计分享浏览 {managedShareViewsTotal} 次{topSharedPhotoName ? ` · 最热：${topSharedPhotoName}` : ""}</div>
            <button className="insights-hub-btn" onClick={() => openSettingsTab("app", "managed-shares", managedShareLinks[0]?.id)}>
              管理分享链接
            </button>
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
            <button className="insights-hub-btn" onClick={() => openSettingsTab("diagnostics", "diagnostics")}>打开诊断页</button>
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
              <button className="pm-action-card" onClick={jumpToMissingSubjectPhotos}>
                <strong>{missingSubjectCount}</strong>
                <span>张照片缺少主题</span>
                <em>去时间线集中补主题</em>
              </button>
              <button className="pm-action-card" onClick={jumpToUncategorizedPhotos}>
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
              <span className="pm-panel-badge">{expiringSoonShareLinks.length} 条即将到期</span>
            </div>
            <div className="pm-watchlist-copy">
              <div className="pm-watchlist-line">48 小时内到期：{expiringSoonShareLinks.length} 条</div>
              <div className="pm-watchlist-line">当前最热分享：{topSharedPhotoName ?? "暂无"}</div>
              <div className="pm-watchlist-line">建议：及时延长高价值链接，避免外部访问失效。</div>
            </div>
            <button className="pm-panel-btn" onClick={() => openSettingsTab("app", "managed-shares", expiringSoonShareLinks[0]?.id)}>
              进入分享管理
            </button>
          </article>
        </section>
          </section>
        )}

        {/* Timeline hint */}
        {activeTab === "timeline" && (
          <div className="timeline-upload-hint">
            📁 请切换到「<button className="hint-tab-link" onClick={() => switchTab("folder")}>文件夹</button>」视图来添加照片
          </div>
        )}

        {activeTab === "moments" && (
          <div className="timeline-upload-hint">
            ⭐ 这里展示按互动热度排序的重点照片（浏览记录跨设备持久化）
          </div>
        )}

        {activeTab === "moments" && (
          <div className="moments-stats-bar">
            <span>重点照片：{momentsStats.total}</span>
            <span>已收藏：{momentsStats.favoriteCount}</span>
            <span>有主题：{momentsStats.withSubjectCount}</span>
            <span>近 30 天：{momentsStats.recentCount}</span>
            <span>筛选范围：{momentsStats.filteredTotal}</span>
          </div>
        )}

        {activeTab === "timeline" && (
          <FilterBar
            filters={filters}
            onChange={setFilters}
            uploaders={uploaders}
            subjects={subjects}
            total={photos.length}
            filtered={filteredPhotos.length}
          />
        )}

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
        ) : activeTab === "timeline" && photos.length > 0 && filteredPhotos.length === 0 ? (
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
          <PhotoGallery
            photos={filteredPhotos}
            onDelete={handleDelete}
            onSubjectUpdate={handleSubjectUpdate}
            onRenamePhoto={handleRenamePhoto}
            onToggleFavorite={handleToggleFavorite}
            onMovePhoto={handleMovePhoto}
            onDownloadStateChange={setDownloading}
            userName={user?.displayName}
            showImportantMoments={false}
            focusPhotoName={timelineFocusPhotoName ?? undefined}
            focusRequestKey={timelineFocusRequestKey}
          />
        ) : activeTab === "moments" ? (
          <PhotoGallery
            photos={importantPhotos}
            onDelete={handleDelete}
            onSubjectUpdate={handleSubjectUpdate}
            onRenamePhoto={handleRenamePhoto}
            onToggleFavorite={handleToggleFavorite}
            onMovePhoto={handleMovePhoto}
            onDownloadStateChange={setDownloading}
            userName={user?.displayName}
            showMemoryHighlights={false}
            showImportantMoments={false}
            momentsMode
            momentsShareViews={momentsShareViews}
          />
        ) : (
          <FolderView
            key={currentGroupId || "personal"}
            photos={photos}
            onDelete={handleDelete}
            onSubjectUpdate={handleSubjectUpdate}
            onRenamePhoto={handleRenamePhoto}
            onToggleFavorite={handleToggleFavorite}
            onUploadToFolder={handleUploadToFolder}
            uploadProgress={uploadProgress}
            onMovePhoto={handleMovePhoto}
            onRenameFolder={handleRenameFolder}
            onDownloadStateChange={setDownloading}
            userName={user?.displayName}
            currentGroupId={currentGroupId || undefined}
            contextKey={currentGroupId || "personal"}
          />
        )}
      </main>
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
