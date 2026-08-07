/**
 * MediaThumb — renders a thumbnail for photos or videos.
 *
 * For videos: if a thumbnail/preview is provided, renders an <img> (zero network cost
 * beyond what the gallery already loaded). Falls back to <video preload="none">
 * only when no thumbnail is available. The old preload="metadata" + seek approach
 * was removed because it downloads video headers on every render, burning MB/s in
 * grid views.
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
  const imageSources = thumbnailUrl || previewUrl
    ? [thumbnailUrl, previewUrl]
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

  // No thumbnail: fall back to <video preload="none"> + badge.
  // The browser will show nothing until the user interacts with it.
  const video = (
    <video
      src={url}
      className={className}
      preload="none"
      muted
      playsInline
    />
  );
  const badge = <span className="photo-video-badge">▶</span>;
  if (wrapClass) return <span className={wrapClass}>{video}{badge}</span>;
  return <>{video}{badge}</>;
}
