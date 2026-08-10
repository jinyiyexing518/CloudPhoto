/** Rendering thresholds and constants shared by gallery surfaces. */

/** Physical pixel threshold below which the 400 px thumbnail is sufficient. */
export const VIEWER_THUMB_THRESHOLD_PX = 450;

/** Fraction of innerWidth used to estimate the viewer's physical pixel size. */
export const VIEWER_DPR_SCALE = 0.85;

/** Number of initially visible derivatives allowed to bypass native lazy loading. */
export const GALLERY_EAGER_MEDIA_COUNT = 6;

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
