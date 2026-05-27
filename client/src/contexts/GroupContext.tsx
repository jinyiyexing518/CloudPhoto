import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from "react";
import { Group, listGroupsApi } from "../services/groupApi";
import { useAuth } from "./AuthContext";

interface GroupContextValue {
  groups: Group[];
  currentGroupId: string; // "" = personal
  setCurrentGroupId: (id: string) => void;
  refreshGroups: () => Promise<void>;
  loadingGroups: boolean;
  groupsLoaded: boolean;
}

const GroupContext = createContext<GroupContextValue>({
  groups: [],
  currentGroupId: "",
  setCurrentGroupId: () => {},
  refreshGroups: async () => {},
  loadingGroups: false,
  groupsLoaded: false,
});

export function GroupProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [groups, setGroups] = useState<Group[]>([]);
  const [currentGroupId, _setCurrentGroupId] = useState<string>("");
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const restoredRef = useRef(false);

  // Public setter — also persists to localStorage
  const setCurrentGroupId = useCallback((id: string) => {
    _setCurrentGroupId(id);
    if (user) localStorage.setItem(`cf_group_${user.username}`, id);
  }, [user]);

  const refreshGroups = useCallback(async () => {
    if (!user) { setGroups([]); return; }
    setLoadingGroups(true);
    try {
      const list = await listGroupsApi();
      setGroups(list);
      setGroupsLoaded(true);
    } catch {
      setGroups([]);
      setGroupsLoaded(true);
    } finally {
      setLoadingGroups(false);
    }
  }, [user]);

  // Reload groups when user changes
  useEffect(() => {
    void refreshGroups();
  }, [refreshGroups]);

  // After groups load for the first time per login, restore last-used group
  useEffect(() => {
    if (!user || !groupsLoaded || restoredRef.current) return;
    restoredRef.current = true;
    const stored = localStorage.getItem(`cf_group_${user.username}`);
    // Only restore if the group still exists (handles deleted groups gracefully)
    if (stored && stored !== "" && groups.find((g) => g.id === stored)) {
      _setCurrentGroupId(stored); // Bypass persisting setter to avoid a redundant write
    }
    // "" or unknown → stay at personal (default "")
  }, [user, groupsLoaded, groups]);

  // When user logs out, reset everything
  useEffect(() => {
    if (!user) {
      _setCurrentGroupId("");
      setGroups([]);
      setGroupsLoaded(false);
      restoredRef.current = false;
    }
  }, [user]);

  // If the currently-selected group was deleted, fall back to personal
  // Guard with groupsLoaded to avoid resetting during initial load
  useEffect(() => {
    if (!groupsLoaded) return;
    if (currentGroupId && !groups.find((g) => g.id === currentGroupId)) {
      setCurrentGroupId(""); // Uses persisting setter (clears stored value too)
    }
  }, [groups, groupsLoaded, currentGroupId, setCurrentGroupId]);

  return (
    <GroupContext.Provider value={{ groups, currentGroupId, setCurrentGroupId, refreshGroups, loadingGroups, groupsLoaded }}>
      {children}
    </GroupContext.Provider>
  );
}

export function useGroup() {
  return useContext(GroupContext);
}
