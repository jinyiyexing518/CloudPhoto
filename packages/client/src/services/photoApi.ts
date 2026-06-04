/**
 * Photo API — core photo types + CRUD operations.
 *
 * This is the primary entry point for photo-related data.  For historical
 * import compatibility all symbols from the other service modules are also
 * re-exported from here, so existing `import { ... } from "./photoApi"` calls
 * continue to work without change.
 *
 * New code should import directly from the domain-specific module:
 *   http      → src/services/http.ts       (fetch utilities, token management)
 *   authApi   → src/services/authApi.ts    (login, register, profile)
 *   uploadApi → src/services/uploadApi.ts  (upload with progress, video thumbnail)
 *   shareApi  → src/services/shareApi.ts   (create / manage share links)
 */

import { API_BASE } from "../utils/apiBase";
import { fetchWithTimeout, authHeaders, parseApiError } from "./http";

// ── Re-exports for backward compatibility ─────────────────────────────────
export {
  saveStoredAuth, clearStoredAuth, getToken, setUnauthorizedHandler,
  fetchWithTimeout, authHeaders,
} from "./http";
export type { AuthUser, AuthResponse } from "./authApi";
export { loginApi, registerApi, getMeApi, addAdminApi, updateProfileApi, changePasswordApi } from "./authApi";
export { uploadPhoto, uploadPhotoWithProgress, extractVideoThumbnail, setVideoThumbnail } from "./uploadApi";
export type { ManagedShareLink, MomentInsight } from "./shareApi";
export { ManagedMomentsUnavailableError, createPhotoShareLink, createFolderShareLink, listManagedShareLinks, updateManagedShareLink } from "./shareApi";

// ── Photo domain type ─────────────────────────────────────────────────────
export interface Photo {
  name: string; originalName?: string; subject?: string; favorite?: boolean;
  folder?: string; groupId?: string; url: string;
  thumbnailUrl?: string; previewUrl?: string;
  size: number; lastModified: string; contentType: string;
  createdAt?: string; createdBy?: string;
  lastModifiedAt?: string; lastModifiedBy?: string;
  deletedAt?: string; deletedBy?: string; deletedByName?: string;
  voiceMemoName?: string; voiceMemoUrl?: string;
  gpsLat?: string; gpsLon?: string;
  isAnimated?: boolean;
  takenAt?: string;
}

export interface MotionVideoResult {
  url: string | null; error: string | null; reason: string | null;
}

export interface PhotoLocation {
  name: string; lat: number; lon: number; originalName?: string; contentType?: string;
}

// ── Blob URL proxy ────────────────────────────────────────────────────────
export function proxyBlobUrl(url: string): string {
  if (typeof window === "undefined" || window.location.hostname !== "cloudphotos.top") return url;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith(".blob.core.windows.net")) return url;
    const blobPath = parsed.pathname.split("/").slice(2).join("/");
    return "/media/" + blobPath + parsed.search;
  } catch { return url; }
}

export function proxyPhoto(photo: Photo): Photo {
  return {
    ...photo,
    url: proxyBlobUrl(photo.url),
    thumbnailUrl: photo.thumbnailUrl ? proxyBlobUrl(photo.thumbnailUrl) : undefined,
    previewUrl: photo.previewUrl ? proxyBlobUrl(photo.previewUrl) : undefined,
    voiceMemoUrl: photo.voiceMemoUrl ? proxyBlobUrl(photo.voiceMemoUrl) : undefined,
  };
}

export function getViewerSrc(photo: Photo): string {
  const dpr = window.devicePixelRatio || 1;
  const physicalViewerPx = Math.round(window.innerWidth * dpr * 0.85);
  if (physicalViewerPx <= 450 && photo.thumbnailUrl) return photo.thumbnailUrl;
  if (physicalViewerPx <= 2200 && photo.previewUrl) return photo.previewUrl;
  return photo.url;
}

