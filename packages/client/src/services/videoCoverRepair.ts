import { useCallback, useEffect, useRef, useState } from "react";
import type { Photo } from "./photoApi";
import {
  fallbackMediaSource,
  getPreferredMediaUrl,
} from "./mediaRoute";
import {
  getAuthGeneration,
  subscribeToAuthChanges,
} from "./http";
import {
  extractVideoElementThumbnail,
  isVideoThumbnailPersistencePending,
  setVideoThumbnail,
  subscribeToVideoThumbnailPersistence,
} from "./uploadApi";
import {
  VideoCoverRepairQueue,
  videoCoverFrameInformation,
  videoCoverRepairCandidateTimes,
  type VideoCoverRepairRequest,
  type VideoCoverRepairState,
} from "./videoCoverRepairPolicy";

const VIDEO_COVER_REPAIR_TIMEOUT_MS = 25_000;
const VIDEO_COVER_REPAIR_IDLE_TIMEOUT_MS = 2_000;
const VIDEO_COVER_ANALYSIS_SIZE = 32;

interface NetworkInformationLike extends EventTarget {
  effectiveType?: string;
  saveData?: boolean;
}

function networkInformation(): NetworkInformationLike | undefined {
  return (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
}

function networkSnapshot() {
  const connection = networkInformation();
  return {
    online: navigator.onLine,
    effectiveType: connection?.effectiveType,
    saveData: connection?.saveData,
  };
}

function releaseVideo(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute("src");
  video.load();
}

function framePixels(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): Uint8ClampedArray | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = VIDEO_COVER_ANALYSIS_SIZE;
    canvas.height = VIDEO_COVER_ANALYSIS_SIZE;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context || sourceWidth <= 0 || sourceHeight <= 0) return null;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    return null;
  }
}

export function isLowInformationVideoCoverImage(
  image: HTMLImageElement,
): boolean | null {
  const pixels = framePixels(image, image.naturalWidth, image.naturalHeight);
  return pixels ? videoCoverFrameInformation(pixels).lowInformation : null;
}

function waitForVideoFrame(
  video: HTMLVideoElement,
  time: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      video.removeEventListener("seeked", ready);
      video.removeEventListener("loadeddata", ready);
      video.removeEventListener("error", failed);
    };
    const ready = () => {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("Video frame decode failed"));
    };
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("Video frame decode aborted", "AbortError"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    if (
      Math.abs(video.currentTime - time) < 0.01
      && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      resolve();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    video.addEventListener("seeked", ready);
    video.addEventListener("loadeddata", ready);
    video.addEventListener("error", failed);
    video.currentTime = time;
  });
}

function repairVideoCover(
  request: VideoCoverRepairRequest,
  signal: AbortSignal,
): Promise<string | null> {
  if (isVideoThumbnailPersistencePending(request.blobName)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const authGeneration = getAuthGeneration();
    const samplingController = new AbortController();
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.crossOrigin = "anonymous";
    let settled = false;
    let routeGeneration = 0;
    let sampling = false;
    const timeoutId = window.setTimeout(() => {
      finish(new DOMException("Video cover repair timed out", "TimeoutError"));
    }, VIDEO_COVER_REPAIR_TIMEOUT_MS);

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      signal.removeEventListener("abort", abort);
      video.removeEventListener("loadedmetadata", loadedMetadata);
      video.removeEventListener("error", mediaError);
      releaseVideo(video);
    };
    const finish = (error: unknown, thumbnailUrl: string | null = null) => {
      if (settled) return;
      settled = true;
      samplingController.abort(new DOMException("Video cover sampling finished", "AbortError"));
      cleanup();
      if (error) reject(error);
      else resolve(thumbnailUrl);
    };
    const abort = () => {
      finish(signal.reason ?? new DOMException("Video cover repair aborted", "AbortError"));
    };
    const loadedMetadata = () => {
      if (signal.aborted || getAuthGeneration() !== authGeneration) {
        abort();
        return;
      }
      if (sampling) return;
      sampling = true;
      const generation = routeGeneration;
      void (async () => {
        let bestCandidate: { score: number; thumbnail: Blob } | null = null;
        for (const time of videoCoverRepairCandidateTimes(video.duration)) {
          await waitForVideoFrame(video, time, samplingController.signal);
          if (generation !== routeGeneration) return;
          const pixels = framePixels(video, video.videoWidth, video.videoHeight);
          if (!pixels) throw new Error("Video frame cannot be inspected");
          const information = videoCoverFrameInformation(pixels);
          const thumbnail = await extractVideoElementThumbnail(video);
          if (
            thumbnail
            && !information.lowInformation
            && (!bestCandidate || information.score > bestCandidate.score)
          ) {
            bestCandidate = { score: information.score, thumbnail };
          }
        }
        if (generation !== routeGeneration) return;
        if (!bestCandidate) {
          finish(null, null);
          return;
        }
        const thumbnailUrl = await setVideoThumbnail(
          request.blobName,
          bestCandidate.thumbnail,
        );
        finish(null, thumbnailUrl);
      })().catch((error: unknown) => {
        if (generation === routeGeneration && !samplingController.signal.aborted) {
          finish(error);
        }
      }).finally(() => {
        if (generation === routeGeneration) sampling = false;
      });
    };
    const mediaError = () => {
      routeGeneration += 1;
      sampling = false;
      if (!fallbackMediaSource(video, [request.originalUrl])) {
        finish(new Error("Both video media routes failed"));
      }
    };

    signal.addEventListener("abort", abort, { once: true });
    video.addEventListener("loadedmetadata", loadedMetadata);
    video.addEventListener("error", mediaError);
    video.src = getPreferredMediaUrl(request.originalUrl);
    video.load();
  });
}

