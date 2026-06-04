import { API_BASE } from "../utils/apiBase";

const TOKEN_KEY = "cloudphoto_token";
const REFRESH_TOKEN_KEY = "cloudphoto_refresh_token";
const DEFAULT_CONFLICT_MESSAGE = "资源已被他人修改，请刷新后重试";

async function parseApiError(
  response: Response,
  fallback: string,
  options?: { conflictMessage?: string },
): Promise<string> {
  if (response.status === 409) {
    return options?.conflictMessage ?? DEFAULT_CONFLICT_MESSAGE;
  }
  const err = await response.json().catch(() => ({})) as { error?: string };
  return err.error ?? fallback;
}

// ---- Stored auth helpers (used by AuthContext) ----
export function saveStoredAuth(token: string, refreshToken?: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}
export function clearStoredAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

// ---- 401 auto-logout handler ----
let _onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void { _onUnauthorized = fn; }

// ---- Refresh token logic (with concurrency mutex) ----
let _refreshPromise: Promise<string | null> | null = null;

async function _doRefresh(): Promise<string | null> {
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken) return null;
  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${refreshToken}` },
  }).catch(() => null);
  if (!res?.ok) return null;
  const data = await res.json() as { token?: string; refreshToken?: string };
  if (!data.token) return null;
  saveStoredAuth(data.token, data.refreshToken);
  return data.token;
}

function getRefreshedToken(): Promise<string | null> {
  // Reuse in-flight refresh so concurrent 401s don't all fire separate requests
  if (!_refreshPromise) {
    _refreshPromise = _doRefresh().finally(() => { _refreshPromise = null; });
  }
  return _refreshPromise;
}

function fetchWithTimeout(input: RequestInfo, init?: RequestInit, ms = 15000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return fetch(input, { ...init, signal: controller.signal })
    .then(async (res) => {
      if (res.status === 401) {
        const newToken = await getRefreshedToken();
        if (newToken) {
          // Retry the original request once with the new token
          const retryHeaders = {
            ...(init?.headers as Record<string, string> ?? {}),
            Authorization: `Bearer ${newToken}`,
          };
          return fetch(input, { ...init, headers: retryHeaders });
        }
        _onUnauthorized?.();
      }
      return res;
    })
    .finally(() => clearTimeout(id));
}

// ---- Auth token helpers ----
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}`, ...extra } : { ...extra };
}

// ---- Auth types & API ----
export interface AuthUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  avatar?: string;
  role: "admin" | "viewer";
}

export interface AuthResponse {
  token: string;
  refreshToken?: string;
  user: AuthUser;
}

export async function loginApi(username: string, password: string): Promise<AuthResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }, 30000).catch((e: unknown) => { throw new Error((e instanceof Error && e.name === "AbortError") ? "登录响应超时，服务器可能正在启动，请稍后重试" : "网络错误"); });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Login failed" }));
    throw new Error((err as { error?: string }).error ?? "Login failed");
  }
  return res.json() as Promise<AuthResponse>;
}

export async function registerApi(data: {
  username: string;
  email: string;
  displayName: string;
  password: string;
}): Promise<AuthResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }).catch((e: unknown) => { throw new Error((e instanceof Error && e.name === "AbortError") ? "注册超时，请稍后重试" : "网络错误"); });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Registration failed" }));
    throw new Error((err as { error?: string }).error ?? "Registration failed");
  }
  return res.json() as Promise<AuthResponse>;
}

export async function getMeApi(): Promise<AuthUser> {
  const res = await fetchWithTimeout(`${API_BASE}/auth/me`, {
    headers: authHeaders(),
  }).catch(() => { throw new Error("Unauthorized"); });
  if (!res.ok) throw new Error("Unauthorized");
  return res.json() as Promise<AuthUser>;
}

export async function addAdminApi(data: { email?: string; username?: string }): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/admins`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed" }));
    throw new Error((err as { error?: string }).error ?? "Failed to add admin");
  }
}

export async function updateProfileApi(data: { displayName: string }): Promise<AuthResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/auth/me`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed" }));
    throw new Error((err as { error?: string }).error ?? "Failed to update profile");
  }
  return res.json() as Promise<AuthResponse>;
}

