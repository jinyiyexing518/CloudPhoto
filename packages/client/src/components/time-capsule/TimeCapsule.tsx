import { useState, useMemo } from "react";
import { createPortal } from "react-dom";
import { Photo } from "../../services/photoApi";
import MediaThumb from "../shared/MediaThumb";

interface Capsule {
  id: string;
  title: string;
  photoNames: string[];
  unlockDate: string; // ISO date string "YYYY-MM-DD"
  createdAt: string;
}

interface Props {
  photos: Photo[];
  userId: string;
  onViewPhoto?: (name: string) => void;
}

function storageKey(userId: string) {
  return `cf_capsules_${userId}`;
}

function loadCapsules(userId: string): Capsule[] {
  try {
    return JSON.parse(localStorage.getItem(storageKey(userId)) ?? "[]") as Capsule[];
  } catch {
    return [];
  }
}

function saveCapsules(userId: string, capsules: Capsule[]) {
  localStorage.setItem(storageKey(userId), JSON.stringify(capsules));
}

export default function TimeCapsule({ photos, userId, onViewPhoto }: Props) {
  const [capsules, setCapsules] = useState<Capsule[]>(() => loadCapsules(userId));
  const [showCreate, setShowCreate] = useState(false);
  const [openedCapsuleId, setOpenedCapsuleId] = useState<string | null>(null);

  // Create form state
  const [title, setTitle] = useState("");
  const [unlockDate, setUnlockDate] = useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  });
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [folderFilter, setFolderFilter] = useState("");

  const today = new Date().toISOString().slice(0, 10);

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

  const handleCreate = () => {
    if (!title.trim() || selectedNames.size === 0) return;
    const newCapsule: Capsule = {
      id: `cap-${Date.now()}`,
      title: title.trim(),
      photoNames: [...selectedNames],
      unlockDate,
      createdAt: new Date().toISOString().slice(0, 10),
    };
    const updated = [...capsules, newCapsule];
    setCapsules(updated);
    saveCapsules(userId, updated);
    setShowCreate(false);
    setTitle("");
    setSelectedNames(new Set());
  };

  const handleDelete = (id: string) => {
    const updated = capsules.filter((c) => c.id !== id);
    setCapsules(updated);
    saveCapsules(userId, updated);
  };

  const openedCapsule = capsules.find((c) => c.id === openedCapsuleId);
  const openedPhotos = useMemo(
    () => openedCapsule ? photos.filter((p) => openedCapsule.photoNames.includes(p.name)) : [],
    [openedCapsule, photos],
  );

  const unlocked = capsules.filter((c) => c.unlockDate <= today);
  const locked = capsules.filter((c) => c.unlockDate > today);

  return (
    <div className="capsule-wrap">
      <div className="capsule-header">
        <div>
          <span className="capsule-title">💌 时光胶囊</span>
          <span className="capsule-subtitle">将照片锁定到未来，到期后解锁查看</span>
        </div>
        <button className="capsule-new-btn" onClick={() => setShowCreate(true)}>＋ 新建胶囊</button>
      </div>

      {capsules.length === 0 && (
        <div className="capsule-empty">
          <div className="capsule-empty-icon">⏳</div>
          <p>还没有时光胶囊</p>
          <p className="capsule-empty-hint">选择一组照片，设定未来某天解锁，留给未来的自己一份礼物</p>
          <button className="capsule-new-btn" onClick={() => setShowCreate(true)}>创建第一个胶囊</button>
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
                      🗓 创建于 {c.createdAt} · {c.photoNames.length} 张照片
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
              const daysLeft = Math.ceil(
                (new Date(c.unlockDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
              );
              return (
                <div key={c.id} className="capsule-card capsule-card--locked">
                  <div className="capsule-card-lock-icon">🔒</div>
                  <div className="capsule-card-info">
                    <div className="capsule-card-name">{c.title}</div>
                    <div className="capsule-card-meta">
                      🗓 创建于 {c.createdAt} · {c.photoNames.length} 张照片
                    </div>
                    <div className="capsule-card-countdown">
                      ⏳ 还有 {daysLeft} 天解锁（{c.unlockDate}）
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
        <div className="capsule-dialog-overlay" onClick={() => setShowCreate(false)}>
          <div className="capsule-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="capsule-dialog-header">
              <span>💌 新建时光胶囊</span>
              <button className="dialog-close-btn" onClick={() => setShowCreate(false)}>✕</button>
            </div>
            <div className="capsule-dialog-body">
              <label className="capsule-label">胶囊名称</label>
              <input
                className="capsule-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="给这个胶囊起个名字…"
                maxLength={40}
              />
              <label className="capsule-label">解锁日期</label>
              <input
                className="capsule-input"
                type="date"
                value={unlockDate}
                min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
                onChange={(e) => setUnlockDate(e.target.value)}
              />
              <label className="capsule-label">
                选择照片（{selectedNames.size} 已选）
              </label>
              <div className="capsule-folder-filter">
                <select
                  className="capsule-select"
                  value={folderFilter}
                  onChange={(e) => setFolderFilter(e.target.value)}
                >
                  <option value="">最近上传（前60张）</option>
                  {folders.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </div>
              <div className="capsule-photo-grid">
                {displayPhotos.map((p) => {
                  const sel = selectedNames.has(p.name);
                  return (
                    <button
                      key={p.name}
                      className={`capsule-photo-thumb${sel ? " selected" : ""}`}
                      onClick={() => {
                        const next = new Set(selectedNames);
                        sel ? next.delete(p.name) : next.add(p.name);
                        setSelectedNames(next);
                      }}
                    >
                      <MediaThumb
                        url={p.url}
                        thumbnailUrl={p.thumbnailUrl}
                        previewUrl={p.previewUrl}
                        contentType={p.contentType}
                      />
                      {sel && <span className="capsule-photo-check">✓</span>}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="capsule-dialog-footer">
              <button className="capsule-cancel-btn" onClick={() => setShowCreate(false)}>取消</button>
              <button
                className="capsule-confirm-btn"
                onClick={handleCreate}
                disabled={!title.trim() || selectedNames.size === 0}
              >创建胶囊 ({selectedNames.size} 张)</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* View opened capsule */}
      {openedCapsule && createPortal(
        <div className="capsule-view-overlay" onClick={() => setOpenedCapsuleId(null)}>
          <div className="capsule-view-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="capsule-view-header">
              <span>🎁 {openedCapsule.title}</span>
              <button className="dialog-close-btn" onClick={() => setOpenedCapsuleId(null)}>✕</button>
            </div>
            <p className="capsule-view-meta">
              创建于 {openedCapsule.createdAt} · 解锁于 {openedCapsule.unlockDate} · {openedCapsule.photoNames.length} 张照片
            </p>
            <div className="capsule-view-grid">
              {openedPhotos.map((p) => (
                <button
                  key={p.name}
                  className="capsule-view-thumb"
                  onClick={() => { setOpenedCapsuleId(null); onViewPhoto?.(p.name); }}
                  title={p.originalName ?? p.name}
                >
                  <MediaThumb
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
