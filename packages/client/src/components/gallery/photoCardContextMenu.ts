export type PhotoContextMenuNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

interface PhotoContextMenuPositionInput {
  clientX: number;
  clientY: number;
  anchorRect: Pick<DOMRect, "left" | "top" | "width" | "height">;
  viewportWidth: number;
  viewportHeight: number;
  itemCount: number;
}

const VIEWPORT_MARGIN = 8;
const MENU_WIDTH = 180;
const MENU_VERTICAL_PADDING = 8;
const MENU_ITEM_HEIGHT = 44;

export function getPhotoContextMenuPosition({
  clientX,
  clientY,
  anchorRect,
  viewportWidth,
  viewportHeight,
  itemCount,
}: PhotoContextMenuPositionInput): { x: number; y: number } {
  const keyboardGenerated = clientX === 0 && clientY === 0;
  const requestedX = keyboardGenerated ? anchorRect.left + Math.min(16, anchorRect.width) : clientX;
  const requestedY = keyboardGenerated ? anchorRect.top + Math.min(16, anchorRect.height) : clientY;
  const menuHeight = Math.max(MENU_ITEM_HEIGHT, itemCount * MENU_ITEM_HEIGHT + MENU_VERTICAL_PADDING);
  const maxX = Math.max(VIEWPORT_MARGIN, viewportWidth - MENU_WIDTH - VIEWPORT_MARGIN);
  const maxY = Math.max(VIEWPORT_MARGIN, viewportHeight - menuHeight - VIEWPORT_MARGIN);

  return {
    x: Math.min(Math.max(requestedX, VIEWPORT_MARGIN), maxX),
    y: Math.min(Math.max(requestedY, VIEWPORT_MARGIN), maxY),
  };
}

export function getNextPhotoContextMenuIndex(
  currentIndex: number,
  key: PhotoContextMenuNavigationKey,
  itemCount: number,
): number | null {
  if (itemCount <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key === "ArrowDown") return (currentIndex + 1 + itemCount) % itemCount;
  if (key === "ArrowUp") return (currentIndex - 1 + itemCount) % itemCount;
  return null;
}