export async function changePasswordApi(data: { currentPassword: string; newPassword: string }): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/auth/change-password`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed" }));
    throw new Error((err as { error?: string }).error ?? "Failed to change password");
  }
}

export interface Photo {
  name: string;
  originalName?: string;
  subject?: string;
  favorite?: boolean;
  folder?: string;
  groupId?: string;
  url: string;
  /** SAS URL for the 400 px WebP thumbnail — present for JPEG/PNG/WebP uploads. */
  thumbnailUrl?: string;
  size: number;
  lastModified: string;
  contentType: string;
  createdAt?: string;
  createdBy?: string;
  lastModifiedAt?: string;
  lastModifiedBy?: string;
  deletedAt?: string;
  deletedBy?: string;
  deletedByName?: string;
  voiceMemoName?: string;
  voiceMemoUrl?: string;
  gpsLat?: string;
  gpsLon?: string;
  /** True for GIF, animated WebP, APNG, and Android/Google Motion Photos */
  isAnimated?: boolean;
  /** ISO 8601 timestamp from EXIF DateTimeOriginal — when the photo was actually taken */
  takenAt?: string;
}

/**
 * Fetch the embedded motion video from a Google/Samsung/etc. motion JPEG.
 * Returns a Blob URL (remember to call URL.revokeObjectURL when done), or null on failure.
/**
 * Result of a motion video extraction attempt.
 * - `url`: blob URL to play (caller must revoke when done)
 * - `error`: human-readable reason why extraction failed
 * - `reason`: machine-readable code, e.g. "apple-live-photo"
 */
export interface MotionVideoResult {
  url: string | null;
  error: string | null;
  reason: string | null;
}

export async function fetchMotionVideoBlob(photoName: string): Promise<MotionVideoResult> {
  const url = `${API_BASE}/photos/motion-video?name=${encodeURIComponent(photoName)}`;
  const res = await fetchWithTimeout(url, { headers: authHeaders() }, 30000).catch(() => null);
  if (!res) return { url: null, error: "网络请求失败，请重试", reason: "network-error" };
  if (res.ok) {
    const blob = await res.blob();
    return { url: URL.createObjectURL(blob), error: null, reason: null };
  }
  // Parse structured error from server
  try {
    const body = await res.json() as { error?: string; reason?: string };
    return { url: null, error: body.error ?? "动态视频提取失败", reason: body.reason ?? null };
  } catch {
    return { url: null, error: "动态视频提取失败", reason: null };
  }
}

/** Lightweight GPS-only record from the fast Cosmos cache */
export interface PhotoLocation {
  name: string;
  lat: number;
  lon: number;
  originalName?: string;
  contentType?: string;
}

export async function listPhotos(groupId = ""): Promise<Photo[]> {
  const url = groupId ? `${API_BASE}/photos?groupId=${encodeURIComponent(groupId)}` : `${API_BASE}/photos`;
  const response = await fetchWithTimeout(url, { headers: authHeaders() });
  if (!response.ok) throw new Error("Failed to fetch photos");
  return response.json() as Promise<Photo[]>;
}

/**
 * Fetch GPS-tagged photo locations from the fast Cosmos cache.
 * Returns only coordinates — no SAS URLs. Much faster than listPhotos.
 */
export async function fetchPhotoLocations(groupId = ""): Promise<PhotoLocation[]> {
  const url = groupId
    ? `${API_BASE}/photos/locations?groupId=${encodeURIComponent(groupId)}`
    : `${API_BASE}/photos/locations`;
  try {
    const response = await fetchWithTimeout(url, { headers: authHeaders() });
    if (!response.ok) return [];
    return response.json() as Promise<PhotoLocation[]>;
  } catch {
    return [];
  }
}

export async function uploadPhoto(
  file: File,
  uploadedBy?: string,
  subject?: string,
  folder?: string,
  groupId?: string,
): Promise<Photo> {
  const params = new URLSearchParams({ filename: file.name });
  if (uploadedBy) params.set("uploadedBy", uploadedBy);
  if (subject) params.set("subject", subject);
  if (folder) params.set("folder", folder);
  if (groupId) params.set("groupId", groupId);
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/upload?${params.toString()}`,
    {
      method: "POST",
      headers: authHeaders({ "Content-Type": file.type || "application/octet-stream" }),
      body: file,
    },
    60000,
  ).catch((e: unknown) => {
    throw new Error((e instanceof Error && e.name === "AbortError") ? `上传超时: ${file.name}` : "网络错误");
  });
  if (!response.ok) {
    const msg = await response.json().catch(() => ({ error: "Upload failed" }));
    throw new Error((msg as { error?: string }).error ?? `上传失败: ${file.name}`);
  }
  return response.json() as Promise<Photo>;
}

