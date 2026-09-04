export type PhotoCatalogRolloutPhase = "writers-only" | "enabled";

// Fence-aware writers have drained in production; retain writers-only as the rollback phase.
export const PHOTO_CATALOG_ROLLOUT_PHASE: PhotoCatalogRolloutPhase = "enabled";

export function photoCatalogPagingIsEnabled(
  phase: PhotoCatalogRolloutPhase = PHOTO_CATALOG_ROLLOUT_PHASE,
): boolean {
  return phase === "enabled";
}
