const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";

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
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
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
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Registration failed" }));
    throw new Error((err as { error?: string }).error ?? "Registration failed");
  }
  return res.json() as Promise<AuthResponse>;
}

export async function getMeApi(): Promise<AuthUser> {
  const res = await fetch(`${API_BASE}/auth/me`, {
    headers: authHeaders(),
  });
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
  const response = await fetch(`${API_BASE}/photos/upload?${params.toString()}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": file.type || "application/octet-stream" }),
    body: file,
  });
  if (!response.ok) throw new Error("Failed to upload photo");
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

export async function deletePhoto(name: string): Promise<void> {
  const response = await fetch(
    `${API_BASE}/photos/${encodeURIComponent(name)}`,
    { method: "DELETE", headers: authHeaders() }
  );
  if (!response.ok) throw new Error("Failed to delete photo");
}
