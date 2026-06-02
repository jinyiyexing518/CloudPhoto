/**
 * MediaThumb — renders an <img> for photos or a <video> frame-seek thumbnail
 * for videos, with an overlay ▶ badge.
 *
 * Props:
 *   url           — src for img/video
 *   alt           — alt text (img only)
 *   contentType   — MIME type; if it starts with "video/" renders video
 *   className     — class applied to the <img> or <video> element
 *   wrapClass     — when provided, wraps video+badge in <span className={wrapClass}>
 *                   (needed when the parent has no position:relative of its own)
 *   loading       — lazy (default) | eager — passed through to <img>
 */
interface Props {
  url: string;
  alt?: string;
  contentType?: string;
  className?: string;
  wrapClass?: string;
  loading?: "lazy" | "eager";
}

export default function MediaThumb({
  url,
  alt = "",
  contentType,
  className,
  wrapClass,
  loading = "lazy",
}: Props) {
  const isVideo = contentType?.startsWith("video/") ?? false;

  if (!isVideo) {
    return <img src={url} alt={alt} className={className} loading={loading} />;
  }

  const video = (
    <video
      src={url}
      className={className}
      preload="metadata"
      muted
      playsInline
      onLoadedMetadata={(e) => {
        const v = e.currentTarget;
        v.currentTime = Math.min(2, v.duration * 0.1);
      }}
    />
  );

  const badge = <span className="photo-video-badge">▶</span>;

  if (wrapClass) {
    return (
      <span className={wrapClass}>
        {video}
        {badge}
      </span>
    );
  }

  return (
    <>
      {video}
      {badge}
    </>
  );
}
