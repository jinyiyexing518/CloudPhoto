import { useState, useEffect, useCallback } from "react";
import { Photo, listTrashPhotos, restorePhoto, permanentlyDeletePhoto } from "../../services/photoApi";
import { useToast } from "../../contexts/ToastContext";

interface Props {
  groupId: string; // "" = personal trash
  onRestored?: () => void;
}

export default function TrashView({ groupId, onRestored }: Props) {
  const showToast = useToast();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyNames, setBusyNames] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listTrashPhotos(groupId);
      setPhotos(list);
    } catch {
      showToast("加载回收站失败", "error");
    } finally {
      setLoading(false);
    }
  }, [groupId, showToast]);

  useEffect(() => { void load(); }, [load]);

  const setBusy = (name: string, busy: boolean) =>
    setBusyNames((prev) => {
      const next = new Set(prev);
      busy ? next.add(name) : next.delete(name);
      return next;
    });

  const handleRestore = async (name: string) => {
    setBusy(name, true);
    try {
      await restorePhoto(name);
      setPhotos((prev) => prev.filter((p) => p.name !== name));
      showToast("照片已恢复", "success");
      onRestored?.();
    } catch {
      showToast("恢复失败，请重试", "error");
    } finally {
      setBusy(name, false);
    }
  };

  const handlePermanentDelete = async (name: string, displayName: string) => {
    if (!confirm(`「${displayName}」将被彻底删除，无法恢复。确认删除？`)) return;
    setBusy(name, true);
    try {
      await permanentlyDeletePhoto(name);
      setPhotos((prev) => prev.filter((p) => p.name !== name));
      showToast("已彻底删除", "success");
    } catch {
      showToast("删除失败，请重试", "error");
    } finally {
      setBusy(name, false);
    }
  };

  const handleEmptyTrash = async () => {
    if (!confirm(`回收站中 ${photos.length} 张照片将被彻底删除，无法恢复。确认清空？`)) return;
    let failed = 0;
    for (const p of photos) {
      try { await permanentlyDeletePhoto(p.name); }
      catch { failed++; }
    }
    await load();
    if (failed > 0) showToast(`${failed} 张删除失败`, "error");
    else showToast("回收站已清空", "success");
  };

  const handleRestoreAll = async () => {
    if (!confirm(`将恢复回收站中全部 ${photos.length} 张照片，确认？`)) return;
    let failed = 0;
    for (const p of photos) {
      try { await restorePhoto(p.name); }
      catch { failed++; }
    }
    await load();
    if (failed > 0) showToast(`${failed} 张恢复失败`, "error");
    else showToast(`已全部恢复 ${photos.length} 张照片`, "success");
    onRestored?.();
  };

  if (loading) {
    return (
      <div className="loading">
        <div className="loading-spinner" />
        <span>加载中…</span>
      </div>
    );
  }

  if (photos.length === 0) {
    return (
      <div className="trash-empty-state">
        <div className="trash-empty-icon">🗑️</div>
        <div className="trash-empty-title">回收站为空</div>
        <div className="trash-empty-sub">删除的照片会在这里保留，随时可以恢复</div>
      </div>
    );
  }

  return (
    <div className="trash-view">
      <div className="trash-toolbar">
        <span className="trash-toolbar-count">{photos.length} 张照片</span>
        <div className="trash-toolbar-actions">
          <button className="trash-restore-all-btn" onClick={handleRestoreAll}>
            全部恢复
          </button>
          <button className="trash-empty-all-btn" onClick={handleEmptyTrash}>
            清空回收站
          </button>
        </div>
      </div>
      <div className="trash-grid">
        {photos.map((p) => {
          const displayName = p.originalName || p.name.split("/").pop() || p.name;
          const deletedDate = p.deletedAt
            ? new Date(p.deletedAt).toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" })
            : "未知";
          const folder = p.folder ? p.folder : "（根目录）";
          const busy = busyNames.has(p.name);
          return (
            <div key={p.name} className={`trash-card${busy ? " trash-card--busy" : ""}`}>
              <div className="trash-card-thumb">
                <img src={p.url} alt={displayName} loading="lazy" draggable={false} />
              </div>
              <div className="trash-card-body">
                <div className="trash-card-name" title={displayName}>{displayName}</div>
                <div className="trash-card-meta">
                  <span>📁 {folder}</span>
                  <span>🗑 {deletedDate}</span>
                </div>
              </div>
              <div className="trash-card-actions">
                <button
                  className="trash-restore-btn"
                  onClick={() => handleRestore(p.name)}
                  disabled={busy}
                  title="恢复到原位置"
                >
                  恢复
                </button>
                <button
                  className="trash-delete-btn"
                  onClick={() => handlePermanentDelete(p.name, displayName)}
                  disabled={busy}
                  title="彻底删除，不可恢复"
                >
                  彻底删除
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="trash-sticky-actions">
        <button className="trash-restore-all-btn" onClick={handleRestoreAll}>全部恢复</button>
        <button className="trash-empty-all-btn" onClick={handleEmptyTrash}>清空回收站</button>
      </div>
    </div>
  );
}
