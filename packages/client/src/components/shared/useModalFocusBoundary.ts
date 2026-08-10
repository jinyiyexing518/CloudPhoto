import { useEffect, useRef, type RefObject } from "react";
import {
  activateModalLayer,
  deactivateModalLayer,
  focusElement,
  isTopModalLayer,
  refreshModalIsolation,
  restoreFocus,
  trapTabKey,
} from "./modalFocus";

interface ModalBoundaryOptions {
  active: boolean;
  layerRef: RefObject<HTMLElement | null>;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusTo?: HTMLElement | null;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  onEscape: (event: KeyboardEvent) => boolean | void;
  onKeyDown?: (event: KeyboardEvent) => void;
}

export function useModalFocusBoundary({
  active,
  layerRef,
  containerRef,
  initialFocusRef,
  restoreFocusTo,
  restoreFocusRef,
  onEscape,
  onKeyDown,
}: ModalBoundaryOptions): void {
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onEscapeRef = useRef(onEscape);
  const onKeyDownRef = useRef(onKeyDown);
  onEscapeRef.current = onEscape;
  onKeyDownRef.current = onKeyDown;

  useEffect(() => {
    if (!active) return;
    const layer = layerRef.current;
    const container = containerRef.current;
    if (!layer || !container) return;

    previousFocusRef.current = restoreFocusTo ?? restoreFocusRef?.current ?? (
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    );
    activateModalLayer(layer, document);

    const initialFocusTimer = window.setTimeout(() => {
      if (!isTopModalLayer(layer)) return;
      focusElement(initialFocusRef?.current ?? container);
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopModalLayer(layer)) return;
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (event.key === "Tab") {
        trapTabKey(event, container, document.activeElement);
        return;
      }
      if (event.key === "Escape") {
        if (onEscapeRef.current(event) !== false) event.preventDefault();
        return;
      }
      onKeyDownRef.current?.(event);
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!isTopModalLayer(layer) || container.contains(event.target as Node)) return;
      focusElement(initialFocusRef?.current ?? container);
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", handleFocusIn, true);
    const bodyObserver = new MutationObserver(() => refreshModalIsolation(document));
    bodyObserver.observe(document.body, { childList: true });

    return () => {
      window.clearTimeout(initialFocusTimer);
      bodyObserver.disconnect();
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", handleFocusIn, true);
      deactivateModalLayer(layer, document);
      restoreFocus(restoreFocusRef?.current ?? previousFocusRef.current);
      previousFocusRef.current = null;
    };
  }, [active, containerRef, initialFocusRef, layerRef, restoreFocusRef, restoreFocusTo]);
}
