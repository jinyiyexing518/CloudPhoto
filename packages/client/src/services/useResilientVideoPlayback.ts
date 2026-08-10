import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type VideoHTMLAttributes,
} from "react";
import {
  canCaptureVideoPlaybackThumbnail,
  getMediaUrlForRoute,
  promoteSuccessfulMediaUrl,
  selectFastestVideoMediaRoute,
} from "./mediaRoute";
import {
  claimVideoThumbnailCapture,
  createVideoPlaybackController,
  createVideoPlaybackSession,
  type VideoPlaybackMedia,
  type VideoPlaybackSession,
  type VideoPlaybackStatus,
} from "./videoPlaybackSession";
import { persistVideoPlaybackThumbnail } from "./uploadApi";
import {
  markVideoCoverRepaired,
  videoPlaybackCoverFrameInformation,
} from "./videoCoverRepair";
import { canInspectPlaybackVideoCover } from "./videoCoverRepairPolicy";

interface OpenVideoPlayback {
  photoName: string;
  originalUrl: string;
  needsThumbnailCapture: boolean;
}

interface VideoThumbnailCapturedEvent {
  photoName: string;
  thumbnailUrl: string;
}

interface UseResilientVideoPlaybackOptions {
  onThumbnailCaptured?(event: VideoThumbnailCapturedEvent): void;
}

type VideoEventHandlers = Pick<
  VideoHTMLAttributes<HTMLVideoElement>,
  | "onPlay"
  | "onLoadedMetadata"
  | "onLoadedData"
  | "onPlaying"
  | "onWaiting"
  | "onStalled"
  | "onTimeUpdate"
  | "onCanPlay"
  | "onPause"
  | "onSeeking"
  | "onSeeked"
  | "onEnded"
  | "onError"
>;

export interface ResilientVideoPlayback {
  session: VideoPlaybackSession | null;
  videoRef: RefObject<HTMLVideoElement>;
  buffering: boolean;
  error: boolean;
  eventHandlers: VideoEventHandlers;
  openVideo(playback: OpenVideoPlayback): void;
  closeVideo(): void;
  retryVideo(): void;
}

