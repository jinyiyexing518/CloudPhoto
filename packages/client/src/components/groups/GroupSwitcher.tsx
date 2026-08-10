import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useGroup } from "../../contexts/GroupContext";
import { focusMenuItem, handleMenuKeyDown } from "../shared/menuKeyboard";
import CreateGroupDialog from "./CreateGroupDialog";
import GroupSettings from "./GroupSettings";

interface GroupSwitcherProps {
  disabled?: boolean;
  onBeforeSelect?: (nextGroupId: string) => boolean;
}

const GROUP_SWITCHER_TRIGGER_ID = "group-switcher-trigger";
const GROUP_SWITCHER_MENU_ID = "group-switcher-menu";

export default function GroupSwitcher({ disabled = false, onBeforeSelect }: GroupSwitcherProps) {
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
            >
              ＋ 新建群组
            </button>
          </div>
        )}
      </div>

      {showCreate && createPortal(
        <CreateGroupDialog
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />,
        document.body,
      )}

      {settingsGroupId && createPortal(
        <GroupSettings
          groupId={settingsGroupId}
          onClose={() => setSettingsGroupId(null)}
          onDeleted={() => { setSettingsGroupId(null); void refreshGroups(); }}
          onUpdated={() => void refreshGroups()}
        />,
        document.body,
      )}
    </>
  );
}
