export const WORKSPACE_TAB_ORDER = [
  "timeline",
  "folder",
  "moments",
  "map",
  "capsule",
  "story",
] as const;

export type ViewTab = (typeof WORKSPACE_TAB_ORDER)[number];

export function isWorkspaceTab(value: string | null): value is ViewTab {
  return value !== null && WORKSPACE_TAB_ORDER.some((tab) => tab === value);
}

export function workspaceTabId(tab: ViewTab): string {
  return `workspace-tab-${tab}`;
}

export function workspaceTabPanelId(tab: ViewTab): string {
  return `workspace-tabpanel-${tab}`;
}

export function getWorkspaceTabFromKey(current: ViewTab, key: string): ViewTab | null {
  if (key === "Home") return WORKSPACE_TAB_ORDER[0];
  if (key === "End") return WORKSPACE_TAB_ORDER[WORKSPACE_TAB_ORDER.length - 1];
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;

  const direction = key === "ArrowRight" ? 1 : -1;
  const currentIndex = WORKSPACE_TAB_ORDER.indexOf(current);
  const nextIndex = (currentIndex + direction + WORKSPACE_TAB_ORDER.length) % WORKSPACE_TAB_ORDER.length;
  return WORKSPACE_TAB_ORDER[nextIndex];
}

export function activateWorkspaceTabWithFocus(
  current: ViewTab,
  target: ViewTab,
  activate: (tab: ViewTab) => boolean,
  focus: (tab: ViewTab) => void,
): boolean {
  const accepted = activate(target);
  focus(accepted ? target : current);
  return accepted;
}
