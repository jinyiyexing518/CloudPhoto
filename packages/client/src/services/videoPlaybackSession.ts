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
  hasPlayableContent: boolean;
  fallbackAttempted: boolean;
  needsThumbnailCapture: boolean;
  thumbnailCaptureAttempted: boolean;
}

interface CreateVideoPlaybackSessionOptions {
  photoName: string;
  originalUrl: string;
  sessionId: number;
  needsThumbnailCapture: boolean;
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
}: CreateVideoPlaybackSessionOptions): VideoPlaybackSession {
  const source = getPreferredMediaUrl(originalUrl);
  return {
    key: `${photoName}:view-${sessionId}`,
    photoName,
    source,
    initialSource: source,
    fallbackSource: alternateMediaUrl(originalUrl, source),
    hasPlayableContent: false,
    fallbackAttempted: false,
    needsThumbnailCapture,
    thumbnailCaptureAttempted: false,
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
): VideoPlaybackSession | null {
  if (
    session.hasPlayableContent
    || session.fallbackAttempted
    || !session.fallbackSource
    || comparableUrl(failedSource) !== comparableUrl(session.source)
  ) {
    return null;
  }
  return {
    ...session,
    source: session.fallbackSource,
    fallbackAttempted: true,
  };
}

export function restartVideoPlaybackSession(
  session: VideoPlaybackSession,
): VideoPlaybackSession {
  return {
    ...session,
    source: session.initialSource,
    hasPlayableContent: false,
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
