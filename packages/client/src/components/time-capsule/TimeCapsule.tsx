import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Photo } from "../../services/photoApi";
import { useToast } from "../../contexts/ToastContext";
import {
  addLocalCalendarDays,
  getPhotoCalendarDayDistance,
  getLocalCalendarDateKey,
} from "../../utils/dateFormat";
import {
  advanceIncrementalWindow,
  createIncrementalRenderWindow,
  resolveIncrementalVisibleCount,
} from "../shared/incrementalRenderWindow";
import MediaThumb from "../shared/MediaThumb";
import { useModalFocusBoundary } from "../shared/useModalFocusBoundary";
import {
  Capsule,
  MAX_CAPSULES,
  MAX_CAPSULE_PHOTOS,
  MAX_TITLE_LENGTH,
  loadCapsulesFromStorage,
  normalizeCapsules,
  removeLegacyCapsules,
  saveCapsulesToStorage,
} from "./capsuleStorage";

interface Props {
  photos: Photo[];
  userId: string;
  workspaceKey: string;
  onViewPhoto?: (name: string) => void;
}

export default function TimeCapsule({ photos, userId, workspaceKey, onViewPhoto }: Props) {
  const showToast = useToast();
  const createLayerRef = useRef<HTMLDivElement | null>(null);
  const createDialogRef = useRef<HTMLDivElement | null>(null);
  const capsuleTitleInputRef = useRef<HTMLInputElement | null>(null);
  const capsulePhotoGridRef = useRef<HTMLDivElement | null>(null);
  const capsulePhotoSentinelRef = useRef<HTMLDivElement | null>(null);
  const viewLayerRef = useRef<HTMLDivElement | null>(null);
  const viewDialogRef = useRef<HTMLDivElement | null>(null);
  const viewCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const initialLoadRef = useRef<ReturnType<typeof loadCapsulesFromStorage> | null>(null);
  if (initialLoadRef.current === null) {
    initialLoadRef.current = loadCapsulesFromStorage(localStorage, userId, workspaceKey);
  }
  const initialLoad = initialLoadRef.current;
  const [capsules, setCapsules] = useState<Capsule[]>(initialLoad.capsules);
  const [storageError, setStorageError] = useState<string | null>(
    initialLoad.error ? "无法读取时光胶囊，本次更改不会被静默保存。" : null,
  );
  const [showCreate, setShowCreate] = useState(false);
  const showCreateRef = useRef(showCreate);
  showCreateRef.current = showCreate;
  const [openedCapsuleId, setOpenedCapsuleId] = useState<string | null>(null);

  // Create form state
  const [title, setTitle] = useState("");
  const [unlockDate, setUnlockDate] = useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return getLocalCalendarDateKey(d);
  });
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [folderFilter, setFolderFilter] = useState("");
  const [photoRenderWindow, setPhotoRenderWindow] = useState(createIncrementalRenderWindow);
  const [photoScrollState, setPhotoScrollState] = useState({ sourceKey: "", scrolled: false });
  const migrationHandledRef = useRef(false);

  const now = new Date();
  const today = getLocalCalendarDateKey(now);
  const minimumUnlockDate = addLocalCalendarDays(now, 1);

  const folders = useMemo(
    () => [...new Set(photos.map((p) => (p.folder ?? "").trim()).filter(Boolean))].sort(),
    [photos],
  );

  const displayPhotos = useMemo(
    () =>
      folderFilter
        ? photos.filter((p) => (p.folder ?? "").trim() === folderFilter)
        : photos.slice(0, 60),
    [photos, folderFilter],
  );
  const displayPhotoSourceKey = useMemo(
    () => `${folderFilter}\u0000${displayPhotos.map((photo) => photo.name).join("\u0000")}`,
    [displayPhotos, folderFilter],
  );
  const displayPhotoSourceKeyRef = useRef(displayPhotoSourceKey);
  displayPhotoSourceKeyRef.current = displayPhotoSourceKey;
  const committedPhotoSourceKeyRef = useRef(displayPhotoSourceKey);

  const focusedPhotoIndex = (() => {
    if (typeof document === "undefined") return -1;
    const activeElement = document.activeElement;
    const scrollRoot = capsulePhotoGridRef.current;
    if (!(activeElement instanceof HTMLElement) || !scrollRoot?.contains(activeElement)) return -1;
    const focusedName = activeElement.dataset.capsulePhotoName;
    return focusedName ? displayPhotos.findIndex((photo) => photo.name === focusedName) : -1;
  })();
  const visiblePhotoCount = resolveIncrementalVisibleCount(
    photoRenderWindow,
    displayPhotoSourceKey,
    displayPhotos.length,
    focusedPhotoIndex,
  );
  const visibleDisplayPhotos = useMemo(
    () => displayPhotos.slice(0, visiblePhotoCount),
    [displayPhotos, visiblePhotoCount],
  );
  const hasMoreDisplayPhotos = visiblePhotoCount < displayPhotos.length;
  const photoGridHasScrolled = (
    photoScrollState.sourceKey === displayPhotoSourceKey
    && photoScrollState.scrolled
  );

  useEffect(() => {
    if (migrationHandledRef.current) return;
    migrationHandledRef.current = true;
    if (initialLoad.error) {
      showToast("无法读取时光胶囊，请检查浏览器存储权限。", "error");
      return;
    }
    if (initialLoad.discardedInvalidData) {
      showToast("已忽略损坏或不安全的时光胶囊数据。", "info");
    }
    if (!initialLoad.needsMigration) return;
    try {
      saveCapsulesToStorage(localStorage, userId, workspaceKey, initialLoad.capsules);
      removeLegacyCapsules(localStorage, userId);
    } catch {
      const message = "迁移时光胶囊失败，旧数据已保留。";
      setStorageError(message);
      showToast(message, "error");
    }
  }, [initialLoad, showToast, userId, workspaceKey]);

  const persistCapsules = useCallback((updated: Capsule[]): boolean => {
    try {
      const normalized = saveCapsulesToStorage(localStorage, userId, workspaceKey, updated);
      setCapsules(normalized);
      setStorageError(null);
      return true;
    } catch {
      const message = "保存时光胶囊失败，请检查浏览器存储空间或权限。";
      setStorageError(message);
      showToast(message, "error");
      return false;
    }
  }, [showToast, userId, workspaceKey]);

  const handleCreate = () => {
    if (!title.trim() || selectedNames.size === 0) return;
    if (unlockDate < minimumUnlockDate) {
      const message = "解锁日期至少需要设置为明天。";
      setStorageError(message);
      showToast(message, "error");
      return;
    }
    if (capsules.length >= MAX_CAPSULES) {
      const message = `最多保存 ${MAX_CAPSULES} 个时光胶囊，请先删除一个再创建。`;
      setStorageError(message);
      showToast(message, "error");
      return;
    }
    const newCapsule: Capsule = {
      id: `cap-${Date.now()}`,
      title: title.trim().slice(0, MAX_TITLE_LENGTH),
      photoNames: [...selectedNames],
      unlockDate,
      createdAt: today,
    };
    const normalizedNewCapsule = normalizeCapsules([newCapsule])[0];
    if (!normalizedNewCapsule || normalizedNewCapsule.photoNames.length !== selectedNames.size) {
      const message = "胶囊日期或记忆项无效，未保存任何更改。";
      setStorageError(message);
      showToast(message, "error");
      return;
    }
    const updated = [...capsules, normalizedNewCapsule];
    if (!persistCapsules(updated)) return;
    setShowCreate(false);
    setTitle("");
    setSelectedNames(new Set());
  };

  const handleDelete = (id: string) => {
    const updated = capsules.filter((c) => c.id !== id);
    persistCapsules(updated);
  };

  const openedCapsule = capsules.find((c) => c.id === openedCapsuleId);
  const openedPhotos = useMemo(
    () => openedCapsule ? photos.filter((p) => openedCapsule.photoNames.includes(p.name)) : [],
    [openedCapsule, photos],
  );

  const unlocked = capsules.filter((c) => c.unlockDate <= today);
  const locked = capsules.filter((c) => c.unlockDate > today);

  const closeCreateDialog = useCallback(() => {
    setShowCreate(false);
  }, []);

  const resetCapsulePhotoWindow = useCallback(() => {
    setPhotoRenderWindow(createIncrementalRenderWindow());
    setPhotoScrollState({ sourceKey: "", scrolled: false });
    if (capsulePhotoGridRef.current) capsulePhotoGridRef.current.scrollTop = 0;
  }, []);

  const openCreateDialog = useCallback(() => {
    resetCapsulePhotoWindow();
    setShowCreate(true);
  }, [resetCapsulePhotoWindow]);

  const closeViewDialog = useCallback(() => {
    setOpenedCapsuleId(null);
  }, []);

  useLayoutEffect(() => {
    if (committedPhotoSourceKeyRef.current === displayPhotoSourceKey) return;
    committedPhotoSourceKeyRef.current = displayPhotoSourceKey;
    setPhotoRenderWindow({
      sourceKey: displayPhotoSourceKey,
      count: visiblePhotoCount,
    });
    setPhotoScrollState({
      sourceKey: displayPhotoSourceKey,
      scrolled: false,
    });
    if (capsulePhotoGridRef.current) capsulePhotoGridRef.current.scrollTop = 0;
  }, [displayPhotoSourceKey, visiblePhotoCount]);

  useEffect(() => {
    if (
      !showCreate
      || !photoGridHasScrolled
      || !hasMoreDisplayPhotos
      || typeof IntersectionObserver === "undefined"
    ) return;
    const scrollRoot = capsulePhotoGridRef.current;
    const sentinel = capsulePhotoSentinelRef.current;
    if (!scrollRoot || !sentinel) return;

    let active = true;
    const observerSourceKey = displayPhotoSourceKey;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          !active
          || !showCreateRef.current
          || displayPhotoSourceKeyRef.current !== observerSourceKey
          || !entries.some((entry) => entry.isIntersecting)
        ) return;
        setPhotoRenderWindow((current) => advanceIncrementalWindow(
          current,
          observerSourceKey,
          displayPhotos.length,
          focusedPhotoIndex,
        ));
      },
      {
        root: scrollRoot,
        rootMargin: "0px 0px 96px 0px",
        threshold: 0.01,
      },
    );
    observer.observe(sentinel);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [
    displayPhotoSourceKey,
    displayPhotos.length,
    focusedPhotoIndex,
    hasMoreDisplayPhotos,
    photoGridHasScrolled,
    showCreate,
    visiblePhotoCount,
  ]);

  useModalFocusBoundary({
    active: showCreate,
    layerRef: createLayerRef,
    containerRef: createDialogRef,
    initialFocusRef: capsuleTitleInputRef,
    onEscape: () => {
      closeCreateDialog();
      return true;
    },
  });

  useModalFocusBoundary({
    active: openedCapsule !== undefined,
    layerRef: viewLayerRef,
    containerRef: viewDialogRef,
    initialFocusRef: viewCloseButtonRef,
    onEscape: () => {
      closeViewDialog();
      return true;
    },
  });

  return (
    <div className="capsule-wrap">
      <div className="capsule-header">
        <div>
          <span className="capsule-title">💌 时光胶囊</span>
          <span className="capsule-subtitle">将记忆项锁定到未来，到期后解锁查看</span>
        </div>
        <button className="capsule-new-btn" onClick={openCreateDialog}>＋ 新建胶囊</button>
      </div>

      {storageError && <p className="capsule-storage-error" role="alert">{storageError}</p>}

      {capsules.length === 0 && (
        <div className="capsule-empty">
          <div className="capsule-empty-icon">⏳</div>
          <p>还没有时光胶囊</p>
          <p className="capsule-empty-hint">选择一组照片、视频或音频，设定未来某天解锁，留给未来的自己一份礼物</p>
          <button className="capsule-new-btn" onClick={openCreateDialog}>创建第一个胶囊</button>
        </div>
      )}

      {unlocked.length > 0 && (
        <div className="capsule-section">
          <h3 className="capsule-section-title">🎉 已解锁 ({unlocked.length})</h3>
          <div className="capsule-list">
            {unlocked.map((c) => {
              const thumbs = photos.filter((p) => c.photoNames.includes(p.name)).slice(0, 3);
              return (
                <div key={c.id} className="capsule-card capsule-card--unlocked">
                  <div className="capsule-card-thumbs">
                    {thumbs.map((p) => (
                      <MediaThumb
                        key={p.name}
                        blobName={p.name}
                        url={p.url}
                        thumbnailUrl={p.thumbnailUrl}
                        previewUrl={p.previewUrl}
                        contentType={p.contentType}
                        className="capsule-card-thumb"
                        wrapClass="capsule-card-thumb-wrap"
                      />
                    ))}
                    {c.photoNames.length > 3 && (
                      <div className="capsule-card-more">+{c.photoNames.length - 3}</div>
                    )}
                  </div>
                  <div className="capsule-card-info">
                    <div className="capsule-card-name">{c.title}</div>
                    <div className="capsule-card-meta">
                      🗓 创建于 {c.createdAt} · {c.photoNames.length} 个记忆项
                    </div>
                    <div className="capsule-card-unlocked-date">🎁 已于 {c.unlockDate} 解锁</div>
                  </div>
                  <div className="capsule-card-actions">
                    <button className="capsule-open-btn" onClick={() => setOpenedCapsuleId(c.id)}>打开</button>
                    <button className="capsule-del-btn" onClick={() => handleDelete(c.id)}>删除</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {locked.length > 0 && (
        <div className="capsule-section">
          <h3 className="capsule-section-title">🔒 已锁定 ({locked.length})</h3>
          <div className="capsule-list">
            {locked.map((c) => {
              const daysLeft = getPhotoCalendarDayDistance(c.unlockDate, now);
              return (
                <div key={c.id} className="capsule-card capsule-card--locked">
                  <div className="capsule-card-lock-icon">🔒</div>
                  <div className="capsule-card-info">
                    <div className="capsule-card-name">{c.title}</div>
                    <div className="capsule-card-meta">
                      🗓 创建于 {c.createdAt} · {c.photoNames.length} 个记忆项
                    </div>
                    <div className="capsule-card-countdown">
                      {daysLeft === null
                        ? `⚠️ 解锁日期无效（${c.unlockDate}）`
                        : `⏳ 还有 ${daysLeft} 天解锁（${c.unlockDate}）`}
                    </div>
                  </div>
                  <div className="capsule-card-actions">
                    <button className="capsule-del-btn" onClick={() => handleDelete(c.id)}>删除</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Create capsule dialog */}
      {showCreate && createPortal(
        <div ref={createLayerRef} className="capsule-dialog-overlay" data-modal-layer onClick={closeCreateDialog}>
          <div
            ref={createDialogRef}
            className="capsule-dialog auth-native-control-scope"
            role="dialog"
            aria-modal="true"
            aria-labelledby="capsule-create-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="capsule-dialog-header">
              <span id="capsule-create-title">💌 新建时光胶囊</span>
              <button type="button" className="dialog-close-btn" onClick={closeCreateDialog} aria-label="关闭新建时光胶囊">✕</button>
            </div>
            <div className="capsule-dialog-body">
              <label className="capsule-label" htmlFor="capsule-title-input">胶囊名称</label>
              <input
                ref={capsuleTitleInputRef}
                id="capsule-title-input"
                className="capsule-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="给这个胶囊起个名字…"
                maxLength={MAX_TITLE_LENGTH}
              />
              <label className="capsule-label" htmlFor="capsule-unlock-date">解锁日期</label>
              <input
                id="capsule-unlock-date"
                className="capsule-input"
                type="date"
                value={unlockDate}
                min={minimumUnlockDate}
                onChange={(e) => setUnlockDate(e.target.value)}
              />
              <label className="capsule-label">
                选择记忆项（{selectedNames.size} 已选）
              </label>
              <div className="capsule-folder-filter">
                <select
                  className="capsule-select"
                  value={folderFilter}
                  onChange={(e) => {
                    resetCapsulePhotoWindow();
                    setFolderFilter(e.target.value);
                  }}
                >
                  <option value="">最近上传（前60张）</option>
                  {folders.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </div>
              <div
                ref={capsulePhotoGridRef}
                className="capsule-photo-grid"
                onScroll={(event) => {
                  if (event.currentTarget.scrollTop <= 0) return;
                  setPhotoScrollState({
                    sourceKey: displayPhotoSourceKey,
                    scrolled: true,
                  });
                }}
              >
                {visibleDisplayPhotos.map((p, visibleIndex) => {
                  const sel = selectedNames.has(p.name);
                  return (
                    <button
                      key={p.name}
                      type="button"
                      className={`capsule-photo-thumb${sel ? " selected" : ""}`}
                      data-capsule-photo-name={p.name}
                      aria-label={`${sel ? "取消选择" : "选择"}记忆项${p.originalName ?? p.name}`}
                      aria-pressed={sel}
                      onFocus={(event) => {
                        if (
                          visibleIndex !== visibleDisplayPhotos.length - 1
                          || !hasMoreDisplayPhotos
                          || !event.currentTarget.matches(":focus-visible")
                        ) return;
                        setPhotoRenderWindow((current) => advanceIncrementalWindow(
                          current,
                          displayPhotoSourceKey,
                          displayPhotos.length,
                          visibleIndex,
                        ));
                      }}
                      onClick={() => {
                        const next = new Set(selectedNames);
                        if (sel) {
                          next.delete(p.name);
                        } else if (next.size >= MAX_CAPSULE_PHOTOS) {
                          showToast(`每个胶囊最多选择 ${MAX_CAPSULE_PHOTOS} 个记忆项。`, "info");
                          return;
                        } else {
                          next.add(p.name);
                        }
                        setSelectedNames(next);
                      }}
                    >
                      <MediaThumb
                        blobName={p.name}
                        url={p.url}
                        thumbnailUrl={p.thumbnailUrl}
                        previewUrl={p.previewUrl}
                        contentType={p.contentType}
                      />
                      {sel && <span className="capsule-photo-check">✓</span>}
                    </button>
                  );
                })}
                {hasMoreDisplayPhotos && (
                  <div
                    key="capsule-photo-sentinel"
                    ref={capsulePhotoSentinelRef}
                    className="capsule-photo-sentinel"
                    aria-hidden="true"
                  />
                )}
              </div>
            </div>
            <div className="capsule-dialog-footer">
              <button className="capsule-cancel-btn" onClick={closeCreateDialog}>取消</button>
              <button
                className="capsule-confirm-btn"
                onClick={handleCreate}
                disabled={!title.trim() || selectedNames.size === 0 || unlockDate < minimumUnlockDate}
              >创建胶囊 ({selectedNames.size} 项)</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* View opened capsule */}
      {openedCapsule && createPortal(
        <div ref={viewLayerRef} className="capsule-view-overlay" data-modal-layer onClick={closeViewDialog}>
          <div
            ref={viewDialogRef}
            className="capsule-view-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="capsule-view-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="capsule-view-header">
              <span id="capsule-view-title">🎁 {openedCapsule.title}</span>
              <button ref={viewCloseButtonRef} type="button" className="dialog-close-btn" onClick={closeViewDialog} aria-label="关闭时光胶囊">✕</button>
            </div>
            <p className="capsule-view-meta">
              创建于 {openedCapsule.createdAt} · 解锁于 {openedCapsule.unlockDate} · {openedCapsule.photoNames.length} 个记忆项
            </p>
            <div className="capsule-view-grid">
              {openedPhotos.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className="capsule-view-thumb"
                  onClick={() => { setOpenedCapsuleId(null); onViewPhoto?.(p.name); }}
                  aria-label={`查看${p.contentType?.startsWith("audio/") ? "音频" : p.contentType?.startsWith("video/") ? "视频" : "照片"}${p.originalName ?? p.name}`}
                  title={p.originalName ?? p.name}
                >
                  <MediaThumb
                    blobName={p.name}
                    url={p.url}
                    thumbnailUrl={p.thumbnailUrl}
                    previewUrl={p.previewUrl}
                    alt={p.originalName ?? ""}
                    contentType={p.contentType}
                  />
                </button>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
