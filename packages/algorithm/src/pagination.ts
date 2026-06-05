/**
 * Pagination and infinite-scroll configuration.
 *
 * PAGE_SIZE controls how many photo cards are rendered per batch.
 * Too small → many observer callbacks + layout thrashing.
 * Too large → high initial paint time + simultaneous thumbnail requests.
 *
 * 24 fits cleanly into 2, 3, 4 and 6-column grids (mobile→desktop) and
 * keeps the first-paint request count below the HTTP/2 multiplexing sweet
 * spot (~20-30 parallel requests per connection).
 */

/** Photo cards rendered per page in the gallery. */
export const DEFAULT_PAGE_SIZE = 24;

/**
 * IntersectionObserver rootMargin for the infinite-scroll sentinel.
 * The next page starts loading when the sentinel is within 200 px of the
 * visible viewport — early enough that cards appear before the user reaches
 * the bottom, but not so early that every scroll loads a new page.
 */
export const SCROLL_SENTINEL_MARGIN = "200px";

/** Calculate how many full pages cover a given photo index. */
export function pagesForIndex(
  index: number,
  pageSize = DEFAULT_PAGE_SIZE,
): number {
  return Math.ceil((index + 1) / pageSize);
}
