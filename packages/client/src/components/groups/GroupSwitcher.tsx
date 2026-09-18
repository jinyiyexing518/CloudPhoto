import { lazy, Suspense, useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useGroup } from "../../contexts/GroupContext";
import {
  reportLazyBoundaryFailure,
  requestDeploymentRefresh,
} from "../../pwa/deploymentRecovery";
import { renderErrorFallback } from "../shared/ErrorBoundary";
import { focusMenuItem, handleMenuKeyDown } from "../shared/menuKeyboard";
import { useModalFocusBoundary } from "../shared/useModalFocusBoundary";

let createGroupDialogPromise: Promise<typeof import("./CreateGroupDialog")> | null = null;
let groupSettingsPromise: Promise<typeof import("./GroupSettings")> | null = null;

function GroupDialogStatus({
  label,
  onClose,
  failed = false,
}: {
  label: string;
  onClose: () => void;
  failed?: boolean;
}) {
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

  return (
    <div
      ref={layerRef}
      className="dialog-overlay"
      data-modal-layer
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="add-admin-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-busy={!failed}
        tabIndex={-1}
      >
        <div className="add-admin-header">
          <span>{label}</span>
          <button
            ref={closeButtonRef}
            type="button"
            className="dialog-close-btn"
            onClick={onClose}
            aria-label={`关闭${label}`}
          >
            ✕
          </button>
        </div>
        {failed
          ? renderErrorFallback(label, true, requestDeploymentRefresh)
          : <div className="group-settings-loading" role="status">正在加载{label}…</div>}
      </div>
    </div>
  );
}

const unavailableCreateGroupDialogModule: typeof import("./CreateGroupDialog") = {
  default: ({ onClose }) => <GroupDialogStatus label="新建群组" onClose={onClose} failed />,
};
const unavailableGroupSettingsModule: typeof import("./GroupSettings") = {
  default: ({ onClose }) => <GroupDialogStatus label="群组设置" onClose={onClose} failed />,
};

const loadCreateGroupDialog = () => {
  createGroupDialogPromise ??= import("./CreateGroupDialog").then(
    (module) => module ?? unavailableCreateGroupDialogModule,
    (error) => {
      reportLazyBoundaryFailure(error);
      return unavailableCreateGroupDialogModule;
    },
  );
  return createGroupDialogPromise;
};
const loadGroupSettings = () => {
  groupSettingsPromise ??= import("./GroupSettings").then(
    (module) => module ?? unavailableGroupSettingsModule,
    (error) => {
      reportLazyBoundaryFailure(error);
      return unavailableGroupSettingsModule;
    },
  );
  return groupSettingsPromise;
};

const CreateGroupDialog = lazy(loadCreateGroupDialog);
const GroupSettings = lazy(loadGroupSettings);

interface GroupSwitcherProps {
  disabled?: boolean;
  onBeforeSelect?: (nextGroupId: string) => boolean;
  onMenuOpenChange?: (open: boolean) => void;
  onDialogOpenChange?: (open: boolean) => void;
}

const GROUP_SWITCHER_TRIGGER_ID = "group-switcher-trigger";
const GROUP_SWITCHER_MENU_ID = "group-switcher-menu";

