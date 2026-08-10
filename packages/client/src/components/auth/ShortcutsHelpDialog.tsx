import { useRef } from "react";
import { createPortal } from "react-dom";
import { useModalFocusBoundary } from "../shared/useModalFocusBoundary";

interface Props {
  onClose: () => void;
}

export default function ShortcutsHelpDialog({ onClose }: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useModalFocusBoundary({
    active: true,
    layerRef,
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
    onEscape: () => {
      onClose();
      return true;
    },
  });

  return createPortal(
    <div ref={layerRef} className="dialog-overlay" data-modal-layer onClick={onClose}>
      <div
        ref={dialogRef}
        className="shortcuts-help-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-help-title"
        aria-describedby="shortcuts-help-description"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shortcuts-help-header">
          <span id="shortcuts-help-title">⌨️ 键盘快捷键</span>
          <button
            ref={closeButtonRef}
            type="button"
            className="dialog-close-btn"
            onClick={onClose}
            aria-label="关闭键盘快捷键"
          >
            ✕
          </button>
        </div>
        <p id="shortcuts-help-description" className="shortcuts-help-description">
          以下快捷键可在照片空间中使用。
        </p>
        <ul className="shortcuts-list">
          <li><kbd>R</kbd><span>刷新照片列表</span></li>
          <li><kbd>?</kbd><span>显示 / 关闭本面板</span></li>
          <li><kbd>1 / 2 / 3</kbd><span>切换时间线 / 文件夹 / 重要片段</span></li>
          <li><kbd>4 / 5 / 6</kbd><span>记忆地图 / 时光胶囊 / 自动故事</span></li>
          <li><kbd>S</kbd><span>开启 / 关闭侧边栏</span></li>
          <li><kbd>⌫ Backspace</kbd><span>清空所有筛选条件</span></li>
          <li><kbd>Esc</kbd><span>关闭侧边栏 / 弹框</span></li>
          <li><kbd>← →</kbd><span>照片详情上一张 / 下一张</span></li>
        </ul>
      </div>
    </div>,
    document.body,
  );
}