export function useResilientVideoPlayback({
  onThumbnailCaptured,
}: UseResilientVideoPlaybackOptions = {}): ResilientVideoPlayback {
  const [session, setSessionState] = useState<VideoPlaybackSession | null>(null);
  const [status, setStatus] = useState<VideoPlaybackStatus>("idle");
  const sessionRef = useRef<VideoPlaybackSession | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionIdRef = useRef(0);
  const requestTokenRef = useRef(0);
  const onThumbnailCapturedRef = useRef(onThumbnailCaptured);
  onThumbnailCapturedRef.current = onThumbnailCaptured;

  const setSession = (next: VideoPlaybackSession) => {
    sessionRef.current = next;
    setSessionState(next);
  };

  const controllerRef = useRef<ReturnType<typeof createVideoPlaybackController>>();
  if (!controllerRef.current) {
    controllerRef.current = createVideoPlaybackController({
      getSession: () => sessionRef.current,
      setSession,
      onStatus: setStatus,
      setTimer: (callback, timeoutMs) => window.setTimeout(callback, timeoutMs),
      clearTimer: (timerId) => window.clearTimeout(timerId),
      isVisible: () => document.visibilityState === "visible",
    });
  }
  const controller = controllerRef.current;

  const closeVideo = useCallback(() => {
    requestTokenRef.current += 1;
    controller.dispose();
    sessionRef.current = null;
    setSessionState(null);
    setStatus("idle");
  }, [controller]);

  const openVideo = useCallback(({
    photoName,
    originalUrl,
    needsThumbnailCapture,
  }: OpenVideoPlayback) => {
    const requestToken = ++requestTokenRef.current;
    const sessionId = ++sessionIdRef.current;
    controller.dispose();
    sessionRef.current = null;
    setSessionState(null);
    setStatus("buffering");
    void selectFastestVideoMediaRoute(originalUrl).then((route) => {
      if (requestToken !== requestTokenRef.current) return;
      const next = createVideoPlaybackSession({
        photoName,
        originalUrl,
        sessionId,
        needsThumbnailCapture,
        preferredSource: getMediaUrlForRoute(originalUrl, route),
      });
      setSession(next);
      controller.activate(next);
    });
  }, [controller]);

  const retryVideo = useCallback(() => {
    const video = videoRef.current;
    if (!video || !sessionRef.current) return;
    requestTokenRef.current += 1;
    setStatus("buffering");
    controller.retry(++sessionIdRef.current, video);
  }, [controller]);

  useEffect(() => {
    const onVisibilityChange = () => controller.onVisibilityChange(videoRef.current ?? undefined);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      requestTokenRef.current += 1;
      controller.dispose();
    };
  }, [controller]);

  const eventHandlers = useMemo<VideoEventHandlers>(() => {
    if (!session) return {};
    const key = session.key;
    const maybeCaptureThumbnail = (video: HTMLVideoElement) => {
      const current = sessionRef.current;
      if (!current || current.key !== key) return;
      if (!canInspectPlaybackVideoCover({
        needsCapture: current.needsThumbnailCapture,
        captureAttempted: current.thumbnailCaptureAttempted,
        canCapture: canCaptureVideoPlaybackThumbnail(current.source),
        currentTime: video.currentTime,
      })) {
        return;
      }
      const information = videoPlaybackCoverFrameInformation(video);
      if (!information || information.lowInformation) return;
      const capture = claimVideoThumbnailCapture(current, true);
      if (!capture.shouldCapture) return;
      setSession(capture.session);
      const requestToken = requestTokenRef.current;
      void persistVideoPlaybackThumbnail(current.photoName, video).then((thumbnailUrl) => {
        if (!thumbnailUrl) return;
        markVideoCoverRepaired(current.photoName);
        const active = sessionRef.current;
        if (
          requestToken !== requestTokenRef.current
          || !active
          || active.key !== key
          || active.photoName !== current.photoName
        ) {
          return;
        }
        onThumbnailCapturedRef.current?.({
          photoName: current.photoName,
          thumbnailUrl,
        });
      });
    };
    return {
      onPlay: (event) => controller.onPlay(key, event.currentTarget),
      onLoadedMetadata: (event) => {
        void controller.onLoadedMetadata(key, event.currentTarget);
      },
      onLoadedData: (event) => {
        const video = event.currentTarget;
        if (!controller.onLoadedData(key, video)) return;
        const current = sessionRef.current;
        if (!current || current.key !== key) return;
        if (current.fallbackAttempted) promoteSuccessfulMediaUrl(current.source);
      },
      onPlaying: (event) => {
        controller.onPlaying(key, event.currentTarget);
        maybeCaptureThumbnail(event.currentTarget);
      },
      onWaiting: (event) => controller.onWaiting(key, event.currentTarget),
      onStalled: (event) => controller.onStalled(key, event.currentTarget),
      onTimeUpdate: (event) => {
        controller.onTimeUpdate(key, event.currentTarget);
        maybeCaptureThumbnail(event.currentTarget);
      },
      onCanPlay: (event) => controller.onCanPlay(key, event.currentTarget),
      onPause: (event) => controller.onPause(key, event.currentTarget),
      onSeeking: (event) => controller.onSeeking(key, event.currentTarget),
      onSeeked: (event) => controller.onSeeked(key, event.currentTarget),
      onEnded: (event) => controller.onEnded(key, event.currentTarget),
      onError: (event) => {
        controller.onError(key, event.currentTarget as VideoPlaybackMedia);
      },
    };
  }, [controller, session?.key]);

  return {
    session,
    videoRef,
    buffering: status === "buffering",
    error: status === "error",
    eventHandlers,
    openVideo,
    closeVideo,
    retryVideo,
  };
}