export function uploadPhotoWithProgress(
  file: File,
  onProgress: (loaded: number, total: number) => void,
  uploadedBy?: string,
  subject?: string,
  folder?: string,
  groupId?: string,
  gpsLat?: string,
  gpsLon?: string,
  signal?: AbortSignal,
  takenAt?: string,
): Promise<Photo> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ filename: file.name });
    if (uploadedBy) params.set("uploadedBy", uploadedBy);
    if (subject) params.set("subject", subject);
    if (folder) params.set("folder", folder);
    if (groupId) params.set("groupId", groupId);
    if (gpsLat) params.set("gpsLat", gpsLat);
    if (gpsLon) params.set("gpsLon", gpsLon);
    if (takenAt) params.set("takenAt", takenAt);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/photos/upload?${params.toString()}`);

    const headers = authHeaders({ "Content-Type": file.type || "application/octet-stream" });
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText) as Photo); }
        catch { reject(new Error(`上传失败: ${file.name}`)); }
      } else {
        try {
          const msg = JSON.parse(xhr.responseText) as { error?: string };
          reject(new Error(msg.error ?? `上传失败: ${file.name}`));
        } catch {
          reject(new Error(`上传失败: ${file.name}`));
        }
      }
    });
    xhr.addEventListener("error", () => reject(new Error("网络错误")));
    xhr.addEventListener("timeout", () => reject(new Error(`上传超时: ${file.name}`)));
    xhr.timeout = 600000; // 10 min for large videos

    // Honour external abort (e.g. user cancels)
    signal?.addEventListener("abort", () => { xhr.abort(); reject(new DOMException("上传已取消", "AbortError")); });

    xhr.send(file);
  });
}

/**
 * Extract a thumbnail frame from a video File using an off-screen <video> + canvas.
 * Seeks to min(2 s, 10 % of duration) — same logic as PhotoCard's preview.
 * Returns a 400 px-wide WebP Blob, or null if extraction fails / times out.
 */
export function extractVideoThumbnail(file: File): Promise<Blob | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    const objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;
    const cleanup = () => URL.revokeObjectURL(objectUrl);

    const drawFrame = () => {
      try {
        const scale = Math.min(1, 400 / (video.videoWidth || 400));
        const w = Math.round((video.videoWidth || 400) * scale);
        const h = Math.round((video.videoHeight || 300) * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { cleanup(); resolve(null); return; }
        ctx.drawImage(video, 0, 0, w, h);
        canvas.toBlob((blob) => { cleanup(); resolve(blob); }, "image/webp", 0.75);
      } catch { cleanup(); resolve(null); }
    };

    video.onloadedmetadata = () => {
      video.currentTime = Math.min(2, video.duration * 0.1);
    };
    video.onseeked = drawFrame;
    // If the video is very short (<0.1 s), onseeked may not fire — fall back to loadeddata
    video.onloadeddata = () => {
      if (video.currentTime > 0) return; // onseeked already handled it
      drawFrame();
    };
    video.onerror = () => { cleanup(); resolve(null); };
    // Hard timeout so we never stall the upload loop
    setTimeout(() => { cleanup(); resolve(null); }, 15_000);
  });
}

/** Upload a client-extracted video thumbnail frame to the server. Returns the fresh SAS URL. */
export async function setVideoThumbnail(blobName: string, thumbnail: Blob): Promise<string | null> {
  try {
    const params = new URLSearchParams({ blobName });
    const res = await fetchWithTimeout(
      `${API_BASE}/photos/set-thumbnail?${params}`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "image/webp" }),
        body: thumbnail,
      },
      30_000,
    );
    if (!res.ok) return null;
    const json = await res.json() as { thumbnailUrl?: string };
    return json.thumbnailUrl ?? null;
  } catch {
    return null;
  }
}

export async function updatePhotoSubject(
  name: string,
  subject: string,
  updatedBy?: string
): Promise<void> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/metadata?name=${encodeURIComponent(name)}`,
    {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ subject, updatedBy }),
    }
  );
  if (!response.ok) {
    throw new Error(await parseApiError(response, "更新主题失败"));
  }
}

