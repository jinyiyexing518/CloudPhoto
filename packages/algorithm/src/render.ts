/** Rendering thresholds and constants shared by gallery surfaces. */

/** Physical pixel threshold below which the 400 px thumbnail is sufficient. */
export const VIEWER_THUMB_THRESHOLD_PX = 450;

/** Fraction of innerWidth used to estimate the viewer's physical pixel size. */
export const VIEWER_DPR_SCALE = 0.85;

/** Number of initially visible derivatives allowed to bypass native lazy loading. */
export const GALLERY_EAGER_MEDIA_COUNT = 6;
export const GRID_MEDIA_POLICY_MARKER = "cloudphoto-grid-derivative-only-v1";

interface GridMediaSource {
  thumbnailUrl?: string;
  previewUrl?: string;
}

/** Returns only derivative tiers that are safe to paint without viewer intent. */
export function selectGridMediaSources({
  thumbnailUrl,
  previewUrl,
}: GridMediaSource): string[] {
  return [thumbnailUrl, previewUrl].filter((source): source is string => Boolean(source));
}

interface ViewerMediaSource {
  originalUrl: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  viewportWidth: number;
  devicePixelRatio: number;
}

/**
 * Picks the first viewer resource without implicitly downloading the original.
 * The full file remains available through the viewer's explicit original action.
 */
export function selectInitialViewerMediaSource({
  originalUrl,
  thumbnailUrl,
  previewUrl,
  viewportWidth,
  devicePixelRatio,
}: ViewerMediaSource): string {
  const physicalViewerPx = Math.round(
    viewportWidth * devicePixelRatio * VIEWER_DPR_SCALE,
  );
  if (physicalViewerPx <= VIEWER_THUMB_THRESHOLD_PX && thumbnailUrl) {
    return thumbnailUrl;
  }
  return previewUrl ?? thumbnailUrl ?? originalUrl;
}
