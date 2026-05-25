import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { Group, listGroupsApi } from "../services/groupApi";
import { useAuth } from "./AuthContext";

interface GroupContextValue {
  groups: Group[];
  currentGroupId: string; // "" = personal
  setCurrentGroupId: (id: string) => void;
  refreshGroups: () => Promise<void>;
  loadingGroups: boolean;
}

const GroupContext = createContext<GroupContextValue>({
  groups: [],
  currentGroupId: "",
  setCurrentGroupId: () => {},
  refreshGroups: async () => {},
  loadingGroups: false,
});

export function GroupProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [groups, setGroups] = useState<Group[]>([]);
  const [currentGroupId, setCurrentGroupId] = useState<string>("");
  const [loadingGroups, setLoadingGroups] = useState(false);

  const refreshGroups = useCallback(async () => {
    if (!user) { setGroups([]); return; }
    setLoadingGroups(true);
    try {
      const list = await listGroupsApi();
      setGroups(list);
    } catch {
      setGroups([]);
    } finally {
      setLoadingGroups(false);
    }
  }, [user]);

  // Reload groups when user changes
  useEffect(() => {
    void refreshGroups();
  }, [refreshGroups]);

  // When user logs out, reset to personal
  useEffect(() => {
    if (!user) { setCurrentGroupId(""); setGroups([]); }
  }, [user]);

  // If currently selected group was deleted, fall back to personal
  useEffect(() => {
    if (currentGroupId && !groups.find((g) => g.id === currentGroupId)) {
      setCurrentGroupId("");
    }
  }, [groups, currentGroupId]);

  return (
    <GroupContext.Provider value={{ groups, currentGroupId, setCurrentGroupId, refreshGroups, loadingGroups }}>
      {children}
    </GroupContext.Provider>
  );
}

export function useGroup() {
  return useContext(GroupContext);
}