export async function setPhotoFavorite(
  name: string,
  favorite: boolean,
  updatedBy?: string,
): Promise<void> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/metadata?name=${encodeURIComponent(name)}`,
    {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ favorite, updatedBy }),
    },
  );
  if (!response.ok) {
    throw new Error(await parseApiError(response, "更新收藏状态失败"));
  }
}

export async function setPhotoVoiceMemo(
  name: string,
  voiceMemoName: string,
  updatedBy?: string,
): Promise<void> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/metadata?name=${encodeURIComponent(name)}`,
    {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ voiceMemoName, updatedBy }),
    },
  );
  if (!response.ok) {
    throw new Error(await parseApiError(response, "更新语音备注失败"));
  }
}

export async function updatePhotoGps(
  name: string,
  gpsLat: string,
  gpsLon: string,
): Promise<void> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/metadata?name=${encodeURIComponent(name)}`,
    {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ gpsLat, gpsLon }),
    },
  );
  if (!response.ok) {
    throw new Error(await parseApiError(response, "更新位置失败"));
  }
}

export async function updatePhotoTakenAt(
  name: string,
  takenAt: string,
  updatedBy?: string,
): Promise<void> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/metadata?name=${encodeURIComponent(name)}`,
    {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ takenAt, updatedBy }),
    },
  );
  if (!response.ok) {
    throw new Error(await parseApiError(response, "更新拍摄时间失败"));
  }
}

export async function backfillPhotoMetadata(
  groupId = "",
): Promise<{ processed: number; updated: number; failed: number }> {
  const url = `${API_BASE}/photos/backfill${groupId ? `?groupId=${encodeURIComponent(groupId)}` : ""}`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: authHeaders(),
  }, 300_000);
  if (!response.ok) {
    throw new Error(await parseApiError(response, "回填历史照片元数据失败"));
  }
  return response.json() as Promise<{ processed: number; updated: number; failed: number }>;
}

export async function backfillThumbnails(
  groupId = "",
): Promise<{ processed: number; generated: number; skipped: number; failed: number }> {
  const url = `${API_BASE}/photos/backfill-thumbnails${groupId ? `?groupId=${encodeURIComponent(groupId)}` : ""}`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: authHeaders(),
    // Large libraries may take a while; give it 5 minutes
  }, 300_000);
  if (!response.ok) {
    throw new Error(await parseApiError(response, "缩略图回填失败"));
  }
  return response.json() as Promise<{ processed: number; generated: number; skipped: number; failed: number }>;
}

export interface ChangelogEntry {
  id: string;
  date: string;
  icon: string;
  title: string;
  desc: string;
  details?: string;
  /** "feature" | "fix" | "improvement" — defaults to "feature" when absent */
  type?: "feature" | "fix" | "improvement";
}

export async function fetchChangelogs(days = 7): Promise<ChangelogEntry[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  const filterByDate = (list: ChangelogEntry[]) =>
    list.filter((e) => e.date >= cutoffStr);

  try {
    const response = await fetchWithTimeout(
      `${API_BASE}/changelogs?days=${days}`,
      { method: "GET", headers: { "Content-Type": "application/json" } },
    );
    if (!response.ok) throw new Error(response.statusText);
    return (await response.json()) as ChangelogEntry[];
  } catch {
    // API unavailable (server not running in local dev) — fall back to the
    // static changelog.json bundled in public/.
    try {
      const res = await fetch("/changelog.json");
      if (!res.ok) return [];
      return filterByDate((await res.json()) as ChangelogEntry[]);
    } catch {
      return [];
    }
  }
}

export async function movePhotoToFolder(
  name: string,
  toFolder: string,
  movedBy?: string
): Promise<{ newName: string }> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/move`,
    {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name, toFolder, updatedBy: movedBy }),
    },
    30000,
  ).catch((e: unknown) => { throw new Error((e instanceof Error && e.name === "AbortError") ? "移动超时" : "网络错误"); });
  if (!response.ok) {
    throw new Error(await parseApiError(response, "移动照片失败"));
  }
  return response.json() as Promise<{ newName: string }>;
}

export async function deletePhoto(name: string): Promise<void> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos?name=${encodeURIComponent(name)}`,
    { method: "DELETE", headers: authHeaders() }
  );
  if (!response.ok) {
    throw new Error(await parseApiError(response, "删除照片失败"));
  }
}

