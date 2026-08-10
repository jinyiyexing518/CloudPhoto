export const CAPSULE_PHOTO_INITIAL_COUNT = 18;
export const CAPSULE_PHOTO_BATCH_SIZE = 12;

export interface IncrementalRenderWindow {
  sourceKey: string;
  count: number;
}

export function createIncrementalRenderWindow(): IncrementalRenderWindow {
  return {
    sourceKey: "",
    count: CAPSULE_PHOTO_INITIAL_COUNT,
  };
}

export function resolveIncrementalVisibleCount(
  windowState: IncrementalRenderWindow,
  sourceKey: string,
  total: number,
  focusedIndex = -1,
): number {
  const safeTotal = Math.max(0, total);
  const requestedCount = windowState.sourceKey === sourceKey
    ? windowState.count
    : Math.max(CAPSULE_PHOTO_INITIAL_COUNT, focusedIndex + 1);
  return Math.min(safeTotal, Math.max(0, requestedCount));
}

export function advanceIncrementalWindow(
  windowState: IncrementalRenderWindow,
  sourceKey: string,
  total: number,
  focusedIndex = -1,
): IncrementalRenderWindow {
  const currentCount = resolveIncrementalVisibleCount(
    windowState,
    sourceKey,
    total,
    focusedIndex,
  );
  return {
    sourceKey,
    count: Math.min(total, currentCount + CAPSULE_PHOTO_BATCH_SIZE),
  };
}
