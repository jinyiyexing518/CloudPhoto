export interface GlobalIntentTarget {
  closest?: (selector: string) => unknown;
}

interface ShortcutEvent {
  key: string;
  defaultPrevented: boolean;
  isComposing: boolean;
  repeat: boolean;
  target: EventTarget | null;
}

export interface ModalQueryRoot {
  querySelector: (selector: string) => unknown;
}

const INTERACTIVE_SHORTCUT_TARGET = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  "summary",
  "[contenteditable]:not([contenteditable=\"false\"])",
  "[role=\"button\"]",
].join(",");

export function isInteractiveGlobalTarget(target: EventTarget | null): boolean {
  return Boolean((target as GlobalIntentTarget | null)?.closest?.(INTERACTIVE_SHORTCUT_TARGET));
}

export function hasOpenAriaModal(modalRoot: ModalQueryRoot): boolean {
  return Boolean(modalRoot.querySelector('[aria-modal="true"]'));
}

function isRepeatedMutationShortcut(event: ShortcutEvent): boolean {
  return event.repeat && (/^[1-6]$/.test(event.key) || event.key.toLowerCase() === "r");
}

export function isGlobalShortcutEligible(
  event: ShortcutEvent,
  modalRoot: ModalQueryRoot,
): boolean {
  if (event.defaultPrevented || event.isComposing || isRepeatedMutationShortcut(event)) {
    return false;
  }
  if (hasOpenAriaModal(modalRoot)) return false;
  return !isInteractiveGlobalTarget(event.target);
}
