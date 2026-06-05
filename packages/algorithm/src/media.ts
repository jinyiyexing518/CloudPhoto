/**
 * Media processing constants.
 *
 * Server-side code (uploadPhoto.ts, backfillThumbnails.ts) keeps its own
 * local THUMBNAIL_MIME set to avoid a runtime dependency on this package.
 * Values must be kept in sync manually.
 */

/**
 * MIME types for which the server generates a static WebP thumbnail.
 * GIF is included — sharp extracts the first frame as a gallery placeholder.
 *
 * ⚠️  Mirror of the server-side THUMBNAIL_MIME constant.
 *     Update both when adding new types.
 */
export const THUMBNAIL_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** Maximum thumbnail width in pixels (server: sharp, client: canvas). */
export const THUMB_WIDTH = 400;

/** Maximum 2 K preview width in pixels (server: sharp). */
export const PREVIEW_WIDTH = 2048;

/** WebP quality for thumbnails — sharp scale (0–100). */
export const THUMB_QUALITY = 75;

/** WebP quality for thumbnails — canvas.toBlob scale (0–1). */
export const THUMB_QUALITY_FRACTION = 0.75;

/** WebP quality for 2 K previews — sharp scale (0–100). */
export const PREVIEW_QUALITY = 82;

/**
 * 1×1 transparent GIF used as `src` placeholder when an animated image is
 * paused.  Swapping to this URL stops GIF playback without a canvas (which
 * would throw SecurityError on cross-origin SAS URLs).
 */
export const BLANK_GIF =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
