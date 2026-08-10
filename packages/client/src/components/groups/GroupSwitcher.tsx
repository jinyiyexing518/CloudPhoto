import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useGroup } from "../../contexts/GroupContext";
import CreateGroupDialog from "./CreateGroupDialog";
import GroupSettings from "./GroupSettings";

export default function GroupSwitcher() {
  const {
    groups,
    currentGroupId,
    setCurrentGroupId,
    refreshGroups,
    loadingGroups,
    groupsError,
  } = useGroup();
  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [settingsGroupId, setSettingsGroupId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const currentLabel =
    currentGroupId === ""
      ? "个人空间"
      : groups.find((g) => g.id === currentGroupId)?.name ?? "群组";

  const select = (id: string) => { setCurrentGroupId(id); setOpen(false); };

  const handleCreated = async () => {
    await refreshGroups();
    setShowCreate(false);
  };

  return (
    <>
      <div className="group-switcher" ref={ref}>
        <button className="group-switcher-btn" onClick={() => setOpen((v) => !v)}>
          {currentGroupId ? "👥" : "🏠"} <span className="group-switcher-label">{currentLabel}</span>
          <span className="group-switcher-chevron">▾</span>
        </button>

        {open && (
          <div className="group-dropdown">
            <div
              className={`group-dropdown-item${currentGroupId === "" ? " active" : ""}`}
              onClick={() => select("")}
            >
              🏠 个人空间
            </div>

            {groups.length > 0 && <div className="group-dropdown-divider" />}

            {loadingGroups && <div className="group-dropdown-loading">加载中…</div>}

            {groupsError && !loadingGroups && (
              <button
                type="button"
                className="group-dropdown-error"
                onClick={() => void refreshGroups()}
              >
                {groupsError}
              </button>
            )}

            {groups.map((g) => (
              <div key={g.id} className={`group-dropdown-item${currentGroupId === g.id ? " active" : ""}`}>
                <span onClick={() => select(g.id)} className="group-dropdown-label">
                  <span className="group-dropdown-name">👥 {g.name}</span>
                  {g.myRole === "admin" && <span className="group-role-tag">管理员</span>}
                </span>
                {g.myRole === "admin" && (
                  <button
                    type="button"
                    className="group-settings-btn"
                    aria-label={`打开${g.name}的群组设置`}
                    title="群组设置"
                    onClick={(e) => { e.stopPropagation(); setSettingsGroupId(g.id); setOpen(false); }}
                  >
                    ⚙
                  </button>
                )}
              </div>
            ))}

            <div className="group-dropdown-divider" />
            <div className="group-dropdown-item group-dropdown-create" onClick={() => { setShowCreate(true); setOpen(false); }}>
              ＋ 新建群组
            </div>
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
