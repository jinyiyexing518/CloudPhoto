import { useEffect, useRef, useState } from "react";
import type { Photo } from "./photoApi";
import { API_BASE } from "../utils/apiBase";
import { photoDerivativeStrategy } from "../uploadLocation";
import {
  authHeaders,
  fetchWithTimeout,
  getAuthGeneration,
  subscribeToAuthChanges,
} from "./http";
import { getPreferredMediaUrl } from "./mediaRoute";

const PHOTO_COVER_REPAIR_CONCURRENCY = 2;
const PHOTO_COVER_REPAIR_IDLE_TIMEOUT_MS = 2_000;
const PHOTO_COVER_REPAIR_REQUEST_TIMEOUT_MS = 35_000;

export type PhotoCoverRepairPhase =
  | "idle"
  | "queued"
  | "repairing"
  | "succeeded"
  | "unsupported"
  | "failed";

export type PhotoCoverRepairReason =
  | "client-required"
  | "unsupported"
  | "failed"
  | null;

export interface PhotoCoverRepairState {
  phase: PhotoCoverRepairPhase;
  reason: PhotoCoverRepairReason;
  strategy: ReturnType<typeof photoDerivativeStrategy>;
  thumbnailUrl: string | null;
  previewUrl: string | null;
}

interface PhotoCoverRepairResult {
  thumbnailUrl: string;
  previewUrl: string | null;
}

interface RepairJob {
  generation: number;
  onStart: () => void;
  execute: (signal: AbortSignal) => Promise<PhotoCoverRepairResult>;
  resolve: (result: PhotoCoverRepairResult) => void;
  reject: (error: unknown) => void;
}

class PhotoCoverRepairRequestError extends Error {
  constructor(readonly reason: Exclude<PhotoCoverRepairReason, null>) {
    super(reason);
    this.name = "PhotoCoverRepairRequestError";
  }
}

let activeRepairs = 0;
const pendingRepairs: RepairJob[] = [];
const activeRepairControllers = new Set<AbortController>();
const inFlightRepairs = new Map<string, Promise<PhotoCoverRepairResult>>();
const successfulRepairs = new Map<string, PhotoCoverRepairResult>();

function drainPhotoCoverRepairs(): void {
  while (
    activeRepairs < PHOTO_COVER_REPAIR_CONCURRENCY
    && pendingRepairs.length > 0
  ) {
    const job = pendingRepairs.shift()!;
    if (job.generation !== getAuthGeneration()) {
      job.reject(new DOMException("Photo cover repair scope changed", "AbortError"));
      continue;
    }
    const controller = new AbortController();
    activeRepairControllers.add(controller);
    activeRepairs += 1;
    job.onStart();
    void job.execute(controller.signal).then(job.resolve, job.reject).finally(() => {
      activeRepairControllers.delete(controller);
      activeRepairs = Math.max(0, activeRepairs - 1);
      drainPhotoCoverRepairs();
    });
  }
}

function enqueuePhotoCoverRepair(
  generation: number,
  onStart: () => void,
  execute: (signal: AbortSignal) => Promise<PhotoCoverRepairResult>,
): Promise<PhotoCoverRepairResult> {
  return new Promise((resolve, reject) => {
    pendingRepairs.push({ generation, onStart, execute, resolve, reject });
    drainPhotoCoverRepairs();
  });
}

async function requestPhotoCoverRepair(
  blobName: string,
  force: boolean,
  onStart: () => void,
): Promise<PhotoCoverRepairResult> {
  const generation = getAuthGeneration();
  const scopeKey = `${generation}:${blobName}`;
  const cached = successfulRepairs.get(scopeKey);
  if (cached && !force) return cached;
  const requestKey = `${scopeKey}:${force ? "force" : "missing"}`;
  const existing = inFlightRepairs.get(requestKey);
  if (existing) return existing;

  const repair = enqueuePhotoCoverRepair(generation, onStart, async (signal) => {
    const params = new URLSearchParams({ blobName });
    if (force) params.set("force", "1");
    const response = await fetchWithTimeout(
      `${API_BASE}/photos/repair-cover?${params}`,
      {
        method: "POST",
        headers: authHeaders(),
        signal,
      },
      PHOTO_COVER_REPAIR_REQUEST_TIMEOUT_MS,
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { code?: string };
      if (body.code === "client_thumbnail_required") {
        throw new PhotoCoverRepairRequestError("client-required");
      }
      if (response.status === 415) {
        throw new PhotoCoverRepairRequestError("unsupported");
      }
      throw new PhotoCoverRepairRequestError("failed");
    }
    const body = await response.json() as {
      thumbnailUrl?: string;
      previewUrl?: string;
    };
    if (!body.thumbnailUrl || generation !== getAuthGeneration()) {
      throw new PhotoCoverRepairRequestError("failed");
    }
    const result = {
      thumbnailUrl: getPreferredMediaUrl(body.thumbnailUrl),
      previewUrl: body.previewUrl
        ? getPreferredMediaUrl(body.previewUrl)
        : null,
    };
    successfulRepairs.set(scopeKey, result);
    return result;
  });
  inFlightRepairs.set(requestKey, repair);
  try {
    return await repair;
  } finally {
    if (inFlightRepairs.get(requestKey) === repair) {
      inFlightRepairs.delete(requestKey);
    }
  }
}

