/**
 * Content priority / importance scoring.
 *
 * Used to rank photos for the Moments feed so the most meaningful memories
 * float to the top without requiring manual curation.
 *
 * Score composition
 * -----------------
 *   favourite flag  → +120   (strongest signal: user explicitly starred it)
 *   subject tag     → +20    (user named it, probably important)
 *   recency bonus   → 0–40   (linear decay over 40 days — recent memories
 *                             feel more vivid, but favourites always win)
 *
 * Total range: 0 – 180.  Threshold for "important" is intentionally left to
 * the caller; the function just scores.
 */

/** Minimal photo shape required for scoring.  Both client and server satisfy
 *  this interface without importing the full Photo type. */
export interface PhotoScoreInput {
  favorite?: boolean;
  subject?: string | null;
  createdAt?: string | null;
  lastModified?: string | Date | null;
}

/**
 * Score a photo's importance for the Moments feed.
 * Higher score = more important = sorted earlier.
 */
export function scorePhotoImportance(photo: PhotoScoreInput): number {
  const ts = new Date(
    (photo.createdAt ?? photo.lastModified ?? 0) as string | number | Date
  ).getTime();
  const recencyDays = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
  return (
    (photo.favorite ? 120 : 0) +
    (photo.subject ? 20 : 0) +
    Math.max(0, 40 - recencyDays)
  );
}

/** Maximum number of photos shown in the Moments feed. */
export const MOMENTS_MAX_PHOTOS = 120;
