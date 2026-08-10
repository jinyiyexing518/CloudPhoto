import {
  getPreferredMediaUrl,
  toDirectMediaUrl,
  toProxyMediaUrl,
} from "./mediaRoute";

export interface VideoPlaybackSession {
  key: string;
  photoName: string;
  source: string;
  initialSource: string;
  fallbackSource?: string;
  attemptedSources: string[];
  hasPlayableContent: boolean;
  fallbackAttempted: boolean;
  needsThumbnailCapture: boolean;
  thumbnailCaptureAttempted: boolean;
  restore?: VideoPlaybackSnapshot;
}

export interface VideoPlaybackSnapshot {
  currentTime: number;
  shouldResume: boolean;
  muted: boolean;
  volume: number;
  playbackRate: number;
}

interface CreateVideoPlaybackSessionOptions {
  photoName: string;
  originalUrl: string;
  sessionId: number;
  needsThumbnailCapture: boolean;
  preferredSource?: string;
  restore?: VideoPlaybackSnapshot;
}

function comparableUrl(url: string): string {
  try {
    const base = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

function alternateMediaUrl(originalUrl: string, source: string): string | undefined {
  const direct = toDirectMediaUrl(originalUrl);
  const proxy = toProxyMediaUrl(direct);
  const alternate = comparableUrl(source) === comparableUrl(direct) ? proxy : direct;
  return comparableUrl(alternate) === comparableUrl(source) ? undefined : alternate;
}

export function createVideoPlaybackSession({
  photoName,
  originalUrl,
  sessionId,
  needsThumbnailCapture,
  preferredSource,
  restore,
}: CreateVideoPlaybackSessionOptions): VideoPlaybackSession {
  const source = preferredSource ?? getPreferredMediaUrl(originalUrl);
  return {
    key: `${photoName}:view-${sessionId}`,
    photoName,
    source,
    initialSource: source,
    fallbackSource: alternateMediaUrl(originalUrl, source),
    attemptedSources: [comparableUrl(source)],
    hasPlayableContent: false,
    fallbackAttempted: false,
    needsThumbnailCapture,
    thumbnailCaptureAttempted: false,
    restore,
  };
}

export function getVideoPlaybackRenderState(
  session: VideoPlaybackSession,
  posterUrl?: string,
): { key: string; source: string; poster?: string } {
  return {
    key: session.key,
    source: session.source,
    poster: posterUrl ? getPreferredMediaUrl(posterUrl) : undefined,
  };
}

export function markVideoPlaybackPlayable(
  session: VideoPlaybackSession,
): VideoPlaybackSession {
  return session.hasPlayableContent
    ? session
    : { ...session, hasPlayableContent: true };
}

export function fallbackVideoPlaybackSession(
  session: VideoPlaybackSession,
  failedSource: string,
  restore?: VideoPlaybackSnapshot,
): VideoPlaybackSession | null {
  const fallbackSource = session.fallbackSource;
  if (
    !fallbackSource
    || comparableUrl(failedSource) !== comparableUrl(session.source)
    || session.attemptedSources.includes(comparableUrl(fallbackSource))
  ) {
    return null;
  }
  return {
    ...session,
    source: fallbackSource,
    attemptedSources: [...session.attemptedSources, comparableUrl(fallbackSource)],
    fallbackAttempted: true,
    restore,
  };
}

export function restartVideoPlaybackSession(
  session: VideoPlaybackSession,
  sessionId: number,
  restore?: VideoPlaybackSnapshot,
): VideoPlaybackSession {
  return {
    ...session,
    key: `${session.photoName}:view-${sessionId}`,
    source: session.initialSource,
    attemptedSources: [comparableUrl(session.initialSource)],
    hasPlayableContent: false,
    fallbackAttempted: false,
    restore,
  };
}

export function claimVideoThumbnailCapture(
  session: VideoPlaybackSession,
): { session: VideoPlaybackSession; shouldCapture: boolean } {
  if (
    !session.hasPlayableContent
    || !session.needsThumbnailCapture
    || session.thumbnailCaptureAttempted
  ) {
    return { session, shouldCapture: false };
  }
  return {
    session: { ...session, thumbnailCaptureAttempted: true },
    shouldCapture: true,
  };
}

export const VIDEO_STALL_WATCHDOG_MS = 4_000;
const VIDEO_PROGRESS_EPSILON_SECONDS = 0.1;
const HAVE_FUTURE_DATA = 3;

export type VideoPlaybackStatus = "idle" | "buffering" | "error";

export interface VideoPlaybackMedia {
  currentSrc: string;
  src: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  readyState: number;
  muted: boolean;
  volume: number;
  playbackRate: number;
  load(): void;
  play(): Promise<void>;
}

interface CreateVideoPlaybackControllerOptions {
  getSession(): VideoPlaybackSession | null;
  setSession(session: VideoPlaybackSession): void;
  onStatus(status: VideoPlaybackStatus): void;
  setTimer(callback: () => void, timeoutMs: number): number;
  clearTimer(timerId: number): void;
  isVisible(): boolean;
}

export interface VideoPlaybackController {
  activate(session: VideoPlaybackSession): void;
  dispose(): void;
  onPlay(sessionKey: string, media: VideoPlaybackMedia): void;
  onLoadedData(sessionKey: string, media: VideoPlaybackMedia): boolean;
  onPlaying(sessionKey: string, media: VideoPlaybackMedia): void;
  onWaiting(sessionKey: string, media: VideoPlaybackMedia): void;
  onStalled(sessionKey: string, media: VideoPlaybackMedia): void;
  onTimeUpdate(sessionKey: string, media: VideoPlaybackMedia): void;
  onCanPlay(sessionKey: string, media: VideoPlaybackMedia): void;
  onPause(sessionKey: string, media: VideoPlaybackMedia): void;
  onSeeking(sessionKey: string, media: VideoPlaybackMedia): void;
  onSeeked(sessionKey: string, media: VideoPlaybackMedia): void;
  onEnded(sessionKey: string, media: VideoPlaybackMedia): void;
  onVisibilityChange(): void;
  onError(sessionKey: string, media: VideoPlaybackMedia): boolean;
  onLoadedMetadata(sessionKey: string, media: VideoPlaybackMedia): Promise<void>;
  retry(sessionId: number, media: VideoPlaybackMedia): VideoPlaybackSession;
}

function finiteTime(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function createVideoPlaybackController({
  getSession,
  setSession,
  onStatus,
  setTimer,
  clearTimer,
  isVisible,
}: CreateVideoPlaybackControllerOptions): VideoPlaybackController {
  let activeKey: string | null = null;
  let watchdogId: number | null = null;
  let watchdogGeneration = 0;
  let watchdogStartTime = 0;
  let playIntent = false;
  let recovering = false;
  let pendingRestore: VideoPlaybackSnapshot | null = null;
  let lastSnapshot: VideoPlaybackSnapshot | null = null;
  let currentStatus: VideoPlaybackStatus = "idle";

  const emitStatus = (status: VideoPlaybackStatus) => {
    currentStatus = status;
    onStatus(status);
  };

  const isCurrent = (sessionKey: string): boolean => (
    activeKey === sessionKey && getSession()?.key === sessionKey
  );

  const isCurrentMedia = (
    sessionKey: string,
    media: VideoPlaybackMedia,
  ): boolean => {
    if (!isCurrent(sessionKey)) return false;
    const current = getSession();
    return Boolean(
      current
      && comparableUrl(media.currentSrc || media.src) === comparableUrl(current.source),
    );
  };

  const canHandleMediaEvent = (
    sessionKey: string,
    media: VideoPlaybackMedia,
  ): boolean => currentStatus !== "error" && isCurrentMedia(sessionKey, media);

  const clearWatchdog = () => {
    watchdogGeneration += 1;
    if (watchdogId !== null) clearTimer(watchdogId);
    watchdogId = null;
  };

  const snapshot = (media: VideoPlaybackMedia): VideoPlaybackSnapshot => {
    const value = {
      currentTime: finiteTime(media.currentTime),
      shouldResume: playIntent || (!media.paused && !media.ended),
      muted: media.muted,
      volume: media.volume,
      playbackRate: media.playbackRate,
    };
    lastSnapshot = value;
    return value;
  };

  const canWatch = (media: VideoPlaybackMedia): boolean => (
    playIntent
    && !media.paused
    && !media.ended
    && !media.seeking
    && media.readyState < HAVE_FUTURE_DATA
    && isVisible()
  );

  const recover = (
    sessionKey: string,
    media: VideoPlaybackMedia,
  ): boolean => {
    if (!isCurrent(sessionKey)) return false;
    const current = getSession();
    if (
      !current
      || comparableUrl(media.currentSrc || media.src) !== comparableUrl(current.source)
    ) {
      return false;
    }
    clearWatchdog();
    const restore = pendingRestore ?? snapshot(media);
    lastSnapshot = restore;
    const fallback = fallbackVideoPlaybackSession(
      current,
      media.currentSrc || media.src,
      restore,
    );
    if (!fallback) {
      recovering = false;
      emitStatus("error");
      return false;
    }
    recovering = true;
    pendingRestore = restore;
    setSession(fallback);
    emitStatus("buffering");
    media.src = fallback.source;
    media.load();
    return true;
  };

  const armWatchdog = (sessionKey: string, media: VideoPlaybackMedia) => {
    if (!canHandleMediaEvent(sessionKey, media)) return;
    if (!canWatch(media)) {
      clearWatchdog();
      emitStatus("idle");
      return;
    }
    emitStatus("buffering");
    if (watchdogId !== null) return;
    watchdogStartTime = finiteTime(media.currentTime);
    const generation = watchdogGeneration;
    watchdogId = setTimer(() => {
      watchdogId = null;
      if (
        generation !== watchdogGeneration
        || !isCurrent(sessionKey)
        || !canWatch(media)
        || finiteTime(media.currentTime) > watchdogStartTime + VIDEO_PROGRESS_EPSILON_SECONDS
      ) {
        return;
      }
      recover(sessionKey, media);
    }, VIDEO_STALL_WATCHDOG_MS);
  };

  return {
    activate(session) {
      clearWatchdog();
      activeKey = session.key;
      setSession(session);
      recovering = Boolean(session.restore);
      pendingRestore = session.restore ?? null;
      lastSnapshot = session.restore ?? null;
      playIntent = session.restore?.shouldResume ?? false;
      emitStatus(session.restore ? "buffering" : "idle");
    },
    dispose() {
      clearWatchdog();
      activeKey = null;
      recovering = false;
      pendingRestore = null;
      lastSnapshot = null;
      playIntent = false;
    },
    onPlay(sessionKey, media) {
      if (!canHandleMediaEvent(sessionKey, media)) return;
      playIntent = true;
      snapshot(media);
      if (media.readyState < HAVE_FUTURE_DATA) emitStatus("buffering");
    },
    onLoadedData(sessionKey, media) {
      if (!canHandleMediaEvent(sessionKey, media)) return false;
      snapshot(media);
      const current = getSession();
      if (current) setSession(markVideoPlaybackPlayable(current));
      emitStatus("idle");
      return true;
    },
    onPlaying(sessionKey, media) {
      if (!canHandleMediaEvent(sessionKey, media)) return;
      clearWatchdog();
      recovering = false;
      playIntent = true;
      snapshot(media);
      const current = getSession();
      if (current) setSession(markVideoPlaybackPlayable(current));
      emitStatus("idle");
    },
    onWaiting: armWatchdog,
    onStalled: armWatchdog,
    onTimeUpdate(sessionKey, media) {
      if (!canHandleMediaEvent(sessionKey, media)) return;
      const progressed = watchdogId !== null
        && finiteTime(media.currentTime) > watchdogStartTime + VIDEO_PROGRESS_EPSILON_SECONDS;
      snapshot(media);
      if (progressed) {
        clearWatchdog();
        emitStatus("idle");
      }
    },
    onCanPlay(sessionKey, media) {
      if (!canHandleMediaEvent(sessionKey, media)) return;
      clearWatchdog();
      snapshot(media);
      emitStatus("idle");
    },
    onPause(sessionKey, media) {
      if (!canHandleMediaEvent(sessionKey, media) || recovering) return;
      playIntent = false;
      snapshot(media);
      clearWatchdog();
      emitStatus("idle");
    },
    onSeeking(sessionKey, media) {
      if (!canHandleMediaEvent(sessionKey, media)) return;
      clearWatchdog();
      snapshot(media);
      emitStatus("idle");
    },
    onSeeked(sessionKey, media) {
      if (!canHandleMediaEvent(sessionKey, media)) return;
      clearWatchdog();
      snapshot(media);
    },
    onEnded(sessionKey, media) {
      if (!canHandleMediaEvent(sessionKey, media)) return;
      playIntent = false;
      snapshot(media);
      clearWatchdog();
      emitStatus("idle");
    },
    onVisibilityChange() {
      if (!isVisible()) {
        clearWatchdog();
        if (currentStatus === "buffering") emitStatus("idle");
      }
    },
    onError: recover,
    async onLoadedMetadata(sessionKey, media) {
      if (!canHandleMediaEvent(sessionKey, media) || !pendingRestore) return;
      const restore = pendingRestore;
      pendingRestore = null;
      media.muted = restore.muted;
      media.volume = restore.volume;
      media.playbackRate = restore.playbackRate;
      const duration = finiteTime(media.duration);
      media.currentTime = duration > 0
        ? Math.min(restore.currentTime, Math.max(0, duration - 0.05))
        : restore.currentTime;
      recovering = false;
      if (!restore.shouldResume) {
        playIntent = false;
        emitStatus("idle");
        return;
      }
      playIntent = true;
      try {
        await media.play();
      } catch {
        if (!canHandleMediaEvent(sessionKey, media)) return;
        playIntent = false;
        emitStatus("idle");
      }
    },
    retry(sessionId, media) {
      const current = getSession();
      if (!current) throw new Error("Cannot retry without an active video session");
      const restore = lastSnapshot ?? snapshot(media);
      const restarted = restartVideoPlaybackSession(current, sessionId, restore);
      setSession(restarted);
      this.activate(restarted);
      return restarted;
    },
  };
}
