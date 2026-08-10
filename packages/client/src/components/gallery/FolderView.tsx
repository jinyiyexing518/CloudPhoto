import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Photo,
  updatePhotoSubject,
  renamePhoto as apiRenamePhoto,
  downloadPhotoApi,
  preloadPhotoDownload,
  createPhotoShareLink,
  createFolderShareLink,
  recordMomentViewApi,
  ManagedMomentsUnavailableError,
  uploadPhotoWithProgress,
  setPhotoVoiceMemo as apiSetVoiceMemo,
  updatePhotoTakenAt,
  updatePhotoGps,
  fetchMotionVideoBlob,
  getViewerSrc,
  persistVideoPlaybackThumbnail,
} from "../../services/photoApi";
import { GALLERY_EAGER_MEDIA_COUNT } from "@cloudphoto/algorithm";
import { addRecentShareLink } from "../../services/share/shareLinksStore";
import { copyText } from "../../services/share/clipboard";
import {
  fallbackMediaSource,
  getPreferredMediaUrl,
  preloadImageWithFallback,
} from "../../services/mediaRoute";
import {
  getVideoPlaybackRenderState,
} from "../../services/videoPlaybackSession";
import { useResilientVideoPlayback } from "../../services/useResilientVideoPlayback";
import PhotoCard from "./PhotoCard";
import { useToast } from "../../contexts/ToastContext";
import PhotoTimeEditDialog from "../shared/PhotoTimeEditDialog";
import LocationSearchPanel from "../shared/LocationSearchPanel";
import BatchOperationsBar from "../shared/BatchOperationsBar";
import { usePhotoLocationAddress } from "./usePhotoLocationAddress";
import { type VoiceTransferState } from "../../transfer/voiceTransferState";
import { type UploadAggregateProgress } from "../../transfer/uploadQueue";
import {
  runBatchMutationBoundary,
  type BatchMutationEvent,
  type BatchMutationGate,
  type BatchMutationKind,
  type BatchMutationResult,
} from "../../transfer/batchMutationState";
import { validateFolderRenameInput } from "../../transfer/folderRenameState";
import {
  getFolderDisplayName,
  getFolderGroupLabel,
  getFolderOpenLabel,
} from "./folderCardAccessibility";
import { isModalShortcutTarget } from "../shared/modalFocus";
import { useModalFocusBoundary } from "../shared/useModalFocusBoundary";

let folderBatchMutationSequence = 0;

