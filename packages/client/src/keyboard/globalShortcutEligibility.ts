interface ShortcutTarget {
  closest?: (selector: string) => unknown;
}

interface ShortcutEvent {
  key: string;
  defaultPrevented: boolean;
  isComposing: boolean;
  repeat: boolean;
  target: EventTarget | null;
}

interface ModalQueryRoot {
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
  if (modalRoot.querySelector('[aria-modal="true"]')) return false;

  const target = event.target as ShortcutTarget | null;
  return !target?.closest?.(INTERACTIVE_SHORTCUT_TARGET);
}