const videoCoverRepairQueue = new VideoCoverRepairQueue({
  execute: repairVideoCover,
  network: networkSnapshot,
  blocked: (request) => isVideoThumbnailPersistencePending(request.blobName),
});

if (typeof window !== "undefined") {
  const handleNetworkChange = () => videoCoverRepairQueue.networkChanged();
  window.addEventListener("online", handleNetworkChange);
  window.addEventListener("offline", handleNetworkChange);
  networkInformation()?.addEventListener("change", handleNetworkChange);
  subscribeToAuthChanges(() => videoCoverRepairQueue.reset());
  subscribeToVideoThumbnailPersistence((blobName, pending, thumbnailUrl) => {
    if (pending) return;
    if (thumbnailUrl) videoCoverRepairQueue.externalSucceeded(blobName, thumbnailUrl);
    else videoCoverRepairQueue.dependencyChanged(blobName);
  });
}

const INITIAL_REPAIR_STATE: VideoCoverRepairState = {
  phase: "idle",
  thumbnailUrl: null,
  reason: null,
  attempts: 0,
};

export function useVideoCoverRepair(photo: Photo) {
  const targetRef = useRef<HTMLDivElement>(null);
  const subscriptionRef = useRef<ReturnType<typeof videoCoverRepairQueue.subscribe> | null>(null);
  const [state, setState] = useState<VideoCoverRepairState>(INITIAL_REPAIR_STATE);

  useEffect(() => {
    setState(INITIAL_REPAIR_STATE);
    if (!photo.contentType.startsWith("video/")) {
      subscriptionRef.current = null;
      return;
    }
    const subscription = videoCoverRepairQueue.subscribe({
      blobName: photo.name,
      originalUrl: photo.url,
      contentType: photo.contentType,
      size: photo.size,
      hasDerivative: Boolean(photo.thumbnailUrl || photo.previewUrl),
      derivativeBroken: false,
    }, setState);
    subscriptionRef.current = subscription;

    const target = targetRef.current;
    if (!target) {
      return () => {
        subscription.dispose();
        subscriptionRef.current = null;
      };
    }

    let idleTaskHandle: number | null = null;
    let idleFallbackHandle: number | null = null;
    const cancelIdle = () => {
      if (idleTaskHandle !== null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleTaskHandle);
      }
      if (idleFallbackHandle !== null) window.clearTimeout(idleFallbackHandle);
      idleTaskHandle = null;
      idleFallbackHandle = null;
    };
    const scheduleVisible = () => {
      cancelIdle();
      if (typeof window.requestIdleCallback === "function") {
        idleTaskHandle = window.requestIdleCallback(
          () => subscription.setVisible(true),
          { timeout: VIDEO_COVER_REPAIR_IDLE_TIMEOUT_MS },
        );
      } else {
        idleFallbackHandle = window.setTimeout(
          () => subscription.setVisible(true),
          0,
        );
      }
    };
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (visible) scheduleVisible();
      else {
        cancelIdle();
        subscription.setVisible(false);
      }
    }, { rootMargin: "600px 0px" });
    observer.observe(target);

    return () => {
      cancelIdle();
      observer.disconnect();
      subscription.setVisible(false);
      subscription.dispose();
      subscriptionRef.current = null;
    };
  }, [
    photo.contentType,
    photo.name,
    photo.previewUrl,
    photo.size,
    photo.thumbnailUrl,
    photo.url,
  ]);

  const markDerivativeBroken = useCallback(() => {
    subscriptionRef.current?.markDerivativeBroken();
  }, []);

  return { targetRef, state, markDerivativeBroken };
}
