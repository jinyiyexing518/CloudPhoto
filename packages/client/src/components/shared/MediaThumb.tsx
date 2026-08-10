/**
 * MediaThumb — renders a thumbnail for photos or videos.
 *
 * For videos: if a thumbnail/preview is provided, renders an <img>. When no
 * derivative exists it renders a local placeholder, never an original-video
 * element. The actual video is created only by an explicit playback surface.
 *
 * Props:
 *   url           — full-resolution src (video URL or photo URL)
 *   thumbnailUrl  — preferred low-cost thumbnail; img used for videos when provided
 *   alt           — alt text
 *   contentType   — MIME type; if it starts with "video/" renders video badge
 *   className     — class applied to the inner element
 *   wrapClass     — wraps video+badge in <span className={wrapClass}>
 *   loading       — lazy (default) | eager
 */
import { useEffect, useState } from "react";
import { fallbackMediaSource, getPreferredMediaUrl } from "../../services/mediaRoute";
import { isLowInformationVideoCoverImage } from "../../services/videoCoverRepair";

interface Props {
  url: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  alt?: string;
  contentType?: string;
  className?: string;
  wrapClass?: string;
  loading?: "lazy" | "eager";
  priority?: boolean;
}

export default function MediaThumb({
  url,
  thumbnailUrl,
  previewUrl,
  alt = "",
  contentType,
  className,
  wrapClass,
  loading = "lazy",
  priority = false,
}: Props) {
  const isVideo = contentType?.startsWith("video/") ?? false;
  const derivativeSources = [thumbnailUrl, previewUrl]
    .filter((source): source is string => Boolean(source))
    .map(getPreferredMediaUrl);
  const imageSources = derivativeSources.length > 0
    ? derivativeSources
    : [getPreferredMediaUrl(url)];

  const [videoPosterFailed, setVideoPosterFailed] = useState(false);
  useEffect(() => setVideoPosterFailed(false), [thumbnailUrl, previewUrl]);

  if (!isVideo) {
    return (
      <img
        src={imageSources[0]}
        alt={alt}
        className={className}
        loading={priority ? "eager" : loading}
        fetchPriority={priority ? "high" : "auto"}
        onError={(event) => { fallbackMediaSource(event.currentTarget, imageSources); }}
      />
    );
  }

  // Video with a pre-generated thumbnail image: render as <img> + badge.
  // This avoids downloading ANY video data on mount.
  const videoPoster = videoPosterFailed ? undefined : derivativeSources[0];
  if (videoPoster) {
    const img = (
      <img
        src={videoPoster}
        crossOrigin="anonymous"
        alt={alt}
        className={className}
        loading={priority ? "eager" : loading}
        fetchPriority={priority ? "high" : "auto"}
        onLoad={(event) => {
          if (isLowInformationVideoCoverImage(event.currentTarget) === true) {
            if (!fallbackMediaSource(event.currentTarget, imageSources)) {
              setVideoPosterFailed(true);
            }
          }
        }}
        onError={(event) => {
          if (!fallbackMediaSource(event.currentTarget, imageSources)) {
            setVideoPosterFailed(true);
          }
        }}
      />
    );
    const badge = <span className="photo-video-badge">▶</span>;
    if (wrapClass) return <span className={wrapClass}>{img}{badge}</span>;
    return <>{img}{badge}</>;
  }

  const placeholder = (
    <span
      className={[className, "video-thumb-placeholder"].filter(Boolean).join(" ")}
      role="img"
      aria-label={alt ? `${alt}，打开视频后生成封面` : "打开视频后生成封面"}
    >
      <span className="video-thumb-placeholder-icon" aria-hidden="true">▶</span>
      <span className="video-thumb-placeholder-text">打开视频后生成封面</span>
    </span>
  );
  const badge = <span className="photo-video-badge">▶</span>;
  if (wrapClass) return <span className={wrapClass}>{placeholder}{badge}</span>;
  return <>{placeholder}{badge}</>;
}
