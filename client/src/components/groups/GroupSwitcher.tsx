import { useState, useRef, useEffect } from "react";
import { useGroup } from "../../contexts/GroupContext";
import CreateGroupDialog from "./CreateGroupDialog";
import GroupSettings from "./GroupSettings";

export default function GroupSwitcher() {
  const { groups, currentGroupId, setCurrentGroupId, refreshGroups, loadingGroups } = useGroup();
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
          {currentGroupId ? "👥" : "🏠"} {currentLabel}
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

            {groups.map((g) => (
              <div key={g.id} className={`group-dropdown-item${currentGroupId === g.id ? " active" : ""}`}>
                <span onClick={() => select(g.id)} className="group-dropdown-label">
                  👥 {g.name}
                  {g.myRole === "admin" && <span className="group-role-tag">管理员</span>}
                </span>
                {g.myRole === "admin" && (
                  <button
                    className="group-settings-btn"
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

      {showCreate && (
        <CreateGroupDialog
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}

      {settingsGroupId && (
        <GroupSettings
          groupId={settingsGroupId}
          onClose={() => setSettingsGroupId(null)}
          onDeleted={() => { setSettingsGroupId(null); void refreshGroups(); }}
          onUpdated={() => void refreshGroups()}
        />
      )}
    </>
  );
}
