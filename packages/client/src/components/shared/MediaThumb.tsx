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
import { fallbackMediaSource } from "../../services/mediaRoute";

interface Props {
  url: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  alt?: string;
  contentType?: string;
  className?: string;
  wrapClass?: string;
  loading?: "lazy" | "eager";
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
}: Props) {
  const isVideo = contentType?.startsWith("video/") ?? false;
  const derivativeSources = [thumbnailUrl, previewUrl]
    .filter((source): source is string => Boolean(source));
  const imageSources = derivativeSources.length > 0
    ? derivativeSources
    : [url];

  if (!isVideo) {
    return (
      <img
        src={imageSources[0]}
        alt={alt}
        className={className}
        loading={loading}
        onError={(event) => { fallbackMediaSource(event.currentTarget, imageSources); }}
      />
    );
  }

  // Video with a pre-generated thumbnail image: render as <img> + badge.
  // This avoids downloading ANY video data on mount.
  const videoPoster = thumbnailUrl ?? previewUrl;
  if (videoPoster) {
    const img = (
      <img
        src={videoPoster}
        alt={alt}
        className={className}
        loading={loading}
        onError={(event) => { fallbackMediaSource(event.currentTarget, imageSources); }}
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
      aria-label={alt || "视频封面暂不可用"}
    />
  );
  const badge = <span className="photo-video-badge">▶</span>;
  if (wrapClass) return <span className={wrapClass}>{placeholder}{badge}</span>;
  return <>{placeholder}{badge}</>;
}