export default function GroupSwitcher({
  disabled = false,
  onBeforeSelect,
  onMenuOpenChange,
  onDialogOpenChange,
}: GroupSwitcherProps) {
  const {
    groups,
    currentGroupId,
    setCurrentGroupId,
    refreshGroups,
    loadingGroups,
    selectionRestored,
    groupsError,
  } = useGroup();
  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [settingsGroupId, setSettingsGroupId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onMenuOpenChange?.(open);
  }, [onMenuOpenChange, open]);

  useEffect(() => {
    onDialogOpenChange?.(showCreate || settingsGroupId !== null);
  }, [onDialogOpenChange, settingsGroupId, showCreate]);

  useEffect(() => () => {
    onMenuOpenChange?.(false);
    onDialogOpenChange?.(false);
  }, [onDialogOpenChange, onMenuOpenChange]);

  const closeMenu = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeMenu(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      focusMenuItem(menuRef.current, "selected");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [groups.length, groupsError, loadingGroups, open]);

  useEffect(() => {
    if (disabled && open) closeMenu(true);
  }, [disabled, open]);

  const currentLabel =
    currentGroupId === ""
      ? "个人空间"
      : groups.find((g) => g.id === currentGroupId)?.name ?? "群组";

  const select = (id: string): boolean => {
    if (id === currentGroupId && selectionRestored) {
      closeMenu(true);
      return true;
    }
    if (disabled) return false;
    if (onBeforeSelect && !onBeforeSelect(id)) return false;
    setCurrentGroupId(id);
    closeMenu(true);
    return true;
  };

  const handleCreated = async () => {
    await refreshGroups();
    setShowCreate(false);
  };

  return (
    <>
      <div className="group-switcher" ref={ref}>
        <button
          ref={triggerRef}
          id={GROUP_SWITCHER_TRIGGER_ID}
          type="button"
          className="group-switcher-btn"
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => {
            if (!["ArrowDown", "Enter", " "].includes(event.key)) return;
            event.preventDefault();
            setOpen(true);
          }}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={GROUP_SWITCHER_MENU_ID}
        >
          {currentGroupId ? "👥" : "🏠"} <span className="group-switcher-label">{currentLabel}</span>
          <span className="group-switcher-chevron" aria-hidden="true">▾</span>
        </button>

        {open && (
          <div
            ref={menuRef}
            id={GROUP_SWITCHER_MENU_ID}
            className="group-dropdown"
            role="menu"
            aria-labelledby={GROUP_SWITCHER_TRIGGER_ID}
            onKeyDown={(event) => {
              if (!menuRef.current) return;
              handleMenuKeyDown(
                event,
                menuRef.current,
                document.activeElement,
                closeMenu,
              );
            }}
          >
            <button
              type="button"
              role="menuitemradio"
              tabIndex={-1}
              aria-checked={currentGroupId === ""}
              className={`group-dropdown-item${currentGroupId === "" ? " active" : ""}`}
              onClick={(event) => {
                if (!select("")) event.currentTarget.focus();
              }}
            >
              🏠 个人空间
            </button>

            {groups.length > 0 && <div className="group-dropdown-divider" role="separator" />}

            {loadingGroups && <div className="group-dropdown-loading" role="status">加载中…</div>}

            {groupsError && !loadingGroups && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="group-dropdown-error"
                onClick={() => void refreshGroups()}
              >
                {groupsError}
              </button>
            )}

            {groups.map((g) => (
              <div
                key={g.id}
                role="none"
                className={`group-dropdown-row${currentGroupId === g.id ? " active" : ""}`}
              >
                <button
                  type="button"
                  role="menuitemradio"
                  tabIndex={-1}
                  aria-checked={currentGroupId === g.id}
                  className="group-dropdown-item group-dropdown-label"
                  onClick={(event) => {
                    if (!select(g.id)) event.currentTarget.focus();
                  }}
                >
                  <span className="group-dropdown-name">👥 {g.name}</span>
                  {g.myRole === "admin" && <span className="group-role-tag">管理员</span>}
                </button>
                {g.myRole === "admin" && (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className="group-settings-btn"
                    aria-label={`打开${g.name}的群组设置`}
                    title="群组设置"
                    onClick={() => {
                      closeMenu(true);
                      setSettingsGroupId(g.id);
                    }}
                    onPointerEnter={() => void loadGroupSettings()}
                    onFocus={() => void loadGroupSettings()}
                  >
                    ⚙
                  </button>
                )}
              </div>
            ))}

            <div className="group-dropdown-divider" role="separator" />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="group-dropdown-item group-dropdown-create"
              onClick={() => {
                closeMenu(true);
                setShowCreate(true);
              }}
              onPointerEnter={() => void loadCreateGroupDialog()}
              onFocus={() => void loadCreateGroupDialog()}
            >
              ＋ 新建群组
            </button>
          </div>
        )}
      </div>

      {showCreate && createPortal(
        <Suspense
          fallback={(
            <GroupDialogStatus
              label="新建群组"
              onClose={() => setShowCreate(false)}
            />
          )}
        >
          <CreateGroupDialog
            onClose={() => setShowCreate(false)}
            onCreated={handleCreated}
          />
        </Suspense>,
        document.body,
      )}

      {settingsGroupId && createPortal(
        <Suspense
          fallback={(
            <GroupDialogStatus
              label="群组设置"
              onClose={() => setSettingsGroupId(null)}
            />
          )}
        >
          <GroupSettings
            groupId={settingsGroupId}
            onClose={() => setSettingsGroupId(null)}
            onDeleted={() => { setSettingsGroupId(null); void refreshGroups(); }}
            onUpdated={() => void refreshGroups()}
          />
        </Suspense>,
        document.body,
      )}
    </>
  );
}
