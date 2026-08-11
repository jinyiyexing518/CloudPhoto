export interface WorkspaceFabPosition {
  x: number;
  y: number;
}

export interface WorkspaceFabSize {
  width: number;
  height: number;
}

export interface WorkspaceFabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WorkspaceFabDragState {
  active: boolean;
  hasDragged: boolean;
  mx: number;
  my: number;
  ox: number;
  oy: number;
}

const POSITION_KEY = "fab-pos";
const VIEWPORT_INSET = 8;

export function accessWorkspaceFabStorage(
  getStorage: () => WorkspaceFabStorage,
): WorkspaceFabStorage | null {
  try {
    return getStorage();
  } catch {
    return null;
  }
}

export function clampWorkspaceFabPosition(
  position: WorkspaceFabPosition,
  viewport: WorkspaceFabSize,
  rail: WorkspaceFabSize,
): WorkspaceFabPosition {
  const maxX = Math.max(VIEWPORT_INSET, viewport.width - rail.width - VIEWPORT_INSET);
  const maxY = Math.max(VIEWPORT_INSET, viewport.height - rail.height - VIEWPORT_INSET);
  return {
    x: Math.max(VIEWPORT_INSET, Math.min(position.x, maxX)),
    y: Math.max(VIEWPORT_INSET, Math.min(position.y, maxY)),
  };
}

export function readWorkspaceFabPosition(
  storage: WorkspaceFabStorage | null,
): WorkspaceFabPosition | null {
  if (!storage) return null;
  try {
    const saved = storage.getItem(POSITION_KEY);
    if (!saved) return null;
    const position = JSON.parse(saved) as Partial<WorkspaceFabPosition>;
    const { x, y } = position;
    if (
      typeof x !== "number"
      || typeof y !== "number"
      || !Number.isFinite(x)
      || !Number.isFinite(y)
      || x < 0
      || y < 0
    ) {
      storage.removeItem(POSITION_KEY);
      return null;
    }
    return { x, y };
  } catch {
    return null;
  }
}

export function persistWorkspaceFabPosition(
  storage: WorkspaceFabStorage | null,
  position: WorkspaceFabPosition,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(POSITION_KEY, JSON.stringify(position));
    return true;
  } catch {
    return false;
  }
}

export function finishWorkspaceFabDrag(
  drag: WorkspaceFabDragState,
): { wasDragged: boolean; origin: WorkspaceFabPosition } {
  const result = {
    wasDragged: drag.hasDragged,
    origin: { x: drag.ox, y: drag.oy },
  };
  drag.active = false;
  drag.hasDragged = false;
  return result;
}
