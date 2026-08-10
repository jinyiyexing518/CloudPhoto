export interface HeaderAutoHideSnapshot {
  scrollY: number;
  delta: number;
  sidebarOpen: boolean;
  headerFocusWithin: boolean;
  headerMenuOpen: boolean;
  headerDialogActive: boolean;
}

export type HeaderVisibilityAction = "reveal" | "hide" | "preserve";

export function getHeaderVisibilityAction({
  scrollY,
  delta,
  sidebarOpen,
  headerFocusWithin,
  headerMenuOpen,
  headerDialogActive,
}: HeaderAutoHideSnapshot): HeaderVisibilityAction {
  if (
    scrollY < 60
    || sidebarOpen
    || headerFocusWithin
    || headerMenuOpen
    || headerDialogActive
  ) {
    return "reveal";
  }
  if (delta > 4) return "hide";
  if (delta < -4) return "reveal";
  return "preserve";
}
