const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";

const TOKEN_KEY = "cloudphoto_token";
const REFRESH_TOKEN_KEY = "cloudphoto_refresh_token";

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

export interface Photo {
  name: string;
  originalName?: string;
  subject?: string;
  folder?: string;
  groupId?: string;
  url: string;
  size: number;
  lastModified: string;
  contentType: string;
  createdAt?: string;
  createdBy?: string;
  lastModifiedAt?: string;
  lastModifiedBy?: string;
  deletedAt?: string;
  deletedBy?: string;
}

export async function listPhotos(groupId = ""): Promise<Photo[]> {
  const url = groupId ? `${API_BASE}/photos?groupId=${encodeURIComponent(groupId)}` : `${API_BASE}/photos`;
  const response = await fetchWithTimeout(url, { headers: authHeaders() });
  if (!response.ok) throw new Error("Failed to fetch photos");
  return response.json() as Promise<Photo[]>;
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
  if (!response.ok) throw new Error("Failed to update subject");
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
  if (!response.ok) throw new Error("Failed to move photo");
  return response.json() as Promise<{ newName: string }>;
}

export async function deletePhoto(name: string): Promise<void> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos?name=${encodeURIComponent(name)}`,
    { method: "DELETE", headers: authHeaders() }
  );
  if (!response.ok) throw new Error("Failed to delete photo");
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
  if (!response.ok) throw new Error("Failed to restore photo");
}

export async function permanentlyDeletePhoto(name: string): Promise<void> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/trash?name=${encodeURIComponent(name)}`,
    { method: "DELETE", headers: authHeaders() }
  );
  if (!response.ok) throw new Error("Failed to permanently delete photo");
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
  if (!response.ok) throw new Error("Failed to rename photo");
}

export async function downloadPhotoApi(
  name: string,
  filename: string,
): Promise<void> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/download?name=${encodeURIComponent(name)}`,
    { headers: authHeaders() },
    60000,
  ).catch((e: unknown) => {
    throw new Error(
      e instanceof Error && e.name === "AbortError" ? "下载超时" : "网络错误",
    );
  });
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