// ---- Trash API ----

export async function listTrashPhotos(groupId = ""): Promise<Photo[]> {
  const url = groupId
    ? `${API_BASE}/photos/trash?groupId=${encodeURIComponent(groupId)}`
    : `${API_BASE}/photos/trash`;
  const response = await fetchWithTimeout(url, { headers: authHeaders() });
  if (!response.ok) throw new Error("Failed to fetch trash");
  return response.json() as Promise<Photo[]>;
}

export async function restorePhoto(name: string): Promise<void> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/trash/restore?name=${encodeURIComponent(name)}`,
    { method: "POST", headers: authHeaders() }
  );
  if (!response.ok) {
    throw new Error(await parseApiError(response, "恢复照片失败"));
  }
}

export async function permanentlyDeletePhoto(name: string): Promise<void> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/trash?name=${encodeURIComponent(name)}`,
    { method: "DELETE", headers: authHeaders() }
  );
  if (!response.ok) {
    throw new Error(await parseApiError(response, "彻底删除照片失败"));
  }
}

export async function renamePhoto(
  name: string,
  newOriginalName: string,
  updatedBy?: string,
): Promise<void> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/metadata?name=${encodeURIComponent(name)}`,
    {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ originalName: newOriginalName, updatedBy }),
    },
  );
  if (!response.ok) {
    throw new Error(await parseApiError(response, "重命名照片失败"));
  }
}

export async function downloadPhotoApi(
  name: string,
  filename: string,
): Promise<void> {
  let response: Response | null = null;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetchWithTimeout(
        `${API_BASE}/photos/download?name=${encodeURIComponent(name)}`,
        { headers: authHeaders() },
        60000,
      );
      if (response.ok || response.status < 500 || attempt === 1) break;
    } catch (e: unknown) {
      lastError = e instanceof Error ? e : new Error("网络错误");
      if (attempt === 1) {
        throw new Error(
          lastError.name === "AbortError" ? "下载超时" : "网络错误",
        );
      }
    }
  }
  if (!response) {
    throw new Error(lastError?.name === "AbortError" ? "下载超时" : "网络错误");
  }
  if (!response.ok) throw new Error("Download failed");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function createPhotoShareLink(
  name: string,
  hours = 24,
): Promise<{ url: string; expiresAt: string; shareId?: string; directUrl?: string }> {
  let response: Response | null = null;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetchWithTimeout(
        `${API_BASE}/photos/share?name=${encodeURIComponent(name)}&hours=${encodeURIComponent(String(hours))}`,
        { headers: authHeaders() },
      );
      if (response.ok || response.status < 500 || attempt === 1) break;
    } catch (e: unknown) {
      lastError = e instanceof Error ? e : new Error("网络错误");
      if (attempt === 1) {
        throw new Error(lastError.name === "AbortError" ? "创建分享链接超时" : "网络错误");
      }
    }
  }

  if (!response) {
    throw new Error(lastError?.name === "AbortError" ? "创建分享链接超时" : "网络错误");
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? "Failed to create share link");
  }
  return response.json() as Promise<{ url: string; expiresAt: string; shareId?: string; directUrl?: string }>;
}

export async function createFolderShareLink(
  folder: string,
  groupId?: string,
  hours = 24,
): Promise<{ url: string; expiresAt: string; shareId?: string; directUrl?: string }> {
  const params = new URLSearchParams();
  params.set("folder", folder);
  params.set("hours", String(hours));
  if (groupId) params.set("groupId", groupId);

  const response = await fetchWithTimeout(
    `${API_BASE}/photos/share?${params.toString()}`,
    { headers: authHeaders() },
  ).catch((e: unknown) => {
    throw new Error(e instanceof Error && e.name === "AbortError" ? "创建文件夹分享超时" : "网络错误");
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? "Failed to create folder share link");
  }

  return response.json() as Promise<{ url: string; expiresAt: string; shareId?: string; directUrl?: string }>;
}

export interface ManagedShareLink {
  id: string;
  createdByUserId: string;
  createdByName: string;
  blobName: string;
  displayName: string;
  groupId?: string;
  createdAt: string;
  expiresAt: string;
  status: "active" | "revoked" | "expired";
  viewCount: number;
  url?: string;
  lastViewedAt?: string;
  revokedAt?: string;
}

export interface MomentInsight {
  photoName: string;
  totalViews: number;
  lastViewedAt?: string;
  lastViewedBy?: string;
  viewers: Record<string, number>;
  dailyViews: Record<string, number>;
  updatedAt?: string;
}

export class ManagedMomentsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedMomentsUnavailableError";
  }
}

interface ManagedShareLinksResponse {
  items?: ManagedShareLink[];
  managedUnavailable?: boolean;
  message?: string;
}

export async function listManagedShareLinks(options?: { status?: "all" | "active" | "revoked" | "expired"; q?: string }): Promise<ManagedShareLink[]> {
  const params = new URLSearchParams();
  if (options?.status && options.status !== "all") params.set("status", options.status);
  if (options?.q?.trim()) params.set("q", options.q.trim());
  const qs = params.toString();
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/share/links${qs ? `?${qs}` : ""}`,
    { headers: authHeaders() },
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? "Failed to fetch share links");
  }
  const data = await response.json() as ManagedShareLink[] | ManagedShareLinksResponse;
  if (Array.isArray(data)) return data;
  return Array.isArray(data.items) ? data.items : [];
}

