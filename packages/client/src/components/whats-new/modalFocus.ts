export type ModalTimerHandle = ReturnType<typeof setTimeout>;

export interface ModalTimerHandles {
  idle: ModalTimerHandle | null;
  fade: ModalTimerHandle | null;
  close: ModalTimerHandle | null;
  initialFocus: ModalTimerHandle | null;
}

interface FocusTarget {
  focus: () => void;
  isConnected: boolean;
}

interface TabEvent {
  key: string;
  shiftKey: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

interface FocusContainer extends FocusTarget {
  querySelectorAll: (selectors: string) => ArrayLike<HTMLElement>;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function isVisibleControl(element: HTMLElement): boolean {
  const control = element as HTMLElement & { disabled?: boolean };
  if (control.disabled || element.hidden || element.getAttribute?.("aria-hidden") === "true") {
    return false;
  }
  return typeof element.getClientRects !== "function" || element.getClientRects().length > 0;
}

export function getFocusableElements(container: FocusContainer): HTMLElement[] {
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isVisibleControl);
}

export function focusElement(element: FocusTarget | null): boolean {
  if (!element?.isConnected) return false;
  element.focus();
  return true;
}

export function restoreFocus(element: FocusTarget | null): boolean {
  return focusElement(element);
}

export function trapTabKey(
  event: TabEvent,
  container: FocusContainer,
  activeElement: EventTarget | null,
): boolean {
  if (event.key !== "Tab") return false;

  const controls = getFocusableElements(container);
  if (controls.length === 0) {
    event.preventDefault();
    container.focus();
    return true;
  }

  const first = controls[0];
  const last = controls[controls.length - 1];
  const activeIndex = controls.indexOf(activeElement as HTMLElement);
  const shouldWrapBackward = event.shiftKey && activeIndex <= 0;
  const shouldWrapForward = !event.shiftKey && (activeIndex === -1 || activeIndex === controls.length - 1);
  if (!shouldWrapBackward && !shouldWrapForward) return false;

  event.preventDefault();
  (shouldWrapBackward ? last : first).focus();
  return true;
}

export function handleModalKeyDown(
  event: TabEvent,
  container: FocusContainer,
  activeElement: EventTarget | null,
  dismiss: () => void,
  pin: () => void,
): boolean {
  event.stopPropagation();
  if (event.key === "Escape") {
    event.preventDefault();
    pin();
    dismiss();
    return true;
  }
  if (event.key === "Tab") {
    pin();
    return trapTabKey(event, container, activeElement);
  }
  pin();
  return false;
}

export function clearModalTimers(
  handles: ModalTimerHandles,
  clearTimer: (handle: ModalTimerHandle) => void = clearTimeout,
): void {
  const keys: Array<keyof ModalTimerHandles> = ["idle", "fade", "close", "initialFocus"];
  for (const key of keys) {
    const handle = handles[key];
    if (handle !== null) clearTimer(handle);
    handles[key] = null;
  }
}
