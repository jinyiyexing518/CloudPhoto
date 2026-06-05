/**
 * Bandwidth optimisation strategies.
 *
 * These constants drive the HTTP Range Request approach for video thumbnail
 * extraction, keeping per-card bandwidth at most 512 KB instead of the full
 * video file (10 MB – 200 MB+).
 *
 * Background
 * ----------
 * Modern phone recordings (iOS Camera, most Android) produce "faststart"
 * MP4 files where the `moov` atom (metadata, codec info, seek table) is
 * placed at the BEGINNING of the file.  A single Range: bytes=0-524287
 * request therefore returns all the data needed to:
 *   1. Decode video codec / resolution / duration
 *   2. Seek to the first key-frame
 *   3. Draw it to a canvas and save as a WebP thumbnail
 *
 * For non-faststart files the partial response will not contain the `moov`
 * atom and the video element fires an error — the caller should fall back to
 * loading the full URL (el.load() without a Range override).
 */

/** Byte upper bound for the Range Request used to extract a video thumbnail.
 *  512 KB covers the moov atom for the vast majority of faststart MP4s. */
export const VIDEO_THUMB_RANGE_BYTES = 524_287; // 512 KB (inclusive upper bound)

/** Maximum canvas width when capturing a video frame for thumbnail. */
export const VIDEO_THUMB_MAX_WIDTH = 400;

/**
 * IntersectionObserver rootMargin for triggering video thumbnail extraction.
 * The card starts loading when it is within 100 px of the visible viewport.
 */
export const VIDEO_THUMB_PRELOAD_MARGIN = "100px";
