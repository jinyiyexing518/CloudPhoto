import {
  useState,
  useMemo,
  useCallback,
  useEffect,
  FormEvent,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../../contexts/AuthContext";
import { useGroup } from "../../contexts/GroupContext";
import {
  changePasswordApi,
  listManagedShareLinks,
  updateManagedShareLink,
  ManagedShareLink,
  backfillPhotoMetadata,
  backfillThumbnails,
} from "../../services/photoApi";
import {
  captureRecentShareLinksContext,
  clearRecentShareLinks,
  isRecentShareLinksContextCurrent,
  listRecentShareLinks,
  removeRecentShareLink,
  type RecentShareLinksContext,
} from "../../services/share/shareLinksStore";
import { registerPrivateLocalDataReset } from "../../services/privateLocalDataLifecycle";
import { copyText } from "../../services/share/clipboard";
import { useToast } from "../../contexts/ToastContext";
import TrashView from "../gallery/TrashView";
import type { PwaInstallOutcome } from "../../pwa/installPrompt";
import { useModalFocusBoundary } from "../shared/useModalFocusBoundary";
import { getSettingsCloseGuardMessage } from "./settingsCloseGuard";
import { formatPhotoDateTimeSeconds } from "../../utils/dateFormat";
import {
  beginMaintenanceTask,
  createMaintenanceTask,
  finishMaintenanceTask,
  getMaintenanceBannerText,
  getMaintenanceTaskLabel,
  isMaintenanceTaskActive,
  maintenanceWorkspaceMatches,
  reduceMaintenanceTaskEvent,
  type MaintenanceTaskEvent,
  type MaintenanceTaskGate,
  type MaintenanceTaskKind,
  type MaintenanceTaskState,
} from "../../transfer/maintenanceTaskState";
import {
  isTrashMutationActive,
  reduceTrashMutationEvent,
  type TrashMutationEvent,
  type TrashMutationState,
} from "../../transfer/trashMutationState";
import {
  readPrivateMomentInsights,
  readPrivateMomentsDiagnostics,
} from "../../services/privateMomentsStore";

type SettingsTab = "profile" | "security" | "trash" | "diagnostics";
type SettingsEntryTab = SettingsTab | "app";
type SettingsFocusTarget = "overview" | "managed-shares" | "diagnostics";

interface DiagnosticsSnapshot {
  serviceWorkerCount: number;
  localMomentsCount: number;
  localMomentsLastViewedAt?: string;
  persistenceStatus: string;
  persistenceMessage?: string;
  persistenceUpdatedAt?: string;
}

interface Props {
  onClose: () => void;
  onPhotosRestored?: () => void;
  canInstall?: boolean;
  isStandalone?: boolean;
  installOutcome?: PwaInstallOutcome;
  initialTab?: SettingsEntryTab;
  initialFocusTarget?: SettingsFocusTarget;
  initialFocusItemId?: string;
  onInstallApp?: (trigger: HTMLElement) => void;
  restoreFocusTo?: HTMLElement | null;
  onMaintenanceStateChange?: (event: MaintenanceTaskEvent) => void;
  onTrashMutationStateChange?: (event: TrashMutationEvent) => void;
}

export default function SettingsDialog({
  onClose,
  onPhotosRestored,
  canInstall = false,
  isStandalone = false,
  installOutcome = null,
  initialTab = "profile",
  initialFocusTarget = "overview",
  initialFocusItemId,
  onInstallApp,
  restoreFocusTo,
  onMaintenanceStateChange,
  onTrashMutationStateChange,
}: Props) {
  const appVersion = __APP_VERSION__;
  const appBuildTime = new Date(__APP_BUILD_TIME__);
  const appBuildTimeText = Number.isNaN(appBuildTime.getTime())
    ? __APP_BUILD_TIME__
    : formatPhotoDateTimeSeconds(appBuildTime);
  const { user, updateProfile } = useAuth();
  const { currentGroupId } = useGroup();
  const showToast = useToast();
  const installStatusText = isStandalone
    ? "已安装到设备"
    : canInstall
      ? "可以直接安装"
      : installOutcome === "accepted"
        ? "已确认，等待浏览器完成"
        : installOutcome === "dismissed"
          ? "已取消，可再次查看安装步骤"
          : "可按当前浏览器步骤安装";
  const [tab, setTab] = useState<SettingsEntryTab>(initialTab);
  const settingsBodyRef = useRef<HTMLDivElement | null>(null);
  const settingsTabsRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const managedSharesRef = useRef<HTMLDivElement | null>(null);
  const diagnosticsRef = useRef<HTMLDivElement | null>(null);
  const managedShareItemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const scrollTabToCenter = (el: HTMLElement) => {
    const container = settingsTabsRef.current;
    if (!container) return;
    container.scrollTo({ left: el.offsetLeft - (container.clientWidth - el.offsetWidth) / 2, behavior: "smooth" });
  };
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot>({
    serviceWorkerCount: 0,
    localMomentsCount: 0,
    persistenceStatus: "unknown",
  });

  // Profile tab
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState("");

  // Security tab
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwError, setPwError] = useState("");

  const [managedShareLinks, setManagedShareLinks] = useState<ManagedShareLink[]>([]);
  const [managedLoading, setManagedLoading] = useState(false);
  const [managedError, setManagedError] = useState("");
  const [linkBusyId, setLinkBusyId] = useState<string | null>(null);
  const [shareStatusFilter, setShareStatusFilter] = useState<"all" | "active" | "revoked" | "expired">("all");
  const [shareSearch, setShareSearch] = useState("");
  const [extendHours, setExtendHours] = useState("24");

  const [maintenanceTask, setMaintenanceTask] = useState<MaintenanceTaskState | null>(null);
  const [trashMutation, setTrashMutation] = useState<TrashMutationState | null>(null);
  const maintenanceTaskRef = useRef<MaintenanceTaskState | null>(null);
  const trashMutationRef = useRef<TrashMutationState | null>(null);
  const maintenanceGateRef = useRef<MaintenanceTaskGate>({ current: null });
  const maintenanceControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const currentGroupIdRef = useRef(currentGroupId ?? "");
  const onMaintenanceStateChangeRef = useRef(onMaintenanceStateChange);
  const onTrashMutationStateChangeRef = useRef(onTrashMutationStateChange);
  currentGroupIdRef.current = currentGroupId ?? "";
  onMaintenanceStateChangeRef.current = onMaintenanceStateChange;
  onTrashMutationStateChangeRef.current = onTrashMutationStateChange;
  const maintenanceActive = isMaintenanceTaskActive(maintenanceTask);
  const trashMutationActive = isTrashMutationActive(trashMutation);
  const settingsActivityActive = maintenanceActive || trashMutationActive;

  const applyMaintenanceEvent = useCallback((event: MaintenanceTaskEvent) => {
    const next = reduceMaintenanceTaskEvent(maintenanceTaskRef.current, event);
    maintenanceTaskRef.current = next;
    if (mountedRef.current) setMaintenanceTask(next);
    onMaintenanceStateChangeRef.current?.(event);
  }, []);

  const handleTrashMutationStateChange = useCallback((event: TrashMutationEvent) => {
    const next = reduceTrashMutationEvent(trashMutationRef.current, event);
    trashMutationRef.current = next;
    if (mountedRef.current) setTrashMutation(next);
    onTrashMutationStateChangeRef.current?.(event);
  }, []);

  const runMaintenanceTask = async (kind: MaintenanceTaskKind) => {
    if (isTrashMutationActive(trashMutationRef.current)) {
      showToast("回收站任务运行中，请先点击“停止任务”", "info");
      return;
    }
    const operationId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (!beginMaintenanceTask(maintenanceGateRef.current, operationId, kind)) return;

    const workspaceId = currentGroupIdRef.current;
    const controller = new AbortController();
    maintenanceControllerRef.current = controller;
    applyMaintenanceEvent({
      type: "start",
      operation: createMaintenanceTask(operationId, kind, workspaceId),
    });

    try {
      if (kind === "thumbnails") {
        await backfillThumbnails(workspaceId, {
          signal: controller.signal,
          onProgress: (progress) => {
            applyMaintenanceEvent({
              type: "progress",
              operationId,
              processed: progress.processed,
              changed: progress.generated,
              skipped: progress.skipped,
              failed: progress.failed,
              hasMore: progress.hasMore,
            });
            if (currentGroupIdRef.current !== workspaceId) {
              controller.abort(new DOMException("工作空间已变更，缩略图任务已停止", "AbortError"));
            }
          },
        });
      } else {
        const reportMetadataProgress = (progress: Awaited<ReturnType<typeof backfillPhotoMetadata>> & { hasMore: boolean }) => {
          applyMaintenanceEvent({
            type: "progress",
            operationId,
            processed: progress.processed,
            changed: progress.updated,
            skipped: progress.skippedBudget,
            failed: progress.failed,
            hasMore: progress.hasMore,
            candidates: progress.candidates,
            estimatedBytes: progress.estimatedBytes,
            bytesRead: progress.bytesRead,
            recovered: progress.recovered,
            cleanedInvalid: progress.cleanedInvalid,
            trulyMissing: progress.trulyMissing,
            skippedBudget: progress.skippedBudget,
          });
          if (currentGroupIdRef.current !== workspaceId) {
            controller.abort(new DOMException("工作空间已变更，元数据任务已停止", "AbortError"));
          }
        };
        const estimate = await backfillPhotoMetadata(workspaceId, {
          signal: controller.signal,
          dryRun: true,
          onProgress: reportMetadataProgress,
        });
        if (currentGroupIdRef.current !== workspaceId) {
          throw new Error("工作空间已变更，维护任务结果已拒绝");
        }
        if (estimate.candidates === 0) {
          showToast("没有需要恢复的历史照片位置", "info");
          applyMaintenanceEvent({ type: "complete", operationId });
          return;
        }
        const estimatedSize = estimate.estimatedBytes < 1024 * 1024
          ? `${Math.ceil(estimate.estimatedBytes / 1024)} KiB`
          : `${(estimate.estimatedBytes / (1024 * 1024)).toFixed(1)} MiB`;
        if (!window.confirm(
          `只读扫描发现 ${estimate.candidates} 张候选照片，最多读取约 ${estimatedSize}。将按页限制流量并恢复有效 EXIF 位置；确认开始吗？`,
        )) {
          applyMaintenanceEvent({
            type: "stop",
            operationId,
            message: "已取消写入；只读估算未下载原图或修改数据。",
          });
          return;
        }
        await backfillPhotoMetadata(workspaceId, {
          signal: controller.signal,
          onProgress: reportMetadataProgress,
        });
      }
      if (currentGroupIdRef.current !== workspaceId) {
        throw new Error("工作空间已变更，维护任务结果已拒绝");
      }
      applyMaintenanceEvent({ type: "complete", operationId });
    } catch (error) {
      const message = error instanceof Error ? error.message : `${getMaintenanceTaskLabel(kind)}失败`;
      if (controller.signal.aborted) {
        applyMaintenanceEvent({
          type: "stop",
          operationId,
          message: message.includes("工作空间已变更")
            ? message
            : "任务已停止，已保留完成页面的统计。",
        });
      } else {
        applyMaintenanceEvent({ type: "fail", operationId, message });
      }
    } finally {
      if (maintenanceControllerRef.current === controller) maintenanceControllerRef.current = null;
      finishMaintenanceTask(maintenanceGateRef.current, operationId);
    }
  };

  const stopMaintenanceTask = () => {
    const current = maintenanceTaskRef.current;
    const controller = maintenanceControllerRef.current;
    if (!current || !isMaintenanceTaskActive(current) || !controller || controller.signal.aborted) return;
    applyMaintenanceEvent({
      type: "request-stop",
      operationId: current.operationId,
      message: "正在停止任务，已完成的页面不会回滚。",
    });
    controller.abort(new DOMException("任务已停止", "AbortError"));
  };

  const handleProtectedClose = useCallback(() => {
    const guardMessage = getSettingsCloseGuardMessage({
      maintenanceActive: isMaintenanceTaskActive(maintenanceTaskRef.current),
      trashActive: isTrashMutationActive(trashMutationRef.current),
    });
    if (guardMessage) {
      showToast(guardMessage, "info");
      return false;
    }
    onClose();
    return true;
  }, [onClose, showToast]);

  useModalFocusBoundary({
    active: true,
    layerRef,
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
    restoreFocusTo,
    onEscape: handleProtectedClose,
  });

  useEffect(() => {
    const current = maintenanceTaskRef.current;
    if (!current || !isMaintenanceTaskActive(current) || maintenanceWorkspaceMatches(current, currentGroupId ?? "")) return;
    const message = "工作空间已变更，维护任务已停止；已完成页面的统计已保留。";
    applyMaintenanceEvent({ type: "request-stop", operationId: current.operationId, message });
    maintenanceControllerRef.current?.abort(new DOMException(message, "AbortError"));
    showToast(message, "error");
  }, [applyMaintenanceEvent, currentGroupId, showToast]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const current = maintenanceTaskRef.current;
      if (current && isMaintenanceTaskActive(current)) {
        maintenanceControllerRef.current?.abort(
          new DOMException("设置已卸载，维护任务已停止", "AbortError"),
        );
        onMaintenanceStateChangeRef.current?.({
          type: "stop",
          operationId: current.operationId,
          message: "设置已卸载，维护任务已停止。",
        });
      }
    };
  }, []);

  const [shareLinksVersion, setShareLinksVersion] = useState(0);
  useEffect(
    () => registerPrivateLocalDataReset(() => setShareLinksVersion((version) => version + 1)),
    [],
  );
  const shareLinksContext = useMemo(
    () => captureRecentShareLinksContext(),
    [shareLinksVersion],
  );
  const shareLinks = useMemo(() => {
    const links = listRecentShareLinks(shareLinksContext);
    return Array.isArray(links) ? links : [];
  }, [shareLinksContext]);

  const loadManagedShareLinks = useCallback(async () => {
    setManagedLoading(true);
    setManagedError("");
    try {
      const links = await listManagedShareLinks({
        status: shareStatusFilter,
        q: shareSearch,
      });
      setManagedShareLinks(Array.isArray(links) ? links : []);
    } catch (e) {
      setManagedError(e instanceof Error ? e.message : "加载分享链接失败");
      setManagedShareLinks([]);
    } finally {
      setManagedLoading(false);
    }
  }, [shareSearch, shareStatusFilter]);

  useEffect(() => {
    if (tab !== "app") return;
    void loadManagedShareLinks();
  }, [tab, loadManagedShareLinks]);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (tab === "app") {
      if (initialFocusItemId && managedShareItemRefs.current[initialFocusItemId]) {
        managedShareItemRefs.current[initialFocusItemId]?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      if (initialFocusTarget === "managed-shares") {
        managedSharesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }

    if (tab === "diagnostics" && initialFocusTarget === "diagnostics") {
      diagnosticsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [initialFocusItemId, initialFocusTarget, managedShareLinks, tab]);

  useEffect(() => {
    if (tab !== "diagnostics") return;
    let cancelled = false;
    const loadDiagnostics = async () => {
      let serviceWorkerCount = 0;
      if ("serviceWorker" in navigator) {
        try {
          const registrations = await navigator.serviceWorker.getRegistrations();
          serviceWorkerCount = registrations.length;
        } catch {
          serviceWorkerCount = 0;
        }
      }

      let localMomentsCount = 0;
      let localMomentsLastViewedAt: string | undefined;
      const moments = readPrivateMomentInsights(currentGroupId);
      const momentEntries = Object.values(moments);
      localMomentsCount = momentEntries.length;
      localMomentsLastViewedAt = momentEntries
        .map((item) => item.lastViewedAt)
        .filter((value): value is string => !!value)
        .sort()
        .pop();
      const persistence = readPrivateMomentsDiagnostics(currentGroupId);

      if (!cancelled) {
        setDiagnostics({
          serviceWorkerCount,
          localMomentsCount,
          localMomentsLastViewedAt,
          persistenceStatus: persistence.status,
          persistenceMessage: persistence.message,
          persistenceUpdatedAt: persistence.updatedAt,
        });
      }
    };
    void loadDiagnostics();
    return () => {
      cancelled = true;
    };
  }, [currentGroupId, tab]);

  const handleSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) return;
    setProfileSaving(true);
    setProfileError("");
    try {
      await updateProfile(displayName.trim());
      showToast("昵称已更新", "success");
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setProfileSaving(false);
    }
  };

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPwError("");
    if (newPw !== confirmPw) { setPwError("两次输入的新密码不一致"); return; }
    if (newPw.length < 6) { setPwError("新密码至少 6 位"); return; }
    setPwSaving(true);
    try {
      await changePasswordApi({ currentPassword: currentPw, newPassword: newPw });
      setCurrentPw(""); setNewPw(""); setConfirmPw("");
      showToast("密码已更新", "success");
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "修改失败");
    } finally {
      setPwSaving(false);
    }
  };

  const refreshShareLinks = () => setShareLinksVersion((v) => v + 1);

  const copyShareLink = async (
    url: string,
    context?: RecentShareLinksContext | null,
  ) => {
    const isCurrent = () => !context || isRecentShareLinksContextCurrent(context);
    const copied = await copyText(url, isCurrent);
    if (!isCurrent()) return;
    if (copied) {
      showToast("链接已复制", "success");
    } else {
      window.prompt("复制分享链接", url);
      showToast("已生成链接，请手动复制", "info");
    }
  };

  const handleManagedAction = async (item: ManagedShareLink, action: "revoke" | "extend") => {
    if (action === "revoke" && !confirm("确认让这个分享链接立即失效吗？")) return;
    setLinkBusyId(item.id);
    try {
      const duration = Math.max(1, Math.min(24 * 30, Number.parseInt(extendHours, 10) || 24));
      await updateManagedShareLink(item.id, action, action === "extend" ? duration : undefined);
      showToast(action === "revoke" ? "分享链接已失效" : `已延长 ${duration} 小时`, "success");
      await loadManagedShareLinks();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "更新分享链接失败", "error");
    } finally {
      setLinkBusyId(null);
    }
  };

  const safeManagedShareLinks = Array.isArray(managedShareLinks)
    ? managedShareLinks.filter((item): item is ManagedShareLink => !!item && typeof item.id === "string")
    : [];
  const safeShareLinks = Array.isArray(shareLinks)
    ? shareLinks.filter((item) => !!item && typeof item.id === "string" && typeof item.url === "string")
    : [];

  return createPortal(
    <div ref={layerRef} className="dialog-overlay" data-modal-layer onClick={handleProtectedClose}>
      <div
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="settings-header">
          <span id="settings-dialog-title">设置</span>
          <button ref={closeButtonRef} type="button" className="dialog-close-btn" onClick={handleProtectedClose} aria-label="关闭设置">✕</button>
        </div>

        {/* Tab bar */}
        <div className="settings-tabs" ref={settingsTabsRef}>
          <button className={`settings-tab${tab === "profile" ? " active" : ""}`} disabled={settingsActivityActive} onClick={(e) => { setTab("profile"); scrollTabToCenter(e.currentTarget); }}>👤 个人信息</button>
          <button className={`settings-tab${tab === "security" ? " active" : ""}`} disabled={settingsActivityActive} onClick={(e) => { setTab("security"); scrollTabToCenter(e.currentTarget); }}>🔒 安全</button>
          <button className={`settings-tab${tab === "app" ? " active" : ""}`} disabled={settingsActivityActive} onClick={(e) => { setTab("app"); scrollTabToCenter(e.currentTarget); }}>📱 应用</button>
          <button className={`settings-tab${tab === "diagnostics" ? " active" : ""}`} disabled={settingsActivityActive} onClick={(e) => { setTab("diagnostics"); scrollTabToCenter(e.currentTarget); }}>🩺 诊断</button>
          <button className={`settings-tab${tab === "trash" ? " active" : ""}`} disabled={settingsActivityActive} onClick={(e) => { setTab("trash"); scrollTabToCenter(e.currentTarget); }}>🗑️ 回收站</button>
        </div>

        {/* Tab content */}
        <div className="settings-body" ref={settingsBodyRef}>

          {/* ── 个人信息 ── */}
          {tab === "profile" && (
            <div className="settings-section settings-section--stacked">
              {/* Read-only info */}
              <div className="settings-card settings-card--soft">
                <div className="settings-card-head">
                  <h3>账号概览</h3>
                  <span className="settings-card-badge">@{user?.username}</span>
                </div>
                <div className="settings-info-grid">
                  <div className="settings-info-row">
                    <span className="settings-info-label">用户名</span>
                    <span className="settings-info-value">@{user?.username}</span>
                  </div>
                  <div className="settings-info-row">
                    <span className="settings-info-label">邮箱</span>
                    <span className="settings-info-value">{user?.email}</span>
                  </div>
                  <div className="settings-info-row">
                    <span className="settings-info-label">角色</span>
                    <span className="settings-info-value">{user?.role === "admin" ? "管理员" : "普通用户"}</span>
                  </div>
                </div>
              </div>

              {/* Editable */}
              <form onSubmit={handleSaveProfile} className="settings-form settings-card">
                <div className="settings-card-head">
                  <h3>个人资料</h3>
                </div>
                <div className="auth-field">
                  <label>昵称（显示名）</label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    maxLength={40}
                    placeholder="修改昵称"
                  />
                </div>
                {profileError && <div className="auth-error">{profileError}</div>}
                <button
                  type="submit"
                  className="settings-save-btn"
                  disabled={profileSaving || !displayName.trim() || displayName.trim() === user?.displayName}
                >
                  {profileSaving ? "保存中…" : "保存昵称"}
                </button>
              </form>
            </div>
          )}

          {/* ── 安全 ── */}
          {tab === "security" && (
            <div className="settings-section">
              <form onSubmit={handleChangePassword} className="settings-form settings-card">
                <div className="settings-card-head">
                  <h3>密码管理</h3>
                  <span className="settings-card-note">建议使用更长、更独特的密码组合</span>
                </div>
                <div className="auth-field">
                  <label>当前密码</label>
                  <input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} autoComplete="current-password" />
                </div>
                <div className="auth-field">
                  <label>新密码</label>
                  <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" placeholder="至少 6 位" />
                </div>
                <div className="auth-field">
                  <label>确认新密码</label>
                  <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" />
                </div>
                {pwError && <div className="auth-error">{pwError}</div>}
                <button
                  type="submit"
                  className="settings-save-btn"
                  disabled={pwSaving || !currentPw || !newPw || !confirmPw}
                >
                  {pwSaving ? "修改中…" : "修改密码"}
                </button>
              </form>
            </div>
          )}

          {/* ── 应用 ── */}
          {tab === "app" && (
            <div className="settings-section settings-section--stacked">
              <div className="settings-card settings-card--soft">
                <div className="settings-card-head">
                  <h3>应用状态</h3>
                </div>
                <div className="settings-info-grid">
                  <div className="settings-info-row">
                    <span className="settings-info-label">当前模式</span>
                    <span className="settings-info-value">{isStandalone ? "App 模式" : "网页模式"}</span>
                  </div>
                  <div className="settings-info-row">
                    <span className="settings-info-label">前端版本</span>
                    <span className="settings-info-value">v{appVersion}</span>
                  </div>
                  <div className="settings-info-row">
                    <span className="settings-info-label">构建时间</span>
                    <span className="settings-info-value">{appBuildTimeText}</span>
                  </div>
                  <div className="settings-info-row">
                    <span className="settings-info-label">安装状态</span>
                    <span className="settings-info-value">{installStatusText}</span>
                  </div>
                </div>
              </div>
              <div
                className="settings-form settings-card"
                style={{ gap: 10 }}
                aria-busy={maintenanceActive && maintenanceTask?.kind === "thumbnails"}
              >
                <div className="settings-card-head">
                  <h3>生成历史缩略图</h3>
                </div>
                <p className="add-admin-hint">
                  为历史照片生成 400px WebP 缩略图（约 30-50 KB），时间线浏览速度大幅提升。已有缩略图的照片会自动跳过，原图不受影响。照片较多时可能需要几分钟。
                </p>
                <button
                  type="button"
                  className="settings-save-btn"
                  onClick={() => void runMaintenanceTask("thumbnails")}
                  disabled={settingsActivityActive}
                >
                  {maintenanceTask?.kind === "thumbnails" && maintenanceActive ? "正在生成…" : "开始生成缩略图"}
                </button>
                {maintenanceTask?.kind === "thumbnails" && (
                  <div className={`maintenance-task-status maintenance-task-status--${maintenanceTask.phase}`} role="status" aria-live="polite">
                    <span>{getMaintenanceBannerText(maintenanceTask)}</span>
                    {maintenanceTask.message && <span>{maintenanceTask.message}</span>}
                    {maintenanceActive && (
                      <button type="button" className="maintenance-stop-btn" onClick={stopMaintenanceTask}>
                        {maintenanceTask.phase === "stopping" ? "正在停止…" : "停止任务"}
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div
                className="settings-form settings-card"
                style={{ gap: 10 }}
                aria-busy={maintenanceActive && maintenanceTask?.kind === "metadata"}
              >
                <div className="settings-card-head">
                  <h3>历史照片回填</h3>
                </div>
                <p className="add-admin-hint">
                  先只读估算候选照片和最大读取量，确认后再恢复拍摄时间与 GPS。合法位置不会被覆盖；NaN、越界或单边位置会从 EXIF 恢复，确认原图无位置后才清理。
                </p>
                <button
                  type="button"
                  className="settings-save-btn"
                  onClick={() => void runMaintenanceTask("metadata")}
                  disabled={settingsActivityActive}
                >
                  {maintenanceTask?.kind === "metadata" && maintenanceActive ? "正在回填…" : "开始回填"}
                </button>
                {maintenanceTask?.kind === "metadata" && (
                  <div className={`maintenance-task-status maintenance-task-status--${maintenanceTask.phase}`} role="status" aria-live="polite">
                    <span>{getMaintenanceBannerText(maintenanceTask)}</span>
                    {maintenanceTask.message && <span>{maintenanceTask.message}</span>}
                    {maintenanceActive && (
                      <button type="button" className="maintenance-stop-btn" onClick={stopMaintenanceTask}>
                        {maintenanceTask.phase === "stopping" ? "正在停止…" : "停止任务"}
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="settings-form settings-card" style={{ gap: 10 }}>
                <div className="settings-card-head">
                  <h3>安装与启动</h3>
                </div>
                <button
                  type="button"
                  className="settings-save-btn"
                  onClick={(event) => onInstallApp?.(event.currentTarget)}
                  disabled={isStandalone || settingsActivityActive}
                >
                  {isStandalone ? "已安装到设备" : canInstall ? "立即安装应用" : "安装应用"}
                </button>
                <p className="add-admin-hint" style={{ marginTop: 4 }}>
                  {canInstall
                    ? "点击后将打开浏览器的原生安装确认。"
                    : "点击后会显示适用于当前浏览器的安装或添加到主屏幕步骤。"}
                </p>
              </div>

              <div className="settings-card settings-card--soft">
                <div className="settings-share-header" ref={managedSharesRef}>
                  <span className="settings-info-label">云端分享链接（可维护）</span>
                  <button type="button" className="settings-share-clear" onClick={() => void loadManagedShareLinks()}>
                    刷新
                  </button>
                </div>

                <div className="settings-share-toolbar">
                  <input
                    className="settings-share-search"
                    type="text"
                    placeholder="按文件名搜索"
                    value={shareSearch}
                    onChange={(e) => setShareSearch(e.target.value)}
                  />
                  <select
                    className="settings-share-filter"
                    value={shareStatusFilter}
                    onChange={(e) => setShareStatusFilter(e.target.value as "all" | "active" | "revoked" | "expired")}
                  >
                    <option value="all">全部状态</option>
                    <option value="active">有效</option>
                    <option value="expired">已过期</option>
                    <option value="revoked">已失效</option>
                  </select>
                  <button type="button" className="settings-share-apply" onClick={() => void loadManagedShareLinks()}>
                    应用筛选
                  </button>
                </div>

                <div className="settings-share-extend-row">
                  <span className="settings-share-extend-label">默认延长：</span>
                  <select className="settings-share-filter" value={extendHours} onChange={(e) => setExtendHours(e.target.value)}>
                    <option value="1">1 小时</option>
                    <option value="24">24 小时</option>
                    <option value="72">3 天</option>
                    <option value="168">7 天</option>
                    <option value="720">30 天</option>
                  </select>
                </div>

                {managedLoading ? (
                  <p className="add-admin-hint">正在加载分享链接…</p>
                ) : managedError ? (
                  <p className="auth-error">{managedError}</p>
                ) : safeManagedShareLinks.length === 0 ? (
                  <p className="add-admin-hint">暂无云端分享记录，先从照片详情创建一个分享链接。</p>
                ) : (
                  <div className="settings-share-list">
                    {safeManagedShareLinks.map((item) => {
                      const statusText = item.status === "active" ? "有效" : item.status === "revoked" ? "已失效" : "已过期";
                      const busy = linkBusyId === item.id;
                      const publicUrl = item.url ?? `${window.location.origin}/api/photos/share/open/${encodeURIComponent(item.id)}`;
                      return (
                        <div
                          key={item.id}
                          className={`settings-share-item settings-share-item--managed${initialFocusItemId === item.id ? " settings-share-item--target" : ""}`}
                          ref={(node) => { managedShareItemRefs.current[item.id] = node; }}
                        >
                          <div className="settings-share-meta">
                            <div className="settings-share-name" title={item.displayName}>{item.displayName}</div>
                            <div className="settings-share-expire">创建：{formatPhotoDateTimeSeconds(item.createdAt)}</div>
                            <div className="settings-share-expire">到期：{formatPhotoDateTimeSeconds(item.expiresAt)} · 状态：{statusText}</div>
                            <div className="settings-share-expire">浏览量：{item.viewCount} · 最近访问：{item.lastViewedAt ? formatPhotoDateTimeSeconds(item.lastViewedAt) : "暂无"}</div>
                          </div>
                          <div className="settings-share-actions">
                            <button type="button" onClick={() => void copyShareLink(publicUrl)}>复制</button>
                            <button type="button" onClick={() => window.open(publicUrl, "_blank", "noopener,noreferrer")}>打开</button>
                            <button type="button" onClick={() => void handleManagedAction(item, "extend")} disabled={busy || item.status !== "active"}>延长</button>
                            <button type="button" onClick={() => void handleManagedAction(item, "revoke")} disabled={busy || item.status !== "active"}>立即失效</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="settings-card">
                <div className="settings-share-header">
                  <span className="settings-info-label">本地分享记录（仅当前浏览器）</span>
                  {safeShareLinks.length > 0 && (
                    <button
                      type="button"
                      className="settings-share-clear"
                      onClick={() => {
                        if (!clearRecentShareLinks(shareLinksContext)) return;
                        refreshShareLinks();
                        showToast("已清空本地分享记录", "success");
                      }}
                    >
                      清空记录
                    </button>
                  )}
                </div>

                {safeShareLinks.length === 0 ? (
                  <p className="add-admin-hint">暂无本机生成的有效分享链接。</p>
                ) : (
                  <div className="settings-share-list">
                    {safeShareLinks.map((item) => (
                      <div key={item.id} className="settings-share-item">
                        <div className="settings-share-meta">
                          <div className="settings-share-name" title={item.displayName}>{item.displayName}</div>
                          <div className="settings-share-expire">到期：{formatPhotoDateTimeSeconds(item.expiresAt)}</div>
                        </div>
                        <div className="settings-share-actions">
                          <button type="button" onClick={() => void copyShareLink(item.url, shareLinksContext)}>复制</button>
                          <button
                            type="button"
                            onClick={() => {
                              if (isRecentShareLinksContextCurrent(shareLinksContext)) {
                                window.open(item.url, "_blank", "noopener,noreferrer");
                              }
                            }}
                          >
                            打开
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (!removeRecentShareLink(shareLinksContext, item.id)) return;
                              refreshShareLinks();
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === "diagnostics" && (
            <div className="settings-section" ref={diagnosticsRef}>
              <div className="settings-card settings-card--soft">
                <div className="settings-card-head">
                  <h3>运行概览</h3>
                </div>
                <div className="settings-info-grid">
                  <div className="settings-info-row">
                    <span className="settings-info-label">前端版本</span>
                    <span className="settings-info-value">v{appVersion}</span>
                  </div>
                  <div className="settings-info-row">
                    <span className="settings-info-label">构建时间</span>
                    <span className="settings-info-value">{appBuildTimeText}</span>
                  </div>
                  <div className="settings-info-row">
                    <span className="settings-info-label">运行模式</span>
                    <span className="settings-info-value">{isStandalone ? "已安装 App / PWA" : "普通网页"}</span>
                  </div>
                  <div className="settings-info-row">
                    <span className="settings-info-label">SW 注册数</span>
                    <span className="settings-info-value">{diagnostics.serviceWorkerCount}</span>
                  </div>
                </div>
              </div>

              <div className="settings-card">
                <div className="settings-card-head">
                  <h3>同步与缓存</h3>
                </div>
                <div className="settings-info-grid">
                  <div className="settings-info-row">
                    <span className="settings-info-label">本地浏览记录</span>
                    <span className="settings-info-value">{diagnostics.localMomentsCount} 条</span>
                  </div>
                  <div className="settings-info-row">
                    <span className="settings-info-label">最近本地浏览</span>
                    <span className="settings-info-value">{diagnostics.localMomentsLastViewedAt ? formatPhotoDateTimeSeconds(diagnostics.localMomentsLastViewedAt) : "暂无"}</span>
                  </div>
                  <div className="settings-info-row">
                    <span className="settings-info-label">持久化状态</span>
                    <span className="settings-info-value">
                      {diagnostics.persistenceStatus === "server-synced"
                        ? "服务端已同步"
                        : diagnostics.persistenceStatus === "server-unavailable"
                        ? "服务端不可用，当前仅本地保存"
                        : diagnostics.persistenceStatus === "local-only"
                        ? "当前仅本地保存"
                        : "未检测"}
                    </span>
                  </div>
                  {diagnostics.persistenceUpdatedAt && (
                    <div className="settings-info-row">
                      <span className="settings-info-label">状态时间</span>
                      <span className="settings-info-value">{formatPhotoDateTimeSeconds(diagnostics.persistenceUpdatedAt)}</span>
                    </div>
                  )}
                  {diagnostics.persistenceMessage && (
                    <div className="settings-info-row">
                      <span className="settings-info-label">诊断信息</span>
                      <span className="settings-info-value">{diagnostics.persistenceMessage}</span>
                    </div>
                  )}
                </div>
                <div style={{ padding: "12px 16px 4px", borderTop: "1px solid #f1f5f9", marginTop: 8 }}>
                  <button
                    type="button"
                    className="settings-save-btn"
                    onClick={async () => {
                      if ("serviceWorker" in navigator) {
                        const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
                        await Promise.all(regs.map((r) => r.unregister()));
                      }
                      if ("caches" in window) {
                        const keys = await window.caches.keys().catch(() => [] as string[]);
                        await Promise.all(keys.map((k) => window.caches.delete(k)));
                      }
                      window.location.reload();
                    }}
                  >
                    🔄 清除缓存并强制更新
                  </button>
                  <p className="add-admin-hint" style={{ marginTop: 4 }}>
                    感觉没有变化时点击，会注销 Service Worker 并重新加载
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ── 回收站 ── */}
          {tab === "trash" && (
            <div className="settings-section settings-trash">
              <TrashView
                groupId={currentGroupId}
                onRestored={onPhotosRestored}
                onMutationStateChange={handleTrashMutationStateChange}
                blocked={maintenanceActive}
              />
            </div>
          )}

        </div>
      </div>
    </div>,
    document.body,
  );
}
