import {
  hasOpenAriaModal,
  isInteractiveGlobalTarget,
  type ModalQueryRoot,
} from "./globalShortcutEligibility.ts";

export type GlobalFileIntentDecision =
  | "accept"
  | "ignore-no-files"
  | "ignore-editor-or-modal"
  | "block-transfer";

interface GlobalFileIntentContext {
  hasFileIntent: boolean;
  target: EventTarget | null;
  modalRoot: ModalQueryRoot;
  transferring: boolean;
  ignoreInteractiveTarget: boolean;
}

export function classifyGlobalFileIntent({
  hasFileIntent,
  target,
  modalRoot,
  transferring,
  ignoreInteractiveTarget,
}: GlobalFileIntentContext): GlobalFileIntentDecision {
  if (!hasFileIntent) return "ignore-no-files";
  if (hasOpenAriaModal(modalRoot) || (ignoreInteractiveTarget && isInteractiveGlobalTarget(target))) {
    return "ignore-editor-or-modal";
  }
  if (transferring) return "block-transfer";
  return "accept";
}