const UNCATEGORIZED = "(未分类)";
const MOVE_UNSELECTED = "__UNSEL__";
const MOVE_CREATE = "__CREATE__";

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

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Returns immediate child sub-folder names at the given path level. */
function getImmediateSubFolders(
  photos: Photo[],
  extraFolders: string[],
  currentPath: string | null,
): string[] {
  const set = new Set<string>();
  const allPaths = [
    ...photos.map((p) => p.folder?.trim() ?? ""),
    ...extraFolders,
  ];
  for (const f of allPaths) {
    if (currentPath === null) {
      if (f !== "") set.add(f.split("/")[0]);
    } else if (currentPath !== "" && f.startsWith(currentPath + "/")) {
      const next = f.slice(currentPath.length + 1).split("/")[0];
      if (next) set.add(next);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Count photos directly or recursively under folderPath. */
function countPhotosUnder(photos: Photo[], folderPath: string): number {
  if (folderPath === "") {
    return photos.filter((p) => (p.folder?.trim() ?? "") === "").length;
  }
  return photos.filter((p) => {
    const f = p.folder?.trim() ?? "";
    return f === folderPath || f.startsWith(folderPath + "/");
  }).length;
}

// ─── FolderCard ───────────────────────────────────────────────────────────────

function FolderCard({
  name,
  count,
  onClick,
  onDrop,
  onRename,
  onDelete,
  hasSubFolders = false,
  interactionDisabled = false,
}: {
  name: string;
  count: number;
  onClick: () => void;
  onDrop?: (photoName: string, fromFolder: string) => void;
  onRename?: (newName: string) => void;
  onDelete?: () => void;
  hasSubFolders?: boolean;
  interactionDisabled?: boolean;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState(name);
  const dragCount = useRef(0);
  const displayName = getFolderDisplayName(name);

  const confirmRename = () => {
    if (interactionDisabled) return;
    const trimmed = editVal.trim();
    if (trimmed && trimmed !== name && onRename) onRename(trimmed);
    setEditing(false);
  };

  return (
    <div
      className={`folder-card${dragOver ? " folder-card--dragover" : ""}${interactionDisabled ? " folder-card--disabled" : ""}`}
      role="group"
      aria-label={getFolderGroupLabel(name)}
      aria-disabled={interactionDisabled || undefined}
      onDragOver={(e) => {
        if (interactionDisabled) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDragEnter={(e) => {
        if (interactionDisabled) return;
        e.preventDefault();
        dragCount.current++;
        setDragOver(true);
      }}
      onDragLeave={() => { dragCount.current--; if (dragCount.current === 0) setDragOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCount.current = 0;
        setDragOver(false);
        if (interactionDisabled) return;
        const photoName = e.dataTransfer.getData("photoName");
        const fromFolder = e.dataTransfer.getData("fromFolder");
        if (photoName && onDrop) onDrop(photoName, fromFolder);
      }}
    >
      {editing ? (
        <>
          <div className="folder-card-icon">{hasSubFolders ? "📂" : "📁"}</div>
          <input
            autoFocus
            className="folder-card-rename-input"
            value={editVal}
            onChange={(e) => setEditVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); confirmRename(); }
              if (e.key === "Escape") { setEditVal(name); setEditing(false); }
            }}
            onBlur={confirmRename}
            onClick={(e) => e.stopPropagation()}
            maxLength={60}
            disabled={interactionDisabled}
          />
          <div className="folder-card-count">{count} 张</div>
        </>
      ) : (
        <button
          type="button"
          className="folder-card-open"
          aria-label={getFolderOpenLabel(name, count)}
          disabled={interactionDisabled}
          onClick={onClick}
        >
          <span className="folder-card-icon" aria-hidden="true">
            {hasSubFolders ? "📂" : "📁"}
          </span>
          <span className="folder-card-name">{displayName}</span>
          <span className="folder-card-count">{count} 张</span>
        </button>
      )}
      {onRename && !editing && (
        <button
          type="button"
          className="folder-card-rename-btn"
          aria-label={`重命名文件夹 ${displayName}`}
          title="重命名文件夹"
          disabled={interactionDisabled}
          onClick={(e) => {
            e.stopPropagation();
            if (interactionDisabled) return;
            setEditVal(name);
            setEditing(true);
          }}
        >
          ✏️
        </button>
      )}
      {onDelete && !editing && (
        <button
          type="button"
          className="folder-card-delete-btn"
          aria-label={`删除文件夹 ${displayName}`}
          title="删除文件夹（照片移入回收站）"
          disabled={interactionDisabled}
          onClick={(e) => {
            e.stopPropagation();
            if (!interactionDisabled) onDelete();
          }}
        >
          🗑️
        </button>
      )}
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

type FolderUploadProgress = UploadAggregateProgress & {
  folder: string;
  currentFile?: string;
};

interface Props {
  photos: Photo[];
  onDelete: (name: string) => void;
  onSubjectUpdate: (name: string, subject: string) => void;
  onRenamePhoto: (name: string, newOriginalName: string) => void;
  onTakenAtUpdate?: (name: string, takenAt: string) => void;
  onGpsUpdate?: (name: string, lat: string, lon: string) => void;
  onToggleFavorite: (name: string, favorite: boolean) => Promise<boolean>;
  onUploadToFolder: (files: FileList, folder: string, subject?: string) => Promise<void>;
  uploadProgress: FolderUploadProgress | null;
  onMovePhoto: (name: string, toFolder: string) => Promise<boolean>;
  onBatchDelete?: (names: string[]) => Promise<void>;
  onRenameFolder?: (oldFolder: string, newFolder: string) => Promise<void>;
  onDownloadStateChange?: (downloading: boolean) => void;
  onVoiceStateChange?: (state: VoiceTransferState) => void;
  onBatchMutationChange?: (event: BatchMutationEvent) => void;
  batchMutationActive?: boolean;
  folderRenameActive?: boolean;
  onShareCreated?: (photoName: string) => void;
  onThumbnailUpdate?: (photoName: string, thumbnailUrl: string) => void;
  userName?: string;
  currentGroupId?: string;
  /** Unique key for localStorage persistence (e.g. groupId or "personal") */
  contextKey?: string;
}

// ─── FolderView (root navigator) ─────────────────────────────────────────────

export default function FolderView({
  photos,
  onDelete,
  onSubjectUpdate,
  onRenamePhoto,
  onTakenAtUpdate,
  onGpsUpdate,
  onToggleFavorite,
  onUploadToFolder,
  uploadProgress,
  onMovePhoto,
  onBatchDelete,
  onRenameFolder,
  onDownloadStateChange,
  onVoiceStateChange,
  onBatchMutationChange,
  batchMutationActive = false,
  folderRenameActive = false,
  onShareCreated,
  onThumbnailUpdate,
  userName,
  currentGroupId,
  contextKey = "personal",
}: Props) {
  type FolderHistoryState = {
    __cfFolderNav?: true;
    contextKey?: string;
    path?: string | null;
  };

  const showToast = useToast();
  // Initialize directly from localStorage so the persist effect never sees a stale null on mount.
  // FolderView is always rendered with key={contextKey}, so contextKey is constant per instance.
  const [currentPath, setCurrentPath] = useState<string | null>(() => {
    const stored = localStorage.getItem(`cf_path_${contextKey}`);
    return stored !== null ? stored : null;
  });
  const [extraFolders, setExtraFolders] = useState<string[]>(() => {
    const stored = localStorage.getItem(`cf_xf_${contextKey}`);
    try { return stored ? (JSON.parse(stored) as string[]) : []; } catch { return []; }
  });
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  // Names of folders created in the current session at the current path level.
  // These are pinned to the top of the list until the user navigates away or refreshes.
  const [newlyCreatedFolders, setNewlyCreatedFolders] = useState<string[]>([]);
  const [folderShareHours, setFolderShareHours] = useState("24");
  const [sharingFolder, setSharingFolder] = useState(false);
  const [showShareFolderDialog, setShowShareFolderDialog] = useState(false);
  // Mark as hydrated immediately — state is already initialized from localStorage above.
  const hydratedContextRef = useRef<string | null>(contextKey);
  const historyHydratedRef = useRef(false);
  const applyingPopstateRef = useRef(false);
  const [localBatchMutationBusy, setLocalBatchMutationBusy] = useState(false);
  const batchMutationBusy = localBatchMutationBusy || batchMutationActive;
  const mutationBusy = batchMutationBusy || folderRenameActive;
  const batchMutationGate = useRef<BatchMutationGate>({ current: null }).current;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleBatchMutationEvent = useCallback((event: BatchMutationEvent) => {
    onBatchMutationChange?.(event);
    if (!mountedRef.current) return;
    if (event.type === "start") setLocalBatchMutationBusy(true);
    if (event.type === "finish") setLocalBatchMutationBusy(false);
  }, [onBatchMutationChange]);

  // No-op on first mount (state is already hydrated), but handles any future contextKey change
  // (which in practice never happens because the parent renders FolderView with key={contextKey}).
  useEffect(() => {
    hydratedContextRef.current = null;
    historyHydratedRef.current = false;
    applyingPopstateRef.current = false;
    const storedXF = localStorage.getItem(`cf_xf_${contextKey}`);
    try { setExtraFolders(storedXF ? (JSON.parse(storedXF) as string[]) : []); } catch { setExtraFolders([]); }
    const storedPath = localStorage.getItem(`cf_path_${contextKey}`);
    setCurrentPath(storedPath !== null ? storedPath : null);
    hydratedContextRef.current = contextKey;
  }, [contextKey]);

  // Bridge folder path into browser history so device back key returns to previous folder.
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const state = event.state as FolderHistoryState | null;
      if (!state?.__cfFolderNav || state.contextKey !== contextKey) return;
      applyingPopstateRef.current = true;
      setCurrentPath(state.path ?? null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [contextKey]);

  useEffect(() => {
    if (hydratedContextRef.current !== contextKey) return;

    const normalizedPath = currentPath ?? null;
    const state = window.history.state as FolderHistoryState | null;

    if (applyingPopstateRef.current) {
      applyingPopstateRef.current = false;
      return;
    }

    if (!historyHydratedRef.current || !state?.__cfFolderNav || state.contextKey !== contextKey) {
      // Seed with root first, then push the actual path if currently inside a subfolder.
      window.history.replaceState({ __cfFolderNav: true, contextKey, path: null }, "");
      if (normalizedPath !== null) {
        window.history.pushState({ __cfFolderNav: true, contextKey, path: normalizedPath }, "");
      }
      historyHydratedRef.current = true;
      return;
    }

    if (state.path !== normalizedPath) {
      window.history.pushState({ __cfFolderNav: true, contextKey, path: normalizedPath }, "");
    }
  }, [contextKey, currentPath]);

  // Persist extra folders whenever they change
  useEffect(() => {
    if (hydratedContextRef.current !== contextKey) return;
    localStorage.setItem(`cf_xf_${contextKey}`, JSON.stringify(extraFolders));
  }, [extraFolders, contextKey]);

  // Persist current path whenever it changes
  useEffect(() => {
    if (hydratedContextRef.current !== contextKey) return;
    if (currentPath === null) {
      localStorage.removeItem(`cf_path_${contextKey}`);
    } else {
      localStorage.setItem(`cf_path_${contextKey}`, currentPath);
    }
  }, [currentPath, contextKey]);

  // Clear pinned-to-top list whenever the user navigates to a different folder
  useEffect(() => {
    setNewlyCreatedFolders([]);
  }, [currentPath]);

  // Remove extra folders that now have real photos (they’re no longer "empty")
  useEffect(() => {
    const photoFolderSet = new Set(photos.map((p) => p.folder?.trim() ?? ""));
    setExtraFolders((prev) => {
      const cleaned = prev.filter((f) => !photoFolderSet.has(f));
      return cleaned.length === prev.length ? prev : cleaned;
    });
  }, [photos]);

  const subFolders = getImmediateSubFolders(photos, extraFolders, currentPath);
  // Newly-created folders bubble to the top; the rest remain alphabetical
  const displaySubFolders = [
    ...newlyCreatedFolders.filter((n) => subFolders.includes(n)),
    ...subFolders.filter((n) => !newlyCreatedFolders.includes(n)),
  ];
  const hasUncategorized =
    currentPath === null && photos.some((p) => (p.folder?.trim() ?? "") === "");

  // Breadcrumb
  const crumbs: Array<{ label: string; path: string | null }> = [
    { label: "根目录", path: null },
  ];
  if (currentPath !== null) {
    if (currentPath === "") {
      crumbs.push({ label: UNCATEGORIZED, path: "" });
    } else {
      currentPath.split("/").forEach((seg, i, arr) => {
        crumbs.push({ label: seg, path: arr.slice(0, i + 1).join("/") });
      });
    }
  }

  const createFolder = () => {
    if (mutationBusy) return;
    const name = newFolderName.trim();
    if (!name) return;
    if (name.includes("/")) { showToast("文件夹名不能包含 /", "error"); return; }
    const fullPath = currentPath === null ? name : (currentPath === "" ? name : `${currentPath}/${name}`);
    setExtraFolders((prev) => (prev.includes(fullPath) ? prev : [...prev, fullPath]));
    // Pin the new folder to the top of the list for this session
    setNewlyCreatedFolders((prev) => prev.includes(name) ? prev : [...prev, name]);
    setNewFolderName("");
    setCreatingFolder(false);
  };

  const handleRenameFolder = async (oldName: string, newName: string) => {
    if (mutationBusy) return;
    const oldFull = fullFolderPath(oldName);
    const validation = validateFolderRenameInput(oldFull, newName, displaySubFolders);
    if (!validation.ok) {
      showToast(validation.error, "error");
      return;
    }
    const newFull = validation.newFolder;
    // Update localStorage path if we're currently inside (or below) the renamed folder
    try {
      await onRenameFolder?.(oldFull, newFull);
      // Update extraFolders paths
      setExtraFolders((prev) =>
        prev.map((f) =>
          f === oldFull ? newFull :
          f.startsWith(oldFull + "/") ? newFull + f.slice(oldFull.length) : f
        )
      );
      // Navigate to new path if currently inside renamed folder
      if (currentPath !== null && (currentPath === oldFull || currentPath.startsWith(oldFull + "/"))) {
        const newPath = newFull + currentPath.slice(oldFull.length);
        setCurrentPath(newPath);
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : "重命名失败", "error");
    }
  };

  const handleDeleteFolder = async (folderName: string) => {
    if (mutationBusy) return;
    const fullPath = fullFolderPath(folderName);
    const photosInFolder = photos.filter((p) => {
      const f = p.folder?.trim() ?? "";
      return f === fullPath || f.startsWith(fullPath + "/");
    });
    const msg = photosInFolder.length > 0
      ? `删除文件夹「${folderName}」及其 ${photosInFolder.length} 张照片？\n照片将移入回收站，随时可以恢复。`
      : `删除空文件夹「${folderName}」？`;
    if (!confirm(msg)) return;

    if (photosInFolder.length > 0) {
      const names = photosInFolder.map((p) => p.name);
      if (onBatchDelete) {
        await onBatchDelete(names);
      } else {
        for (const p of photosInFolder) onDelete(p.name);
      }
    }

    // Remove from locally-tracked empty folders
    setExtraFolders((prev) =>
      prev.filter((ef) => ef !== fullPath && !ef.startsWith(fullPath + "/"))
    );

    // Navigate back if we're currently inside the deleted folder
    if (currentPath !== null && (currentPath === fullPath || currentPath.startsWith(fullPath + "/"))) {
      const parentPath = fullPath.includes("/") ? fullPath.split("/").slice(0, -1).join("/") : null;
      setCurrentPath(parentPath);
    }

    if (photosInFolder.length === 0) showToast(`已删除文件夹「${folderName}」`, "success");
  };

  const navigateTo = (folderName: string) => {
    if (currentPath === null) {
      setCurrentPath(folderName);
    } else if (currentPath === "") {
      setCurrentPath(folderName);
    } else {
      setCurrentPath(`${currentPath}/${folderName}`);
    }
  };

  const fullFolderPath = (subName: string): string => {
    if (currentPath === null || currentPath === "") return subName;
    return `${currentPath}/${subName}`;
  };

  // All unique folder paths for the "move to" dropdown in the modal
  const allFolderPaths = [
    ...new Set(photos.map((p) => p.folder?.trim() ?? "")),
  ].sort((a, b) => {
    if (a === "") return -1;
    if (b === "") return 1;
    return a.localeCompare(b);
  });

  const moveByDragWithToast = async (photoName: string, fromFolder: string, toFolder: string) => {
    if (mutationBusy) return;
    if (fromFolder === toFolder) return;
    const ok = await onMovePhoto(photoName, toFolder);
    if (ok) {
      showToast(`已移动到「${toFolder || UNCATEGORIZED}」`, "success");
    }
  };

  const handleShareCurrentFolder = async () => {
    if (currentPath === null) return;
    const hours = Math.max(1, Math.min(168, Number.parseInt(folderShareHours, 10) || 24));
    setSharingFolder(true);
    try {
      const { url, expiresAt } = await createFolderShareLink(currentPath, currentGroupId || undefined, hours);
      const copied = await copyText(url);
      if (!copied) {
        window.prompt("复制分享链接", url);
      }
      addRecentShareLink({
        photoName: `folder:${currentGroupId ?? "personal"}:${currentPath}`,
        displayName: currentPath === "" ? "未分类" : `文件夹：${currentPath}`,
        url,
        expiresAt,
      });
      setShowShareFolderDialog(false);
      showToast(copied ? `文件夹分享链接已复制（到期：${formatDate(expiresAt)}）` : `文件夹分享链接已生成（到期：${formatDate(expiresAt)}），请手动复制`, "success");
    } catch (e) {
      showToast(e instanceof Error ? `创建文件夹分享失败：${e.message}` : "创建文件夹分享失败", "error");
    } finally {
      setSharingFolder(false);
    }
  };
  return (
    <div className="folder-view">
      {/* Breadcrumb */}
      <nav className="folder-breadcrumb" aria-label="folder navigation">
        {crumbs.map((crumb, i) => (
          <span key={i} className="folder-breadcrumb-item">
            {i > 0 && <span className="folder-breadcrumb-sep">›</span>}
            {i < crumbs.length - 1 ? (
              <button
                className="folder-breadcrumb-btn"
                onClick={() => setCurrentPath(crumb.path)}
              >
                {crumb.label}
              </button>
            ) : (
              <span className="folder-breadcrumb-current">{crumb.label}</span>
            )}
          </span>
        ))}
      </nav>

      {/* Toolbar */}
      <div className="folder-view-toolbar">
        {creatingFolder ? (
          <div className="folder-create-row">
            <input
              autoFocus
              className="folder-name-input"
              type="text"
              placeholder="文件夹名称"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createFolder();
                if (e.key === "Escape") setCreatingFolder(false);
              }}
              maxLength={60}
              disabled={mutationBusy}
            />
            <button className="folder-create-confirm" onClick={createFolder} disabled={mutationBusy}>确认</button>
            <button className="folder-create-cancel" onClick={() => setCreatingFolder(false)}>取消</button>
          </div>
        ) : (
          <>
            <button className="folder-new-btn" onClick={() => setCreatingFolder(true)} disabled={mutationBusy}>
              {currentPath === null ? "+ 新建文件夹" : "+ 新建子文件夹"}
            </button>
            {currentPath !== null && (
              <button className="folder-share-btn" onClick={() => setShowShareFolderDialog(true)} disabled={sharingFolder || mutationBusy}>
                {sharingFolder ? "创建中…" : "🔗 分享当前文件夹"}
              </button>
            )}
          </>
        )}
      </div>

      {showShareFolderDialog && currentPath !== null && (
        <div className="dialog-overlay" onClick={() => !sharingFolder && setShowShareFolderDialog(false)}>
          <div className="share-folder-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="add-admin-header">
              <span>分享当前文件夹</span>
              <button
                type="button"
                className="dialog-close-btn"
                onClick={() => setShowShareFolderDialog(false)}
                disabled={sharingFolder || mutationBusy}
                aria-label="关闭文件夹分享"
              >✕</button>
            </div>
            <p className="add-admin-hint">选择这个文件夹分享链接的有效期。</p>
            <div className="share-folder-summary">
              <span className="share-folder-label">当前文件夹</span>
              <strong>{currentPath === "" ? "未分类" : currentPath}</strong>
            </div>
            <div className="share-folder-field">
              <label className="share-folder-label">有效期</label>
              <div className="share-folder-options" role="radiogroup" aria-label="分享有效期">
                {[
                  { value: "1", label: "1 小时", hint: "临时分享" },
                  { value: "24", label: "24 小时", hint: "当天有效" },
                  { value: "72", label: "3 天", hint: "短期协作" },
                  { value: "168", label: "7 天", hint: "一周内访问" },
                ].map((option) => {
                  const active = folderShareHours === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`share-folder-option${active ? " active" : ""}`}
                      aria-pressed={active}
                      onClick={() => setFolderShareHours(option.value)}
                      disabled={sharingFolder || mutationBusy}
                    >
                      <span className="share-folder-option-title">{option.label}</span>
                      <span className="share-folder-option-hint">{option.hint}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="confirm-actions">
              <button className="confirm-cancel-btn" onClick={() => setShowShareFolderDialog(false)} disabled={sharingFolder}>取消</button>
              <button className="folder-share-btn" onClick={() => void handleShareCurrentFolder()} disabled={sharingFolder || mutationBusy}>
                {sharingFolder ? "创建中…" : "确认分享"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Root view: folder cards */}
      {currentPath === null ? (
        <div className="photo-grid folder-section-grid">
          {hasUncategorized && (
            <FolderCard
              name={UNCATEGORIZED}
              count={countPhotosUnder(photos, "")}
              onClick={() => setCurrentPath("")}
              onDrop={batchMutationBusy ? undefined : (photoName, fromFolder) => {
                void moveByDragWithToast(photoName, fromFolder, "");
              }}
              hasSubFolders={false}
              interactionDisabled={mutationBusy}
            />
          )}
          {displaySubFolders.map((name) => (
            <FolderCard
              key={name}
              name={name}
              count={countPhotosUnder(photos, name)}
              onClick={() => navigateTo(name)}
              onDrop={mutationBusy ? undefined : (photoName, fromFolder) => {
                void moveByDragWithToast(photoName, fromFolder, name);
              }}
              onRename={onRenameFolder ? (newName) => void handleRenameFolder(name, newName) : undefined}
              onDelete={() => void handleDeleteFolder(name)}
              hasSubFolders={getImmediateSubFolders(photos, extraFolders, name).length > 0}
              interactionDisabled={mutationBusy}
            />
          ))}
          {!hasUncategorized && displaySubFolders.length === 0 && (
            <div className="empty-gallery" style={{ gridColumn: "1 / -1" }}>
              还没有文件夹，点击「+ 新建文件夹」开始吧
            </div>
          )}
        </div>
      ) : (
        /* Inside a folder */
        <FolderContent
          key={currentPath}
          currentPath={currentPath}
          subFolders={displaySubFolders}
          directPhotos={photos.filter((p) => (p.folder?.trim() ?? "") === currentPath)}
          allPhotos={photos}
          allExtraFolders={extraFolders}
          onNavigate={navigateTo}
          onDropToSubFolder={(photoName, fromFolder, subFolderName) => {
            const target = fullFolderPath(subFolderName);
            void moveByDragWithToast(photoName, fromFolder, target);
          }}
          countPhotos={(subName) => countPhotosUnder(photos, fullFolderPath(subName))}
          allFolderPaths={allFolderPaths}
          onDelete={onDelete}
          onSubjectUpdate={onSubjectUpdate}
          onRenamePhoto={onRenamePhoto}
          onTakenAtUpdate={onTakenAtUpdate}
          onGpsUpdate={onGpsUpdate}
          onToggleFavorite={onToggleFavorite}
          onUploadToFolder={onUploadToFolder}
          uploadProgress={uploadProgress}
          onMovePhoto={onMovePhoto}
          onRenameSubFolder={onRenameFolder ? (sub, newSub) => void handleRenameFolder(sub, newSub) : undefined}
          onDeleteSubFolder={(sub) => handleDeleteFolder(sub)}
          onBatchDelete={onBatchDelete}
          onDownloadStateChange={onDownloadStateChange}
          onVoiceStateChange={onVoiceStateChange}
          onBatchMutationChange={handleBatchMutationEvent}
          batchMutationBusy={mutationBusy}
          batchMutationGate={batchMutationGate}
          onShareCreated={onShareCreated}
          onThumbnailUpdate={onThumbnailUpdate}
          userName={userName}
        />
      )}
    </div>
  );
}

// ─── FolderContent (view inside a single folder) ──────────────────────────────

interface ContentProps {
  currentPath: string;
  subFolders: string[];
  directPhotos: Photo[];
  allPhotos: Photo[];
  allExtraFolders: string[];
  onNavigate: (subFolderName: string) => void;
  onDropToSubFolder: (photoName: string, fromFolder: string, subFolderName: string) => void;
  countPhotos: (subFolderName: string) => number;
  allFolderPaths: string[];
  onDelete: (name: string) => void;
  onSubjectUpdate: (name: string, subject: string) => void;
  onRenamePhoto: (name: string, newOriginalName: string) => void;
  onTakenAtUpdate?: (name: string, takenAt: string) => void;
  onGpsUpdate?: (name: string, lat: string, lon: string) => void;
  onToggleFavorite: (name: string, favorite: boolean) => Promise<boolean>;
  onUploadToFolder: (files: FileList, folder: string, subject?: string) => Promise<void>;
  uploadProgress: FolderUploadProgress | null;
  onMovePhoto: (name: string, toFolder: string) => Promise<boolean>;
  onRenameSubFolder?: (subName: string, newSubName: string) => void;
  onDeleteSubFolder?: (sub: string) => void;
  onBatchDelete?: (names: string[]) => Promise<void>;
  onDownloadStateChange?: (downloading: boolean) => void;
  onVoiceStateChange?: (state: VoiceTransferState) => void;
  onBatchMutationChange?: (event: BatchMutationEvent) => void;
  batchMutationBusy: boolean;
  batchMutationGate: BatchMutationGate;
  onShareCreated?: (photoName: string) => void;
  onThumbnailUpdate?: (photoName: string, thumbnailUrl: string) => void;
  userName?: string;
}

function FolderContent({
  currentPath,
  subFolders,
  directPhotos,
  allPhotos,
  allExtraFolders,
  onNavigate,
  onDropToSubFolder,
  countPhotos,
  allFolderPaths,
  onDelete,
  onSubjectUpdate,
  onRenamePhoto,
  onTakenAtUpdate,
  onGpsUpdate,
  onToggleFavorite,
  onUploadToFolder,
  uploadProgress,
  onMovePhoto,
  onRenameSubFolder,
  onDeleteSubFolder,
  onBatchDelete,
  onDownloadStateChange,
  onVoiceStateChange,
  onBatchMutationChange,
  batchMutationBusy,
  batchMutationGate,
  onShareCreated,
  onThumbnailUpdate,
  userName,
}: ContentProps) {
  const showToast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCount = useRef(0);
  const touchStartX = useRef<number | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadSubject, setUploadSubject] = useState("");
  // Limit initial photo count to FOLDER_PHOTO_PREVIEW; expand on demand.
  // select-mode always shows all photos so multi-select works correctly.
  const FOLDER_PHOTO_PREVIEW = 6;
  const [showAllPhotos, setShowAllPhotos] = useState(false);

  // Modal state
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const viewerLayerRef = useRef<HTMLDivElement | null>(null);
  const viewerDialogRef = useRef<HTMLDivElement | null>(null);
  const viewerCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const originalPreviewLayerRef = useRef<HTMLDivElement | null>(null);
  const originalPreviewDialogRef = useRef<HTMLDivElement | null>(null);
  const originalPreviewCloseRef = useRef<HTMLButtonElement | null>(null);
  const {
    session: videoSession,
    videoRef,
    buffering: videoBuffering,
    error: videoError,
    eventHandlers: videoEventHandlers,
    openVideo,
    closeVideo,
    retryVideo,
  } = useResilientVideoPlayback({
    onPlayable: ({
      photoName,
      video,
      shouldCaptureThumbnail,
    }) => {
      if (
        !shouldCaptureThumbnail
        || selectedPhoto?.name !== photoName
        || selectedPhoto.thumbnailUrl
      ) {
        return;
      }
      void persistVideoPlaybackThumbnail(photoName, video).then((thumbnailUrl) => {
        if (!thumbnailUrl) return;
        onThumbnailUpdate?.(photoName, thumbnailUrl);
        setSelectedPhoto((current) => current?.name === photoName
          ? { ...current, thumbnailUrl }
          : current);
      });
    },
  });
  const [modalImageLoaded, setModalImageLoaded] = useState(false);

  const openVideoPlaybackSession = useCallback((photo: Photo) => {
    if (!photo.contentType?.startsWith("video/")) {
      closeVideo();
      return;
    }
    openVideo({
      photoName: photo.name,
      originalUrl: photo.url,
      needsThumbnailCapture: !photo.thumbnailUrl,
    });
  }, [closeVideo, openVideo]);

  useEffect(() => {
    if (!selectedPhoto) closeVideo();
  }, [closeVideo, selectedPhoto]);

  useEffect(() => {
    if (!selectedPhoto || selectedPhoto.contentType?.startsWith("video/")) return;
    const filename = selectedPhoto.originalName
      || (selectedPhoto.name.split("/").pop() ?? selectedPhoto.name).replace(/^\d+-/, "");
    const timerId = window.setTimeout(() => {
      void preloadPhotoDownload(selectedPhoto.name, filename).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timerId);
  }, [selectedPhoto?.name, selectedPhoto?.originalName]);
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
  const [showBatchTimeEdit, setShowBatchTimeEdit] = useState(false);
  const [batchTimeInput, setBatchTimeInput] = useState("");
  const [showBatchGpsEdit, setShowBatchGpsEdit] = useState(false);
  const [batchGpsLat, setBatchGpsLat] = useState("");
  const [batchGpsLon, setBatchGpsLon] = useState("");
  const { address: geoAddress, loading: geoLoading } = usePhotoLocationAddress(selectedPhoto);
  const [downloading, setDownloading] = useState(false);
  const [showOriginalPreview, setShowOriginalPreview] = useState(false);
  const [motionVideoUrl, setMotionVideoUrl] = useState<string | null>(null);
  const [motionVideoLoading, setMotionVideoLoading] = useState(false);
  const [sharing, setSharing] = useState(false);
  // Progressive GIF loading in viewer: show thumbnail immediately, upgrade to full GIF silently
  const [gifViewerSrc, setGifViewerSrc] = useState<string>("");
  const [shareHours, setShareHours] = useState("24");
  const [showSharePanel, setShowSharePanel] = useState(false);
  const [showMovePanel, setShowMovePanel] = useState(false);
  const [movingTo, setMovingTo] = useState(MOVE_UNSELECTED);
  const [quickMovePhoto, setQuickMovePhoto] = useState<Photo | null>(null);
  const [quickMoveTo, setQuickMoveTo] = useState(MOVE_UNSELECTED);
  const [showVoicePanel, setShowVoicePanel] = useState(false);
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "uploading">("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const momentsUnavailableNoticeShown = useRef(false);

  const isMyUpload = uploadProgress?.folder === currentPath;
  const anyUploading = uploadProgress !== null;

  // Batch selection
  const [selectMode, setSelectMode] = useState(false);
  // select-mode always shows all photos so the full list is selectable
  const displayedPhotos = (showAllPhotos || selectMode) ? directPhotos : directPhotos.slice(0, FOLDER_PHOTO_PREVIEW);
  const hiddenCount = directPhotos.length - FOLDER_PHOTO_PREVIEW;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchMoveTo, setBatchMoveTo] = useState(MOVE_UNSELECTED);
  const exitSelectMode = () => { setSelectMode(false); setSelected(new Set()); setBatchMoveTo(MOVE_UNSELECTED); };
  const allSelected = selected.size > 0 && selected.size === directPhotos.length;
  const toggleSelectAll = () => {
    if (allSelected) { setSelected(new Set()); } else { setSelected(new Set(directPhotos.map((p) => p.name))); }
  };
  const [showBatchConfirm, setShowBatchConfirm] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function executeBatchMutation<T>(
    kind: BatchMutationKind,
    items: readonly T[],
    worker: (item: T, index: number) => Promise<boolean | void>,
    options?: { concurrency?: number },
  ): Promise<BatchMutationResult | null> {
    if (batchMutationBusy && batchMutationGate.current === null) return null;
    const operationId = `folder-${++folderBatchMutationSequence}`;
    return runBatchMutationBoundary({
      gate: batchMutationGate,
      operation: { id: operationId, kind, done: 0, total: items.length, failed: 0 },
      items,
      worker,
      concurrency: options?.concurrency,
      onEvent: onBatchMutationChange,
    });
  }

  const selectedTotalSize = useMemo(() => {
    const bytes = directPhotos.filter((p) => selected.has(p.name)).reduce((sum, p) => sum + (p.size ?? 0), 0);
    if (bytes === 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }, [selected, directPhotos]);

  useEffect(() => {
    onDownloadStateChange?.(downloading);
    return () => onDownloadStateChange?.(false);
  }, [downloading, onDownloadStateChange]);

  useEffect(() => {
    onVoiceStateChange?.(voiceState);
    return () => onVoiceStateChange?.("idle");
  }, [onVoiceStateChange, voiceState]);

  const requestNewFolderTarget = (): string | null => {
    const raw = prompt("请输入新文件夹名称（会创建在当前目录下）");
    if (raw == null) return null;
    const name = raw.trim();
    if (!name) {
      showToast("文件夹名不能为空", "error");
      return null;
    }
    if (name.includes("/")) {
      showToast("文件夹名不能包含 /", "error");
      return null;
    }
    return currentPath === "" ? name : `${currentPath}/${name}`;
  };

  const resolveMoveTarget = (value: string): string | null => {
    if (value === MOVE_UNSELECTED) return null;
    if (value !== MOVE_CREATE) return value;
    return requestNewFolderTarget();
  };

  const trackPhotoView = useCallback((photoName: string) => {
    void recordMomentViewApi(photoName, userName).catch((error) => {
      if (error instanceof ManagedMomentsUnavailableError && !momentsUnavailableNoticeShown.current) {
        momentsUnavailableNoticeShown.current = true;
        showToast("照片浏览量暂时不可持久化，稍后会继续尝试同步", "info");
      }
    });
  }, [showToast, userName]);

  // Navigate to a photo by index, resetting all edit state
  const navigateToPhoto = useCallback((idx: number, photoList: Photo[]) => {
    const photo = photoList[idx];
    if (!photo) return;
    trackPhotoView(photo.name);
    setSelectedIdx(idx);
    setSelectedPhoto(photo);
    openVideoPlaybackSession(photo);
    setEditingSubject(false);
    setSubjectInput(photo.subject ?? "");
    setEditingName(false);
    setNameInput(getEditablePhotoName(photo));
    setEditingTakenAt(false);
    setEditingGps(false);
    setShowMovePanel(false);
    setMovingTo(MOVE_UNSELECTED);
    setShowOriginalPreview(false);
    setDownloading(false);
    setShowSharePanel(false);
    setShowVoicePanel(false);
    setVoiceState("idle");
    setVoiceError(null);
    setMotionVideoUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    setMotionVideoLoading(false);
    setModalImageLoaded(false);
    setGifViewerSrc("");
  }, [openVideoPlaybackSession, trackPhotoView]);

  // Show a persisted derivative immediately, then swap to the animated source.
  useEffect(() => {
    if (!selectedPhoto) return;
    const isGifFormat = selectedPhoto.contentType === "image/gif";
    const isOtherAnimated = selectedPhoto.isAnimated &&
      selectedPhoto.contentType !== "image/jpeg" &&
      selectedPhoto.contentType !== "image/jpg" &&
      !isGifFormat;
    if (!isGifFormat && !isOtherAnimated) return;
    if (!selectedPhoto.thumbnailUrl) return;
    setGifViewerSrc(getPreferredMediaUrl(selectedPhoto.thumbnailUrl));
    if (isGifFormat) {
      const controller = new AbortController();
      void preloadImageWithFallback([selectedPhoto.url], controller.signal)
        .then(setGifViewerSrc)
        .catch((error: unknown) => {
          if (!(error instanceof Error && error.name === "AbortError")) {
            setGifViewerSrc(getPreferredMediaUrl(selectedPhoto.url));
          }
        });
      return () => controller.abort();
    } else {
      // Non-GIF animated (phone 动图: animated WebP/HEIF/AVIF): stream directly
      const t = window.setTimeout(() => setGifViewerSrc(getPreferredMediaUrl(selectedPhoto.url)), 0);
      return () => window.clearTimeout(t);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPhoto?.url, selectedPhoto?.thumbnailUrl, selectedPhoto?.contentType, selectedPhoto?.isAnimated]);

  const closeViewer = useCallback(() => {
    setSelectedIdx(null);
    setSelectedPhoto(null);
    setShowOriginalPreview(false);
  }, []);
  const onModalKeyDown = useCallback((event: KeyboardEvent) => {
    if (isModalShortcutTarget(event.target)) return;
    if (event.key === "ArrowLeft" && selectedIdx !== null && selectedIdx > 0) {
      event.preventDefault();
      navigateToPhoto(selectedIdx - 1, directPhotos);
    }
    if (event.key === "ArrowRight" && selectedIdx !== null && selectedIdx < directPhotos.length - 1) {
      event.preventDefault();
      navigateToPhoto(selectedIdx + 1, directPhotos);
    }
  }, [directPhotos, navigateToPhoto, selectedIdx]);

  useModalFocusBoundary({
    active: selectedPhoto !== null,
    layerRef: viewerLayerRef,
    containerRef: viewerDialogRef,
    initialFocusRef: viewerCloseButtonRef,
    onEscape: (event) => {
      if (isModalShortcutTarget(event.target)) return false;
      closeViewer();
      return true;
    },
    onKeyDown: onModalKeyDown,
  });

  useModalFocusBoundary({
    active: showOriginalPreview && selectedPhoto !== null,
    layerRef: originalPreviewLayerRef,
    containerRef: originalPreviewDialogRef,
    initialFocusRef: originalPreviewCloseRef,
    onEscape: () => {
      setShowOriginalPreview(false);
      return true;
    },
  });

  const toggleSelect = (name: string) => {
    setSelected((prev) => { const next = new Set(prev); next.has(name) ? next.delete(name) : next.add(name); return next; });
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
  const handleBatchMove = async () => {
    const target = resolveMoveTarget(batchMoveTo);
    if (!target) return;
    const names = [...selected];
    const result = await executeBatchMutation(
      "move",
      names,
      (name) => onMovePhoto(name, target),
      { concurrency: 4 },
    );
    if (!result || !mountedRef.current) return;
    if (result.failed > 0) {
      showToast(`批量移动完成，成功 ${result.total - result.failed} 张，失败 ${result.failed} 张`, "error");
    } else {
      showToast(`已移动 ${result.total} 张照片`, "success");
    }
    exitSelectMode();
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

    const selectedList = directPhotos.filter((p) => selected.has(p.name));
    const result = await executeBatchMutation("rename", selectedList, async (p, i) => {
      const nextName = buildRenamedPhotoName(p, `${safePrefix}-${String(start + i).padStart(3, "0")}`);
      await apiRenamePhoto(p.name, nextName, userName);
      onRenamePhoto(p.name, nextName);
    });
    if (!result || !mountedRef.current) return;
    if (result.failed > 0) showToast(`批量重命名完成，失败 ${result.failed} 张`, "error");
    else showToast(`已重命名 ${selectedList.length} 张照片`, "success");
  };

  const handleBatchSetTakenAt = async () => {
    if (!batchTimeInput || selected.size === 0) return;
    const d = new Date(batchTimeInput);
    if (isNaN(d.getTime())) { showToast("无效的日期时间", "error"); return; }
    const pad = (n: number) => String(n).padStart(2, "0");
    const naive = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const selectedList = directPhotos.filter((p) => selected.has(p.name));
    const result = await executeBatchMutation("time", selectedList, async (p) => {
      await updatePhotoTakenAt(p.name, naive, userName);
      onTakenAtUpdate?.(p.name, naive);
    });
    if (!result || !mountedRef.current) return;
    setShowBatchTimeEdit(false);
    setBatchTimeInput("");
    if (result.failed > 0) showToast(`批量修改时间完成，失败 ${result.failed} 张`, "error");
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
    const selectedList = directPhotos.filter((p) => selected.has(p.name));
    const result = await executeBatchMutation("location", selectedList, async (p) => {
      await updatePhotoGps(p.name, effectiveLat, effectiveLon);
      onGpsUpdate?.(p.name, effectiveLat, effectiveLon);
    });
    if (!result || !mountedRef.current) return;
    setShowBatchGpsEdit(false);
    setBatchGpsLat("");
    setBatchGpsLon("");
    if (result.failed > 0) showToast(`批量修改位置完成，失败 ${result.failed} 张`, "error");
    else showToast(`已修改 ${selectedList.length} 张照片的位置`, "success");
  };

  const openModal = (photo: Photo) => {
    const idx = directPhotos.findIndex((p) => p.name === photo.name);
    trackPhotoView(photo.name);
    setSelectedIdx(idx >= 0 ? idx : null);
    setSelectedPhoto(photo);
    openVideoPlaybackSession(photo);
    setEditingSubject(false);
    setSubjectInput(photo.subject ?? "");
    setEditingName(false);
    setNameInput(getEditablePhotoName(photo));
    setEditingTakenAt(false);
    setEditingGps(false);
    setShowMovePanel(false);
    setMovingTo(MOVE_UNSELECTED);
    setShowOriginalPreview(false);
    setDownloading(false);
    setShowSharePanel(false);
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
      const iso = new Date(isoStr).toISOString();
      await updatePhotoTakenAt(selectedPhoto.name, iso, userName);
      onTakenAtUpdate?.(selectedPhoto.name, iso);
      setSelectedPhoto({ ...selectedPhoto, takenAt: iso });
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
    } catch {
      showToast("更新位置失败", "error");
    } finally {
      setSavingGps(false);
    }
  };

  const handleDownload = async () => {
    if (!selectedPhoto) return;
    setDownloading(true);
    try {
      const filename = selectedPhoto.originalName
        || (selectedPhoto.name.split("/").pop() ?? selectedPhoto.name).replace(/^\d+-/, "");
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
      addRecentShareLink({
        photoName: selectedPhoto.name,
        displayName: displayName(selectedPhoto),
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
    if (!window.confirm(`确认删除照片：${displayName(selectedPhoto)}？`)) return;
    onDelete(selectedPhoto.name);
    setSelectedIdx(null);
    setSelectedPhoto(null);
  };

  const handleMove = async () => {
    if (!selectedPhoto) return;
    const target = resolveMoveTarget(movingTo);
    if (!target) return;
    await onMovePhoto(selectedPhoto.name, target);
    showToast(`已移动到「${target || UNCATEGORIZED}」`, "success");
    setSelectedIdx(null);
    setSelectedPhoto(null);
  };

  const handleQuickMove = async () => {
    if (!quickMovePhoto) return;
    const target = resolveMoveTarget(quickMoveTo);
    if (!target) return;
    const ok = await onMovePhoto(quickMovePhoto.name, target);
    if (ok) {
      showToast(`已移动到「${target || UNCATEGORIZED}」`, "success");
      setQuickMovePhoto(null);
      setQuickMoveTo(MOVE_UNSELECTED);
    }
  };

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    await onUploadToFolder(e.target.files, currentPath, uploadSubject || undefined);
    e.target.value = "";
  };

  const displayName = (p: Photo) => {
    if (p.originalName) return p.originalName;
    const basename = p.name.split("/").pop() ?? p.name;
    return basename.replace(/^\d+-/, "");
  };
  const selectedVideoPoster = selectedPhoto?.thumbnailUrl ?? selectedPhoto?.previewUrl;
  const selectedVideoRender = selectedPhoto
    && videoSession?.photoName === selectedPhoto.name
    ? {
        session: videoSession,
        ...getVideoPlaybackRenderState(videoSession, selectedVideoPoster),
      }
    : null;

  const moveByDragWithToast = async (photoName: string, fromFolder: string, toFolder: string) => {
    if (fromFolder === toFolder) return;
    const ok = await onMovePhoto(photoName, toFolder);
    if (ok) {
      showToast(`已移动到「${toFolder || UNCATEGORIZED}」`, "success");
    }
  };

  return (
    <section
      className={`folder-section${isDragOver ? " folder-drag-over" : ""}`}
      style={isDragOver ? { outline: "2px dashed #4a90e2", borderRadius: "8px" } : undefined}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
      onDragEnter={(e) => { e.preventDefault(); dragCount.current++; setIsDragOver(true); }}
      onDragLeave={() => { dragCount.current--; if (dragCount.current === 0) setIsDragOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        dragCount.current = 0;
        setIsDragOver(false);
        if (batchMutationBusy) return;
        const name = e.dataTransfer.getData("photoName");
        const from = e.dataTransfer.getData("fromFolder");
        if (name) void moveByDragWithToast(name, from, currentPath);
      }}
    >
      {directPhotos.length > 0 && (
        <BatchOperationsBar
          busy={batchMutationBusy}
          className="gallery-batch-toolbar--folder"
          selectMode={selectMode}
          onToggleSelectMode={() => { setSelectMode((v) => !v); setSelected(new Set()); }}
          selectedCount={selected.size}
          selectedTotalSize={selectedTotalSize}
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
          extraToolbarActions={
            <>
              {selectMode && selected.size > 0 && (
                <>
                  <select
                    className="modal-move-select"
                    value={batchMoveTo}
                    onChange={(e) => setBatchMoveTo(e.target.value)}
                    disabled={batchMutationBusy}
                  >
                    <option value={MOVE_UNSELECTED}>移动到…</option>
                    <option value={MOVE_CREATE}>+ 新建文件夹…</option>
                    {allFolderPaths.map((f) => (
                      <option key={f} value={f}>{f === "" ? "(未分类)" : f}</option>
                    ))}
                  </select>
                  {batchMoveTo !== MOVE_UNSELECTED && (
                    <button className="batch-select-btn" onClick={() => void handleBatchMove()} disabled={batchMutationBusy}>确认移动</button>
                  )}
                </>
              )}
              <button
                className="batch-select-btn"
                style={{ marginLeft: "auto", opacity: anyUploading || batchMutationBusy ? 0.5 : 1 }}
                onClick={() => !anyUploading && !batchMutationBusy && inputRef.current?.click()}
                title="上传原图到当前文件夹"
                disabled={anyUploading || batchMutationBusy}
              >
                {isMyUpload && uploadProgress
                  ? `⏳ ${uploadProgress.filesSettled}/${uploadProgress.filesTotal}`
                  : "+ 添加原图"}
              </button>
            </>
          }
        />
      )}

      <div className="photo-grid folder-section-grid">
        {/* Sub-folder cards first */}
        {subFolders.map((sub) => {
          const subFullPath = currentPath === "" ? sub : `${currentPath}/${sub}`;
          return (
            <FolderCard
              key={sub}
              name={sub}
              count={countPhotos(sub)}
              onClick={() => onNavigate(sub)}
              onDrop={batchMutationBusy ? undefined : (photoName, fromFolder) => onDropToSubFolder(photoName, fromFolder, sub)}
              onRename={onRenameSubFolder ? (newSub) => onRenameSubFolder(sub, newSub) : undefined}
              onDelete={onDeleteSubFolder ? () => onDeleteSubFolder(sub) : undefined}
              hasSubFolders={getImmediateSubFolders(allPhotos, allExtraFolders, subFullPath).length > 0}
              interactionDisabled={batchMutationBusy}
            />
          );
        })}

        {/* Photos — limited to FOLDER_PHOTO_PREVIEW unless expanded */}
        {displayedPhotos.map((photo, index) => (
          <PhotoCard
            key={photo.name}
            photo={photo}
            priority={index < GALLERY_EAGER_MEDIA_COUNT}
            onClick={() => !selectMode && openModal(photo)}
            onDelete={() => onDelete(photo.name)}
            onToggleFavorite={(next) => { void onToggleFavorite(photo.name, next); }}
            onThumbnailUpdate={onThumbnailUpdate}
            onMoveRequest={!selectMode ? () => {
              setQuickMovePhoto(photo);
              setQuickMoveTo(MOVE_UNSELECTED);
            } : undefined}
            selected={selectMode ? selected.has(photo.name) : undefined}
            onSelect={selectMode ? (e) => {
              e.stopPropagation();
              if (!batchMutationBusy) toggleSelect(photo.name);
            } : undefined}
            interactionDisabled={batchMutationBusy}
            draggable={!selectMode && !batchMutationBusy}
            onDragStart={(e) => {
              e.dataTransfer.setData("photoName", photo.name);
              e.dataTransfer.setData("fromFolder", currentPath);
              e.dataTransfer.effectAllowed = "move";
            }}
          />
        ))}

        {/* Upload group */}
        <div className="folder-upload-group">
          <input
            className="folder-upload-subject"
            type="text"
            placeholder="主题（可选）"
            value={uploadSubject}
            onChange={(e) => setUploadSubject(e.target.value)}
            maxLength={80}
            disabled={batchMutationBusy}
          />
          <div
            className={`folder-upload-card${anyUploading ? " folder-upload-card--loading" : ""}`}
            onClick={() => !anyUploading && !batchMutationBusy && inputRef.current?.click()}
            title="上传原图到当前文件夹"
            role="button"
            aria-disabled={anyUploading || batchMutationBusy}
          >
            {isMyUpload && uploadProgress ? (
              <>
                <span className="folder-upload-icon">⏳</span>
                <span className="folder-upload-label">{uploadProgress.filesSettled}/{uploadProgress.filesTotal}</span>
              </>
            ) : (
              <>
                <span className="folder-upload-icon">{anyUploading ? "⏳" : "+"}</span>
                <span className="folder-upload-label">添加原图</span>
              </>
            )}
            <input ref={inputRef} type="file" accept="image/*,video/*" multiple style={{ display: "none" }} onChange={handleFiles} disabled={batchMutationBusy} />
          </div>
        </div>

        {subFolders.length === 0 && directPhotos.length === 0 && (
          <div className="empty-gallery" style={{ gridColumn: "1 / -1" }}>
            空文件夹 — 上传照片或创建子文件夹
          </div>
        )}
      </div>

      {/* Show-more row: visible when photos are capped and not in select mode */}
      {!showAllPhotos && !selectMode && hiddenCount > 0 && (
        <button
          className="folder-show-more-btn"
          onClick={() => setShowAllPhotos(true)}
        >
          查看剩余 {hiddenCount} 张照片
        </button>
      )}

      {/* ── Modal ── */}
      {selectedPhoto && createPortal(
        <div ref={viewerLayerRef} className="modal-overlay" data-modal-layer onClick={closeViewer}>
          <div
            ref={viewerDialogRef}
            className="modal-content"
            role="dialog"
            aria-modal="true"
            aria-label={`照片详情：${displayName(selectedPhoto)}`}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
          <div className="modal-image-pane"
              onTouchStart={(e) => { touchStartX.current = e.touches[0].clientX; }}
              onTouchEnd={(e) => {
                if (touchStartX.current === null || selectedIdx === null) return;
                const dx = e.changedTouches[0].clientX - touchStartX.current;
                touchStartX.current = null;
                if (Math.abs(dx) < 50) return;
                if (dx < 0 && selectedIdx < directPhotos.length - 1) navigateToPhoto(selectedIdx + 1, directPhotos);
                if (dx > 0 && selectedIdx > 0) navigateToPhoto(selectedIdx - 1, directPhotos);
              }}
            >
              {/* Prev / Next navigation */}
              {selectedIdx !== null && selectedIdx > 0 && (
                <button
                  type="button"
                  className="modal-nav modal-nav--prev"
                  onClick={() => navigateToPhoto(selectedIdx - 1, directPhotos)}
                  aria-label="上一张"
                  title="上一张 (←)"
                >
                  ‹
                </button>
              )}
              {selectedIdx !== null && selectedIdx < directPhotos.length - 1 && (
                <button
                  type="button"
                  className="modal-nav modal-nav--next"
                  onClick={() => navigateToPhoto(selectedIdx + 1, directPhotos)}
                  aria-label="下一张"
                  title="下一张 (→)"
                >
                  ›
                </button>
              )}
              {selectedPhoto.contentType?.startsWith("video/") ? (
                <div className="modal-video-wrap">
                  {selectedVideoRender && <video
                    ref={videoRef}
                    key={selectedVideoRender.key}
                    crossOrigin="anonymous"
                    src={selectedVideoRender.source}
                    poster={selectedVideoRender.poster}
                    className="modal-image modal-video"
                    controls
                    playsInline
                    preload="auto"
                    {...videoEventHandlers}
                  />}
                  {videoBuffering && !videoError && (
                    <div className="modal-video-spinner">
                      <div className="modal-video-spinner-ring" />
                      <span>加载中…</span>
                    </div>
                  )}
                  {videoError && (
                    <div className="modal-video-spinner" style={{ gap: 8 }}>
                      <span style={{ fontSize: 28 }}>⚠️</span>
                      <span style={{ fontSize: 13 }}>视频加载失败</span>
                      <button
                        style={{ marginTop: 4, padding: "4px 14px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.4)", background: "rgba(255,255,255,0.15)", color: "#fff", cursor: "pointer", fontSize: 13 }}
                        onClick={retryVideo}
                      >重试</button>
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
                          src={getPreferredMediaUrl(selectedPhoto.previewUrl ?? selectedPhoto.thumbnailUrl ?? selectedPhoto.url)}
                          alt={displayName(selectedPhoto)}
                          className="modal-image modal-image--gif"
                          onClick={() => setShowOriginalPreview(true)}
                          title="点击预览原图"
                          onError={(event) => {
                            fallbackMediaSource(event.currentTarget, [
                              selectedPhoto.previewUrl,
                              selectedPhoto.thumbnailUrl,
                              selectedPhoto.url,
                            ]);
                          }}
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
                      key={gifViewerSrc || selectedPhoto.url}
                      src={gifViewerSrc || selectedPhoto.url}
                      alt={displayName(selectedPhoto)}
                      className="modal-image modal-image--gif"
                      onClick={() => setShowOriginalPreview(true)}
                      title="点击预览原图"
                      onError={(event) => {
                        fallbackMediaSource(event.currentTarget, [gifViewerSrc, selectedPhoto.url]);
                      }}
                    />
                  )}
                  <span className="modal-gif-badge">
                    {(selectedPhoto.contentType === "image/jpeg" || selectedPhoto.contentType === "image/jpg") && selectedPhoto.isAnimated
                      ? (motionVideoUrl ? "动态照片 ▶ 播放中" : "动态照片 📱")
                      : gifViewerSrc && gifViewerSrc !== selectedPhoto.url && selectedPhoto.thumbnailUrl
                        ? "🎥 加载动图中…"
                        : "动图 ▶ 循环播放"}
                  </span>
                </>
              ) : (
                <>
                  {/* A cached derivative stays visible while the 2048px preview loads. */}
                  {!modalImageLoaded && (selectedPhoto.thumbnailUrl ?? selectedPhoto.previewUrl) && (
                    <img
                      src={getPreferredMediaUrl(selectedPhoto.thumbnailUrl ?? selectedPhoto.previewUrl!)}
                      alt=""
                      aria-hidden="true"
                      className="modal-image modal-image--placeholder"
                      onError={(event) => {
                        fallbackMediaSource(event.currentTarget, [selectedPhoto.thumbnailUrl, selectedPhoto.previewUrl]);
                      }}
                    />
                  )}
                  {/* Spinner only when there is no thumbnail to show */}
                  {!modalImageLoaded && !selectedPhoto.thumbnailUrl && !selectedPhoto.previewUrl && <div className="modal-image-spinner" />}
                  <img
                    src={getViewerSrc(selectedPhoto)}
                    fetchPriority="high"
                    alt={displayName(selectedPhoto)}
                    className={`modal-image${modalImageLoaded ? " modal-image--fadein" : " modal-image--loading"}`}
                    onClick={() => setShowOriginalPreview(true)}
                    title="点击预览原图"
                    onLoad={() => setModalImageLoaded(true)}
                    onError={(event) => {
                      fallbackMediaSource(event.currentTarget, [
                        getViewerSrc(selectedPhoto),
                        selectedPhoto.previewUrl,
                        selectedPhoto.thumbnailUrl,
                        selectedPhoto.url,
                      ]);
                    }}
                  />
                </>
              )}
              {directPhotos.length > 1 && (
                <div className="modal-nav-hint">← → 切换 · Esc 关闭</div>
              )}
            </div>
            <button
              ref={viewerCloseButtonRef}
              type="button"
              className="modal-close"
              onClick={closeViewer}
              aria-label="关闭照片详情"
              title="关闭 (Esc)"
            >✕</button>
            {selectedIdx !== null && (
              <span className="modal-nav-counter">{selectedIdx + 1} / {directPhotos.length}</span>
            )}
            <div className="modal-info">

              {/* Filename row with rename */}
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
                    <button type="button" className="modal-subject-cancel" onClick={() => setEditingName(false)} aria-label="取消重命名">✕</button>
                  </span>
                ) : (
                  <span className="modal-filename">
                    <span className="modal-filename-text" title={displayName(selectedPhoto)}>
                      {displayName(selectedPhoto)}
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
                <button
                  className={`modal-action-btn${showMovePanel ? " modal-action-btn--active" : ""}`}
                  onClick={() => setShowMovePanel((v) => !v)}
                >
                  📁 移动
                </button>
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

              {showVoicePanel && (
                <div className="modal-panel-box">
                  {selectedPhoto.voiceMemoUrl ? (
                    <div className="modal-voice-section">
                      <audio
                        controls
                        src={selectedPhoto.voiceMemoUrl}
                        className="modal-voice-player"
                        onError={(event) => {
                          fallbackMediaSource(event.currentTarget, [selectedPhoto.voiceMemoUrl]);
                        }}
                      />
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
                {/* Subject */}
                <span className="modal-detail-label">主题</span>
                <span className="modal-detail-value modal-subject-cell">
                  {editingSubject ? (
                    <>
                      <input
                        autoFocus
                        className="modal-subject-input"
                        value={subjectInput}
                        onChange={(e) => setSubjectInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveSubject();
                          if (e.key === "Escape") setEditingSubject(false);
                        }}
                        placeholder="添加主题..."
                        maxLength={80}
                      />
                      <button className="modal-subject-save" onClick={() => void saveSubject()} disabled={savingSubject}>
                        {savingSubject ? "..." : "保存"}
                      </button>
                      <button type="button" className="modal-subject-cancel" onClick={() => setEditingSubject(false)} aria-label="取消编辑主题">✕</button>
                    </>
                  ) : (
                    <>
                      <span>{selectedPhoto.subject || <em className="modal-empty">无</em>}</span>
                      <button type="button" className="modal-edit-btn" onClick={() => setEditingSubject(true)} aria-label="编辑主题">✏</button>
                    </>
                  )}
                </span>

                {/* Folder + move */}
                <span className="modal-detail-label">文件夹</span>
                <span className="modal-detail-value modal-subject-cell">
                  {showMovePanel ? (
                    <>
                      <select
                        className="modal-move-select"
                        value={movingTo}
                        onChange={(e) => setMovingTo(e.target.value)}
                      >
                        <option value={MOVE_UNSELECTED} disabled>— 选择目标文件夹 —</option>
                        <option value={MOVE_CREATE}>+ 新建文件夹…</option>
                        <option value="">{UNCATEGORIZED}</option>
                        {allFolderPaths.filter((fp) => fp !== "" && fp !== currentPath).map((fp) => (
                          <option key={fp} value={fp}>{fp}</option>
                        ))}
                      </select>
                      <button
                        className="modal-subject-save"
                        onClick={() => void handleMove()}
                        disabled={movingTo === MOVE_UNSELECTED}
                      >
                        移动
                      </button>
                      <button type="button" className="modal-subject-cancel" onClick={() => setShowMovePanel(false)} aria-label="取消移动">✕</button>
                    </>
                  ) : (
                    <>
                      <span>{selectedPhoto.folder || UNCATEGORIZED}</span>
                      <button type="button" className="modal-edit-btn" aria-label="移动到其他文件夹" title="移动到其他文件夹" onClick={() => setShowMovePanel(true)}>→</button>
                    </>
                  )}
                </span>

                <span className="modal-detail-label">拍摄时间</span>
                <span className="modal-detail-value modal-subject-cell">
                  <span>{selectedPhoto.takenAt ? formatDate(selectedPhoto.takenAt) : <em className="modal-empty">未记录</em>}</span>
                  <button type="button" className="modal-edit-btn" onClick={() => setEditingTakenAt(true)} aria-label="修改拍摄时间">✏</button>
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
                <span className="modal-detail-label">最后修改者</span>
                <span className="modal-detail-value">{selectedPhoto.lastModifiedBy ?? "—"}</span>
                <span className="modal-detail-label">最后修改时间</span>
                <span className="modal-detail-value">
                  {selectedPhoto.lastModifiedAt
                    ? formatDate(selectedPhoto.lastModifiedAt)
                    : selectedPhoto.lastModified
                    ? formatDate(selectedPhoto.lastModified)
                    : "—"}
                </span>
                <span className="modal-detail-label">格式</span>
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
                          aria-label="在 Google 地图中查看"
                          title="在 Google 地图中查看"
                        >🗺</a>
                        <button
                          type="button"
                          className="modal-edit-btn"
                          aria-label={editingGps ? "关闭位置搜索" : "修改位置"}
                          title={editingGps ? "关闭位置搜索" : "修改位置"}
                          onClick={() => setEditingGps((v) => !v)}
                        >{editingGps ? "✕" : "✏"}</button>
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
                        <button
                          type="button"
                          className="modal-edit-btn"
                          aria-label={editingGps ? "关闭位置搜索" : "添加位置"}
                          title={editingGps ? "关闭位置搜索" : "添加位置"}
                          onClick={() => setEditingGps((v) => !v)}
                        >{editingGps ? "✕" : "+ 添加"}</button>
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
              </div>
            </div>
            </div>
        </div>,
        document.body,
      )}

      {selectedPhoto && showOriginalPreview && createPortal(
        <div ref={originalPreviewLayerRef} className="modal-preview-overlay" data-modal-layer onClick={() => setShowOriginalPreview(false)}>
          <div
            ref={originalPreviewDialogRef}
            className="modal-preview-content"
            role="dialog"
            aria-modal="true"
            aria-label="原图预览"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <button ref={originalPreviewCloseRef} type="button" className="modal-close" onClick={() => setShowOriginalPreview(false)} aria-label="关闭原图预览">✕</button>
            <a className="modal-preview-open" href={getPreferredMediaUrl(selectedPhoto.url)} target="_blank" rel="noreferrer">
              在新窗口打开原图
            </a>
            <img
              src={getPreferredMediaUrl(selectedPhoto.url)}
              alt={displayName(selectedPhoto)}
              className="modal-preview-image"
              onError={(event) => {
                fallbackMediaSource(event.currentTarget, [selectedPhoto.url]);
              }}
            />
          </div>
        </div>,
        document.body,
      )}

      {quickMovePhoto && (
        <div className="confirm-overlay" onClick={() => { setQuickMovePhoto(null); setQuickMoveTo(MOVE_UNSELECTED); }}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-title">移动照片</p>
            <p className="confirm-filename">{displayName(quickMovePhoto)}</p>
            <select
              className="modal-move-select quick-move-select"
              value={quickMoveTo}
              onChange={(e) => setQuickMoveTo(e.target.value)}
            >
              <option value={MOVE_UNSELECTED} disabled>— 选择目标文件夹 —</option>
              <option value={MOVE_CREATE}>+ 新建文件夹…</option>
              {currentPath !== "" && <option value="">{UNCATEGORIZED}</option>}
              {allFolderPaths.filter((fp) => fp !== "" && fp !== currentPath).map((fp) => (
                <option key={fp} value={fp}>{fp}</option>
              ))}
            </select>
            <div className="confirm-actions">
              <button className="confirm-cancel-btn" onClick={() => { setQuickMovePhoto(null); setQuickMoveTo(MOVE_UNSELECTED); }}>取消</button>
              <button className="confirm-delete-btn" disabled={quickMoveTo === MOVE_UNSELECTED} onClick={() => void handleQuickMove()}>移动</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatSize(bytes: number | undefined): string {
  if (bytes == null) return "";
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
