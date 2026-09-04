export type PhotoCatalogRolloutPhase = "writers-only" | "enabled";

// First release fence-aware writers without allowing catalog reads or rebuilds.
// Activate paging in a separate commit only after the writers-only deployment drains.
export const PHOTO_CATALOG_ROLLOUT_PHASE: PhotoCatalogRolloutPhase = "writers-only";

export function photoCatalogPagingIsEnabled(
  phase: PhotoCatalogRolloutPhase = PHOTO_CATALOG_ROLLOUT_PHASE,
): boolean {
  return phase === "enabled";
}