// ── Motion video ──────────────────────────────────────────────────────────
export async function fetchMotionVideoBlob(photoName: string): Promise<MotionVideoResult> {
  const url = `${API_BASE}/photos/motion-video?name=${encodeURIComponent(photoName)}`;
  const res = await fetchWithTimeout(url, { headers: authHeaders() }, 30_000).catch(() => null);
  if (!res) return { url: null, error: "网络请求失败，请重试", reason: "network-error" };
  if (res.ok) { const blob = await res.blob(); return { url: URL.createObjectURL(blob), error: null, reason: null }; }
  try {
    const body = await res.json() as { error?: string; reason?: string };
    return { url: null, error: body.error ?? "动态视频提取失败", reason: body.reason ?? null };
  } catch { return { url: null, error: "动态视频提取失败", reason: null }; }
}

// ── Photo list ────────────────────────────────────────────────────────────
export async function listPhotos(groupId = ""): Promise<Photo[]> {
  const url = groupId ? `${API_BASE}/photos?groupId=${encodeURIComponent(groupId)}` : `${API_BASE}/photos`;
  const response = await fetchWithTimeout(url, { headers: authHeaders() });
  if (!response.ok) throw new Error("Failed to fetch photos");
  return (await response.json() as Photo[]).map(proxyPhoto);
}

export async function fetchPhotoLocations(groupId = ""): Promise<PhotoLocation[]> {
  const url = groupId ? `${API_BASE}/photos/locations?groupId=${encodeURIComponent(groupId)}` : `${API_BASE}/photos/locations`;
  try {
    const response = await fetchWithTimeout(url, { headers: authHeaders() });
    if (!response.ok) return [];
    return response.json() as Promise<PhotoLocation[]>;
  } catch { return []; }
}

// ── Photo metadata mutations (consolidated via shared patchMetadata) ───────
async function patchMetadata(name: string, patch: Record<string, unknown>, errorMsg: string): Promise<void> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/metadata?name=${encodeURIComponent(name)}`,
    { method: "PATCH", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(patch) },
  );
  if (!response.ok) throw new Error(await parseApiError(response, errorMsg));
}

export const updatePhotoSubject  = (name: string, subject: string, updatedBy?: string) => patchMetadata(name, { subject, updatedBy }, "更新主题失败");
export const setPhotoFavorite    = (name: string, favorite: boolean, updatedBy?: string) => patchMetadata(name, { favorite, updatedBy }, "更新收藏状态失败");
export const setPhotoVoiceMemo   = (name: string, voiceMemoName: string, updatedBy?: string) => patchMetadata(name, { voiceMemoName, updatedBy }, "更新语音备注失败");
export const updatePhotoGps      = (name: string, gpsLat: string, gpsLon: string) => patchMetadata(name, { gpsLat, gpsLon }, "更新位置失败");
export const updatePhotoTakenAt  = (name: string, takenAt: string, updatedBy?: string) => patchMetadata(name, { takenAt, updatedBy }, "更新拍摄时间失败");
export const renamePhoto         = (name: string, newOriginalName: string, updatedBy?: string) => patchMetadata(name, { originalName: newOriginalName, updatedBy }, "重命名照片失败");

// ── Photo operations ──────────────────────────────────────────────────────
export async function deletePhoto(name: string): Promise<void> {
  const response = await fetchWithTimeout(`${API_BASE}/photos?name=${encodeURIComponent(name)}`, { method: "DELETE", headers: authHeaders() });
  if (!response.ok) throw new Error(await parseApiError(response, "删除照片失败"));
}

export async function movePhotoToFolder(name: string, toFolder: string, movedBy?: string): Promise<{ newName: string }> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/move`,
    { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ name, toFolder, updatedBy: movedBy }) },
    30_000,
  ).catch((e: unknown) => { throw new Error(e instanceof Error && e.name === "AbortError" ? "移动超时" : "网络错误"); });
  if (!response.ok) throw new Error(await parseApiError(response, "移动照片失败"));
  return response.json() as Promise<{ newName: string }>;
}

