/**
 * Upload API — file upload with progress, video thumbnail extraction.
 *
 * Separation of concerns:
 *  - uploadPhoto         : simple fire-and-forget upload (small files)
 *  - uploadPhotoWithProgress : XHR-based upload with per-byte progress callback
 *  - extractVideoThumbnail   : client-side frame extraction via <video> + canvas
 *  - setVideoThumbnail       : POST extracted thumbnail to server
 */

import { API_BASE } from "../utils/apiBase";
import {
  authHeaders,
  fetchWithTimeout,
  recoverFromUnauthorized,
  resolveApiUrl,
} from "./http";
import type { Photo } from "./photoApi";
import { getPreferredMediaUrl, routeMediaUrls } from "./mediaRoute";

function proxyPhoto(photo: Photo): Photo {
  const routed = routeMediaUrls(photo);
  return {
    ...photo,
    ...routed,
  };
}

// ── Upload ────────────────────────────────────────────────────────────────

/** Simple upload — no progress callback. Use for small files or test scripts. */
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
    60_000,
  ).catch((e: unknown) => {
    throw new Error(
      e instanceof Error && e.name === "AbortError"
        ? `上传超时: ${file.name}`
        : "网络错误",
    );
  });

  if (!response.ok) {
    const msg = await response.json().catch(() => ({ error: "Upload failed" }));
    throw new Error((msg as { error?: string }).error ?? `上传失败: ${file.name}`);
  }
  return proxyPhoto(await response.json() as Photo);
}

/**
 * XHR-based upload with real-time progress. Supports AbortSignal for cancellation.
 * Timeout: 10 min to accommodate large video files.
 */
export async function uploadPhotoWithProgress(
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
  const params = new URLSearchParams({ filename: file.name });
  if (uploadedBy) params.set("uploadedBy", uploadedBy);
  if (subject) params.set("subject", subject);
  if (folder) params.set("folder", folder);
  if (groupId) params.set("groupId", groupId);
  if (gpsLat) params.set("gpsLat", gpsLat);
  if (gpsLon) params.set("gpsLon", gpsLon);
  if (takenAt) params.set("takenAt", takenAt);
  const uploadUrl = await resolveApiUrl(
    `${API_BASE}/photos/upload?${params.toString()}`,
    signal,
  );
  if (signal?.aborted) throw new DOMException("上传已取消", "AbortError");

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadUrl);

    const headers = authHeaders({ "Content-Type": file.type || "application/octet-stream" });
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    const authorization = headers.Authorization;
    const requestToken = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : null;

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    });

    xhr.addEventListener("load", async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(proxyPhoto(JSON.parse(xhr.responseText) as Photo)); }
        catch { reject(new Error(`上传失败: ${file.name}`)); }
      } else if (xhr.status === 401) {
        try {
          await recoverFromUnauthorized(requestToken, signal);
          reject(new Error("登录状态已更新，请手动重试上传"));
        } catch (error) {
          reject(error);
        }
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
    xhr.timeout = 600_000; // 10 min for large videos

    signal?.addEventListener("abort", () => {
      xhr.abort();
      reject(new DOMException("上传已取消", "AbortError"));
    });

    xhr.send(file);
  });
}

// ── Video thumbnail extraction ────────────────────────────────────────────

/**
 * Extracts a thumbnail frame from a video File using an off-screen <video> + canvas.
 * Seeks to min(2 s, 10% of duration) — same logic as PhotoCard's preview seek.
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
    // Very short videos may not fire onseeked — fall back to loadeddata
    video.onloadeddata = () => {
      if (video.currentTime > 0) return;
      drawFrame();
    };
    video.onerror = () => { cleanup(); resolve(null); };
    // Hard timeout so we never stall the upload queue
    setTimeout(() => { cleanup(); resolve(null); }, 15_000);
  });
}

/**
 * POST a client-extracted thumbnail frame to the server.
 * Returns the fresh SAS URL for the uploaded thumbnail, or null on failure.
 */
export async function setVideoThumbnail(
  blobName: string,
  thumbnail: Blob,
): Promise<string | null> {
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
    return json.thumbnailUrl ? getPreferredMediaUrl(json.thumbnailUrl) : null;
  } catch {
    return null;
  }
}
