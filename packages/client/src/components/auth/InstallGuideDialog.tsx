import { useRef } from "react";
import { createPortal } from "react-dom";
import { useModalFocusBoundary } from "../shared/useModalFocusBoundary";

interface Props {
  instructions: string[];
  isStandalone: boolean;
  onClose: () => void;
  restoreFocusTo?: HTMLElement | null;
}

export default function InstallGuideDialog({
  instructions,
  isStandalone,
  onClose,
  restoreFocusTo,
}: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useModalFocusBoundary({
    active: true,
    layerRef,
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
    restoreFocusTo,
    onEscape: () => {
      onClose();
      return true;
    },
  });

  return createPortal(
    <div ref={layerRef} className="dialog-overlay" data-modal-layer onClick={onClose}>
      <div
        ref={dialogRef}
        className="add-admin-dialog install-guide-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-guide-dialog-title"
        aria-describedby="install-guide-dialog-description install-guide-dialog-note"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="add-admin-header">
          <span id="install-guide-dialog-title">安装使用指引</span>
          <button
            ref={closeButtonRef}
            type="button"
            className="dialog-close-btn"
            onClick={onClose}
            aria-label="关闭安装使用指引"
          >
            ✕
          </button>
        </div>
        <p id="install-guide-dialog-description" className="add-admin-hint">
          {isStandalone ? "当前已是 App 模式" : "可同时作为网站和 App 使用"}
        </p>
        <ol className="install-guide-list">
          {instructions.map((item) => <li key={item}>{item}</li>)}
        </ol>
        <p id="install-guide-dialog-note" className="install-guide-note">
          提示：上传或下载过程中，请不要刷新页面或关闭应用窗口。
        </p>
      </div>
    </div>,
    document.body,
  );
}