export async function downloadPhotoApi(name: string, filename: string): Promise<void> {
  let response: Response | null = null; let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetchWithTimeout(`${API_BASE}/photos/download?name=${encodeURIComponent(name)}`, { headers: authHeaders() }, 60_000);
      if (response.ok || response.status < 500 || attempt === 1) break;
    } catch (e: unknown) {
      lastError = e instanceof Error ? e : new Error("网络错误");
      if (attempt === 1) throw new Error(lastError.name === "AbortError" ? "下载超时" : "网络错误");
    }
  }
  if (!response) throw new Error(lastError?.name === "AbortError" ? "下载超时" : "网络错误");
  if (!response.ok) throw new Error("Download failed");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── Trash ──────────────────────────────────────────────────────────────────
export async function listTrashPhotos(groupId = ""): Promise<Photo[]> {
  const url = groupId ? `${API_BASE}/photos/trash?groupId=${encodeURIComponent(groupId)}` : `${API_BASE}/photos/trash`;
  const response = await fetchWithTimeout(url, { headers: authHeaders() });
  if (!response.ok) throw new Error("Failed to fetch trash");
  return (await response.json() as Photo[]).map(proxyPhoto);
}

export async function restorePhoto(name: string): Promise<void> {
  const response = await fetchWithTimeout(`${API_BASE}/photos/trash/restore?name=${encodeURIComponent(name)}`, { method: "POST", headers: authHeaders() });
  if (!response.ok) throw new Error(await parseApiError(response, "恢复照片失败"));
}

export async function permanentlyDeletePhoto(name: string): Promise<void> {
  const response = await fetchWithTimeout(`${API_BASE}/photos/trash?name=${encodeURIComponent(name)}`, { method: "DELETE", headers: authHeaders() });
  if (!response.ok) throw new Error(await parseApiError(response, "彻底删除照片失败"));
}

// ── Backfill ──────────────────────────────────────────────────────────────
export async function backfillPhotoMetadata(groupId = ""): Promise<{ processed: number; updated: number; failed: number }> {
  const url = `${API_BASE}/photos/backfill${groupId ? `?groupId=${encodeURIComponent(groupId)}` : ""}`;
  const response = await fetchWithTimeout(url, { method: "POST", headers: authHeaders() }, 300_000);
  if (!response.ok) throw new Error(await parseApiError(response, "回填历史照片元数据失败"));
  return response.json() as Promise<{ processed: number; updated: number; failed: number }>;
}

export async function backfillThumbnails(groupId = ""): Promise<{ processed: number; generated: number; skipped: number; failed: number }> {
  const totals = { processed: 0, generated: 0, skipped: 0, failed: 0 };
  let hasMore = true;
  while (hasMore) {
    const qp = new URLSearchParams(); if (groupId) qp.set("groupId", groupId); qp.set("limit", "30");
    const response = await fetchWithTimeout(`${API_BASE}/photos/backfill-thumbnails?${qp}`, { method: "POST", headers: authHeaders() }, 120_000);
    if (!response.ok) throw new Error(await parseApiError(response, "缩略图回填失败"));
    const result = await response.json() as { processed: number; generated: number; skipped: number; failed: number; hasMore: boolean; };
    totals.processed += result.processed; totals.generated += result.generated; totals.skipped += result.skipped; totals.failed += result.failed;
    hasMore = result.hasMore;
  }
  return totals;
}

// ── Changelog ─────────────────────────────────────────────────────────────
export interface ChangelogEntry {
  id: string; date: string; icon: string; title: string; desc: string; details?: string;
  type?: "feature" | "fix" | "improvement";
}

export async function fetchChangelogs(days = 7): Promise<ChangelogEntry[]> {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split("T")[0];
  const filterByDate = (list: ChangelogEntry[]) => list.filter((e) => e.date >= cutoffStr);
  try {
    const response = await fetchWithTimeout(`${API_BASE}/changelogs?days=${days}`, { method: "GET", headers: { "Content-Type": "application/json" } });
    if (!response.ok) throw new Error(response.statusText);
    return (await response.json()) as ChangelogEntry[];
  } catch {
    try { const res = await fetch("/changelog.json"); if (!res.ok) return []; return filterByDate((await res.json()) as ChangelogEntry[]); }
    catch { return []; }
  }
}