export async function updateManagedShareLink(
  linkId: string,
  action: "revoke" | "extend",
  hours?: number,
): Promise<ManagedShareLink> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/share/links/${encodeURIComponent(linkId)}`,
    {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ action, hours }),
    },
  );
  if (!response.ok) {
    throw new Error(await parseApiError(response, "更新分享链接失败", {
      conflictMessage: "分享链接已被其他操作更新，请刷新后重试",
    }));
  }
  return response.json() as Promise<ManagedShareLink>;
}

export async function listMomentInsights(photoNames: string[]): Promise<Record<string, MomentInsight>> {
  if (photoNames.length === 0) return {};
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/moments/insights`,
    {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ photoNames }),
    },
  );
  const data = await response.json().catch(() => ({})) as { items?: MomentInsight[]; error?: string; managedUnavailable?: boolean; message?: string };
  if (!response.ok) {
    throw new Error(data.error ?? "Failed to fetch moment insights");
  }
  if (data.managedUnavailable) {
    throw new ManagedMomentsUnavailableError(data.message ?? "Moments insights unavailable");
  }
  const items = Array.isArray(data.items) ? data.items : [];
  return items.reduce<Record<string, MomentInsight>>((acc, item) => {
    if (!item.photoName) return acc;
    acc[item.photoName] = {
      ...item,
      viewers: item.viewers ?? {},
      dailyViews: item.dailyViews ?? {},
      totalViews: Number.isFinite(item.totalViews) ? item.totalViews : 0,
    };
    return acc;
  }, {});
}

export async function recordMomentViewApi(photoName: string, viewerName?: string): Promise<MomentInsight | null> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/moments/view`,
    {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ photoName, viewerName }),
    },
  );

  const data = await response.json().catch(() => ({})) as { item?: MomentInsight; ok?: boolean; managedUnavailable?: boolean; message?: string; error?: string };
  if (!response.ok) {
    if (response.status === 409) return null;
    throw new Error(data.error ?? "Failed to record moment view");
  }
  if (data.managedUnavailable) {
    throw new ManagedMomentsUnavailableError(data.message ?? "Moments insights unavailable");
  }
  if (data.ok === false) return null;
  return data.item ?? null;
}

export async function renameFolderApi(
  oldFolder: string,
  newFolder: string,
  groupId?: string,
): Promise<{ renamed: number; oldFolder: string; newFolder: string }> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/folder`,
    {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ oldFolder, newFolder, groupId }),
    },
    60000,
  ).catch((e: unknown) => {
    throw new Error(e instanceof Error && e.name === "AbortError" ? "重命名超时" : "网络错误");
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? "重命名失败");
  }
  return response.json() as Promise<{ renamed: number; oldFolder: string; newFolder: string }>;
}

