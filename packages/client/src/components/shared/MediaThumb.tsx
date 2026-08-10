/**
 * MediaThumb — renders a thumbnail for photos or videos.
 *
 * For videos: if a thumbnail/preview is provided, renders an <img>. When no
 * derivative exists it renders a local placeholder, never an original-video
 * element. The actual video is created only by an explicit playback surface.
 *
 * Props:
 *   url           — full-resolution src reserved for an explicit viewer action
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
import { GRID_MEDIA_POLICY_MARKER, selectGridMediaSources } from "@cloudphoto/algorithm";

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
  const derivativeSources = selectGridMediaSources({ thumbnailUrl, previewUrl })
    .map(getPreferredMediaUrl);
  const imageSources = derivativeSources;

  const [videoPosterFailed, setVideoPosterFailed] = useState(false);
  useEffect(() => setVideoPosterFailed(false), [thumbnailUrl, previewUrl]);

  if (!isVideo) {
    if (imageSources.length === 0) {
      return (
        <span
          className={[className, "photo-thumb-placeholder"].filter(Boolean).join(" ")}
          data-media-policy={GRID_MEDIA_POLICY_MARKER}
          role="img"
          aria-label={alt || "照片缩略图暂不可用"}
        />
      );
    }
    return (
      <img
        src={imageSources[0]}
        alt={alt}
        className={className}
        data-media-policy={GRID_MEDIA_POLICY_MARKER}
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
        data-media-policy={GRID_MEDIA_POLICY_MARKER}
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
      data-media-policy={GRID_MEDIA_POLICY_MARKER}
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
