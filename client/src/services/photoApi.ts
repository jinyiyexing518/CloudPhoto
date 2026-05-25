const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";

function fetchWithTimeout(input: RequestInfo, init?: RequestInit, ms = 15000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(id));
}

// ---- Auth token helpers ----
export function getToken(): string | null {
  return localStorage.getItem("cloudphoto_token");
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
  user: AuthUser;
}

export async function loginApi(username: string, password: string): Promise<AuthResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }).catch((e: unknown) => { throw new Error((e instanceof Error && e.name === "AbortError") ? "登录超时，请稍后重试" : "网络错误"); });
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
}

export async function listPhotos(groupId = ""): Promise<Photo[]> {
  const url = groupId ? `${API_BASE}/photos?groupId=${encodeURIComponent(groupId)}` : `${API_BASE}/photos`;
  const response = await fetch(url, { headers: authHeaders() });
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
  const response = await fetch(
    `${API_BASE}/photos/${encodeURIComponent(name)}/metadata`,
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
  folder: string,
  movedBy?: string
): Promise<void> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/${encodeURIComponent(name)}/metadata`,
    {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ folder, updatedBy: movedBy }),
    },
    15000,
  );
  if (!response.ok) throw new Error("Failed to move photo");
}

export async function deletePhoto(name: string): Promise<void> {
  const response = await fetch(
    `${API_BASE}/photos/${encodeURIComponent(name)}`,
    { method: "DELETE", headers: authHeaders() }
  );
  if (!response.ok) throw new Error("Failed to delete photo");
}
