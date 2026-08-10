interface MenuContainer {
  querySelectorAll: (selectors: string) => ArrayLike<HTMLElement>;
}

interface MenuKeyboardEvent {
  key: string;
  preventDefault: () => void;
  stopPropagation: () => void;
}

type InitialMenuFocus = "first" | "selected";

const MENU_ITEM_SELECTOR = '[role="menuitem"],[role="menuitemradio"]';

export function getEnabledMenuItems(menu: MenuContainer): HTMLElement[] {
  return Array.from(menu.querySelectorAll(MENU_ITEM_SELECTOR)).filter((item) => (
    !(item as HTMLButtonElement).disabled
    && item.getAttribute?.("aria-disabled") !== "true"
  ));
}

export function focusMenuItem(
  menu: MenuContainer | null,
  initialFocus: InitialMenuFocus,
): boolean {
  if (!menu) return false;
  const items = getEnabledMenuItems(menu);
  const target = initialFocus === "selected"
    ? items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0]
    : items[0];
  if (!target) return false;
  target.focus();
  return true;
}

export function handleMenuKeyDown(
  event: MenuKeyboardEvent,
  menu: MenuContainer,
  activeElement: EventTarget | null,
  dismiss: (restoreFocus: boolean) => void,
): boolean {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    dismiss(true);
    return true;
  }
  if (event.key === "Tab") {
    dismiss(false);
    return true;
  }

  const items = getEnabledMenuItems(menu);
  if (items.length === 0) return false;
  const activeIndex = items.indexOf(activeElement as HTMLElement);
  let nextIndex: number | null = null;

  switch (event.key) {
    case "ArrowDown":
      nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % items.length;
      break;
    case "ArrowUp":
      nextIndex = activeIndex <= 0 ? items.length - 1 : activeIndex - 1;
      break;
    case "Home":
      nextIndex = 0;
      break;
    case "End":
      nextIndex = items.length - 1;
      break;
    default:
      return false;
  }

  event.preventDefault();
  event.stopPropagation();
  items[nextIndex].focus();
  return true;
}
