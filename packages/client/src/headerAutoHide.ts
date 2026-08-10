export interface HeaderAutoHideSnapshot {
  scrollY: number;
  delta: number;
  sidebarOpen: boolean;
  navigationFocusWithin: boolean;
  headerMenuOpen: boolean;
  headerDialogActive: boolean;
}

export type HeaderVisibilityAction = "reveal" | "hide" | "preserve";

export function getHeaderVisibilityAction({
  scrollY,
  delta,
  sidebarOpen,
  navigationFocusWithin,
  headerMenuOpen,
  headerDialogActive,
}: HeaderAutoHideSnapshot): HeaderVisibilityAction {
  if (
    scrollY < 60
    || sidebarOpen
    || navigationFocusWithin
    || headerMenuOpen
    || headerDialogActive
  ) {
    return "reveal";
  }
  if (delta > 4) return "hide";
  if (delta < -4) return "reveal";
  return "preserve";
}
