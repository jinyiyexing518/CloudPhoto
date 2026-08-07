/**
 * Share Link API — create, list, update (revoke/extend) managed share links.
 */

import { API_BASE } from "../utils/apiBase";
import { fetchWithTimeout, authHeaders, parseApiError } from "./http";

// ── Domain types ──────────────────────────────────────────────────────────

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

/** Thrown when the managed moments API is unavailable (e.g. Cosmos not configured). */
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

// ── API calls ─────────────────────────────────────────────────────────────

export async function createPhotoShareLink(
  name: string,
  hours = 24,
): Promise<{ url: string; expiresAt: string; shareId?: string; directUrl?: string }> {
  const response = await fetchWithTimeout(
    `${API_BASE}/photos/share?name=${encodeURIComponent(name)}&hours=${encodeURIComponent(String(hours))}`,
    { headers: authHeaders() },
  ).catch((error: unknown) => {
    throw new Error(
      error instanceof Error && error.name === "AbortError"
        ? "创建分享链接超时"
        : "网络错误",
    );
  });
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
    throw new Error(
      e instanceof Error && e.name === "AbortError" ? "创建文件夹分享超时" : "网络错误",
    );
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? "Failed to create folder share link");
  }
  return response.json() as Promise<{ url: string; expiresAt: string; shareId?: string; directUrl?: string }>;
}

export async function listManagedShareLinks(
  options?: { status?: "all" | "active" | "revoked" | "expired"; q?: string },
): Promise<ManagedShareLink[]> {
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
    throw new Error(
      await parseApiError(response, "更新分享链接失败", {
        conflictMessage: "分享链接已被其他操作更新，请刷新后重试",
      }),
    );
  }
  return response.json() as Promise<ManagedShareLink>;
}