if (typeof window !== "undefined") {
  subscribeToAuthChanges(() => {
    for (const controller of activeRepairControllers) {
      controller.abort(new DOMException("Photo cover repair scope changed", "AbortError"));
    }
    const abandoned = pendingRepairs.splice(0);
    for (const job of abandoned) {
      job.reject(new DOMException("Photo cover repair scope changed", "AbortError"));
    }
    inFlightRepairs.clear();
    successfulRepairs.clear();
  });
}

function initialState(photo: Photo): PhotoCoverRepairState {
  const strategy = photoDerivativeStrategy(photo.contentType);
  const hasDerivative = Boolean(photo.thumbnailUrl || photo.previewUrl);
  if (!hasDerivative && strategy === "client") {
    return {
      phase: "unsupported",
      reason: "client-required",
      strategy,
      thumbnailUrl: null,
      previewUrl: null,
    };
  }
  if (!hasDerivative && strategy === "none" && !photo.contentType.startsWith("video/")) {
    return {
      phase: "unsupported",
      reason: "unsupported",
      strategy,
      thumbnailUrl: null,
      previewUrl: null,
    };
  }
  return {
    phase: "idle",
    reason: null,
    strategy,
    thumbnailUrl: null,
    previewUrl: null,
  };
}

export function usePhotoCoverRepair(
  photo: Photo,
  {
    eligible,
    derivativeBroken,
    retryKey,
  }: {
    eligible: boolean;
    derivativeBroken: boolean;
    retryKey: number;
  },
): PhotoCoverRepairState {
  const [state, setState] = useState<PhotoCoverRepairState>(() => initialState(photo));
  const lastAttemptRef = useRef("");

  useEffect(() => {
    const nextInitialState = initialState(photo);
    const hasDerivative = Boolean(photo.thumbnailUrl || photo.previewUrl);
    const needsRepair = nextInitialState.strategy === "server"
      && (!hasDerivative || derivativeBroken);
    if (!needsRepair) {
      lastAttemptRef.current = "";
      setState(nextInitialState);
      return;
    }
    if (!eligible) {
      setState({
        ...nextInitialState,
        phase: "idle",
        reason: null,
      });
      return;
    }

    const generation = getAuthGeneration();
    const force = derivativeBroken || retryKey > 0;
    const attemptKey = [
      String(generation),
      photo.name,
      hasDerivative ? "derivative" : "missing",
      derivativeBroken ? "broken" : "healthy",
      String(retryKey),
    ].join("\n");
    if (lastAttemptRef.current === attemptKey) return;
    lastAttemptRef.current = attemptKey;
    let active = true;
    let idleTaskHandle: number | null = null;
    let idleFallbackHandle: number | null = null;
    const run = () => {
      if (!active) return;
      setState({
        ...nextInitialState,
        phase: "queued",
        reason: null,
      });
      void requestPhotoCoverRepair(
        photo.name,
        force,
        () => {
          if (!active) return;
          setState({
            ...nextInitialState,
            phase: "repairing",
            reason: null,
          });
        },
      ).then((result) => {
        if (!active || generation !== getAuthGeneration()) return;
        setState({
          ...nextInitialState,
          phase: "succeeded",
          reason: null,
          thumbnailUrl: result.thumbnailUrl,
          previewUrl: result.previewUrl,
        });
      }).catch((error: unknown) => {
        if (!active || generation !== getAuthGeneration()) return;
        const reason = error instanceof PhotoCoverRepairRequestError
          ? error.reason
          : "failed";
        setState({
          ...nextInitialState,
          phase: reason === "failed" ? "failed" : "unsupported",
          reason,
        });
      });
    };

    setState({
      ...nextInitialState,
      phase: "queued",
      reason: null,
    });
    if (typeof window.requestIdleCallback === "function") {
      idleTaskHandle = window.requestIdleCallback(run, {
        timeout: PHOTO_COVER_REPAIR_IDLE_TIMEOUT_MS,
      });
    } else {
      idleFallbackHandle = window.setTimeout(run, 0);
    }

    return () => {
      active = false;
      if (idleTaskHandle !== null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleTaskHandle);
      }
      if (idleFallbackHandle !== null) window.clearTimeout(idleFallbackHandle);
    };
  }, [
    derivativeBroken,
    eligible,
    photo.contentType,
    photo.name,
    photo.previewUrl,
    photo.thumbnailUrl,
    retryKey,
  ]);

  return state;
}
