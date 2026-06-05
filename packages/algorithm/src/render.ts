/**
 * Rendering thresholds and constants used by the photo viewer.
 *
 * getViewerSrc() in photoApi.ts selects the right image tier based on the
 * physical pixel count of the viewer window:
 *
 *   physicalPx = Math.round(innerWidth × devicePixelRatio × VIEWER_DPR_SCALE)
 *
 *   ≤ VIEWER_THUMB_THRESHOLD_PX  → thumbnail  (400 px,  fastest)
 *   ≤ VIEWER_PREVIEW_THRESHOLD_PX → preview   (2048 px, ~400 KB)
 *   >  VIEWER_PREVIEW_THRESHOLD_PX → original (lossless, skip on mobile)
 *
 * The 0.85 DPR scale factor accounts for the viewer occupying ~85% of the
 * screen width in full-screen mode rather than the full viewport width.
 */

/** Physical pixel threshold below which the 400 px thumbnail is sufficient. */
export const VIEWER_THUMB_THRESHOLD_PX = 450;

/** Physical pixel threshold below which the 2048 px preview is sufficient. */
export const VIEWER_PREVIEW_THRESHOLD_PX = 2200;

/** Fraction of innerWidth used to estimate the viewer's physical pixel size. */
export const VIEWER_DPR_SCALE = 0.85;
