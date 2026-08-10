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
  hidden?: boolean;
  getAttribute?: (name: string) => string | null;
  getClientRects?: () => ArrayLike<unknown>;
}

interface TabEvent {
  key: string;
  shiftKey: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

interface FocusContainer extends FocusTarget {
  contains?: (target: Node | null) => boolean;
  querySelectorAll: (selectors: string) => ArrayLike<HTMLElement>;
}

interface ModalIsolationElement {
  inert: boolean;
  hidden: boolean;
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  matches?: (selector: string) => boolean;
  querySelector?: (selector: string) => unknown;
}

interface ModalIsolationDocument {
  body: {
    children: ArrayLike<unknown>;
  };
}

interface ModalLayerSnapshot {
  inert: boolean;
  hidden: boolean;
  ariaHidden: string | null;
}

const modalLayers: ModalIsolationElement[] = [];
const isolationSnapshots = new Map<ModalIsolationElement, ModalLayerSnapshot>();
const modalStackListeners = new Set<() => void>();

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "audio[controls]",
  "video[controls]",
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
  if (
    !element?.isConnected
    || element.hidden
    || element.getAttribute?.("aria-hidden") === "true"
    || (typeof element.getClientRects === "function" && element.getClientRects().length === 0)
  ) {
    return false;
  }
  return focusElement(element);
}

export function isModalShortcutTarget(target: EventTarget | null): boolean {
  return Boolean((target as HTMLElement | null)?.closest?.(
    "input,textarea,select,audio[controls],video[controls],[contenteditable]:not([contenteditable=\"false\"])",
  ));
}

type ModalScrollStyle = Pick<CSSStyleDeclaration, "overflowX" | "overflowY">;

export function isScrollableModalTouchTarget(
  target: Element | null,
  modalLayer: Element,
  readStyle: (element: Element) => ModalScrollStyle = (element) => window.getComputedStyle(element),
): boolean {
  if (!target || !modalLayer.contains(target)) return false;

  let current: Element | null = target;
  while (current && current !== modalLayer) {
    const style = readStyle(current);
    const scrollElement = current as HTMLElement;
    const canScrollY = /(auto|scroll)/.test(style.overflowY)
      && scrollElement.scrollHeight > scrollElement.clientHeight;
    const canScrollX = /(auto|scroll)/.test(style.overflowX)
      && scrollElement.scrollWidth > scrollElement.clientWidth;
    if (canScrollY || canScrollX) return true;
    current = current.parentElement;
  }
  return false;
}

function restoreModalIsolation(): void {
  for (const [element, snapshot] of isolationSnapshots) {
    element.inert = snapshot.inert;
    element.hidden = snapshot.hidden;
    if (snapshot.ariaHidden === null) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", snapshot.ariaHidden);
  }
  isolationSnapshots.clear();
}

function applyModalIsolation(documentRoot: ModalIsolationDocument): void {
  restoreModalIsolation();
  const activeLayer = modalLayers[modalLayers.length - 1];
  if (!activeLayer) return;

  for (const candidate of Array.from(documentRoot.body.children)) {
    const child = candidate as ModalIsolationElement;
    if (
      typeof child?.getAttribute !== "function"
      || typeof child.setAttribute !== "function"
      || typeof child.removeAttribute !== "function"
    ) continue;
    if (child === activeLayer) continue;
    isolationSnapshots.set(child, {
      inert: child.inert,
      hidden: child.hidden,
      ariaHidden: child.getAttribute("aria-hidden"),
    });
    child.inert = true;
    child.setAttribute("aria-hidden", "true");
    if (
      child.matches?.('[aria-modal="true"]')
      || child.querySelector?.('[aria-modal="true"]')
    ) child.hidden = true;
  }
}

export function refreshModalIsolation(
  documentRoot: ModalIsolationDocument = document,
): void {
  applyModalIsolation(documentRoot);
}

export function activateModalLayer(
  layer: ModalIsolationElement,
  documentRoot: ModalIsolationDocument = document,
): void {
  const existingIndex = modalLayers.indexOf(layer);
  if (existingIndex >= 0) modalLayers.splice(existingIndex, 1);
  modalLayers.push(layer);
  applyModalIsolation(documentRoot);
  for (const listener of modalStackListeners) listener();
}

export function deactivateModalLayer(
  layer: ModalIsolationElement,
  documentRoot: ModalIsolationDocument = document,
): void {
  const index = modalLayers.lastIndexOf(layer);
  if (index >= 0) modalLayers.splice(index, 1);
  applyModalIsolation(documentRoot);
  for (const listener of modalStackListeners) listener();
}

export function isTopModalLayer(layer: ModalIsolationElement | null): boolean {
  return Boolean(layer && modalLayers[modalLayers.length - 1] === layer);
}

export function hasActiveModalLayer(): boolean {
  return modalLayers.length > 0;
}

export function subscribeModalStack(listener: () => void): () => void {
  modalStackListeners.add(listener);
  return () => modalStackListeners.delete(listener);
}

export function resetModalLayerStackForTests(): void {
  restoreModalIsolation();
  modalLayers.length = 0;
  modalStackListeners.clear();
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
  pin: () => void = () => undefined,
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
