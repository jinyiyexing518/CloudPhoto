import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from "react";
import { Group, listGroupsApi } from "../services/groupApi";
import { useAuth } from "./AuthContext";
import { canExposeWorkspaceSelection } from "../services/photoLoadingPolicy";

interface GroupContextValue {
  groups: Group[];
  currentGroupId: string; // "" = personal
  setCurrentGroupId: (id: string) => void;
  refreshGroups: () => Promise<void>;
  loadingGroups: boolean;
  groupsLoaded: boolean;
  selectionRestored: boolean;
  groupsError: string | null;
}

const GroupContext = createContext<GroupContextValue>({
  groups: [],
  currentGroupId: "",
  setCurrentGroupId: () => {},
  refreshGroups: async () => {},
  loadingGroups: false,
  groupsLoaded: false,
  selectionRestored: false,
  groupsError: null,
});
const EMPTY_GROUPS: Group[] = [];

export function GroupProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [groups, setGroups] = useState<Group[]>([]);
  const [currentGroupId, _setCurrentGroupId] = useState<string>("");
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [selectionRestored, setSelectionRestored] = useState(false);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const restoredRef = useRef(false);
  const refreshGenerationRef = useRef(0);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const groupsOwnerIdRef = useRef<string | null>(null);
  const selectionOwnerIdRef = useRef<string | null>(null);
  const currentUserIdRef = useRef<string | null>(user?.id ?? null);
  currentUserIdRef.current = user?.id ?? null;

  // Public setter — also persists to localStorage
  const setCurrentGroupId = useCallback((id: string) => {
    selectionOwnerIdRef.current = user?.id ?? null;
    setSelectionRestored(Boolean(user));
    _setCurrentGroupId(id);
    if (user) localStorage.setItem(`cf_group_${user.username}`, id);
  }, [user?.id, user?.username]);

  const refreshGroups = useCallback(async () => {
    const userId = user?.id ?? null;
    if (userId !== currentUserIdRef.current) return;
    const generation = ++refreshGenerationRef.current;
    refreshAbortRef.current?.abort();
    if (!userId) {
      refreshAbortRef.current = null;
      setGroups([]);
      setGroupsLoaded(false);
      setSelectionRestored(false);
      setGroupsError(null);
      setLoadingGroups(false);
      return;
    }
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    setLoadingGroups(true);
    setGroupsError(null);
    try {
      const list = await listGroupsApi(controller.signal);
      if (
        controller.signal.aborted
        || generation !== refreshGenerationRef.current
        || userId !== currentUserIdRef.current
      ) return;
      groupsOwnerIdRef.current = userId;
      setGroups(list);
      setGroupsLoaded(true);
    } catch {
      if (
        controller.signal.aborted
        || generation !== refreshGenerationRef.current
        || userId !== currentUserIdRef.current
      ) return;
      groupsOwnerIdRef.current = userId;
      setGroupsError("群组加载失败，请重试");
    } finally {
      if (
        generation === refreshGenerationRef.current
        && userId === currentUserIdRef.current
      ) {
        setLoadingGroups(false);
        if (refreshAbortRef.current === controller) refreshAbortRef.current = null;
      }
    }
  }, [user?.id]);

  // Reload groups when user changes
  useEffect(() => {
    refreshGenerationRef.current++;
    refreshAbortRef.current?.abort();
    refreshAbortRef.current = null;
    groupsOwnerIdRef.current = null;
    selectionOwnerIdRef.current = user?.id ?? null;
    _setCurrentGroupId("");
    setGroups([]);
    setGroupsLoaded(false);
    const storedGroupId = user
      ? localStorage.getItem(`cf_group_${user.username}`)
      : null;
    setSelectionRestored(Boolean(user && !storedGroupId));
    setGroupsError(null);
    setLoadingGroups(false);
    restoredRef.current = false;
    if (user) void refreshGroups();
    return () => {
      refreshGenerationRef.current++;
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = null;
    };
  }, [user?.id, refreshGroups]);

  const groupsAreCurrent = Boolean(user && groupsOwnerIdRef.current === user.id);
  const visibleGroups = groupsAreCurrent ? groups : EMPTY_GROUPS;
  const visibleGroupId = groupsAreCurrent ? currentGroupId : "";
  const visibleGroupsLoaded = groupsAreCurrent && groupsLoaded;
  const visibleGroupsError = groupsAreCurrent ? groupsError : null;
  const visibleSelectionRestored = canExposeWorkspaceSelection({
    userId: user?.id ?? null,
    selectionOwnerId: selectionOwnerIdRef.current,
    selectionRestored,
  });

  // After groups load for the first time per login, restore last-used group
  useEffect(() => {
    if (!user || !visibleGroupsLoaded || restoredRef.current) return;
    restoredRef.current = true;
    const stored = localStorage.getItem(`cf_group_${user.username}`);
    // Only restore if the group still exists (handles deleted groups gracefully)
    if (stored && stored !== "" && visibleGroups.find((g) => g.id === stored)) {
      _setCurrentGroupId(stored); // Bypass persisting setter to avoid a redundant write
    }
    // "" or unknown → stay at personal (default "")
    setSelectionRestored(true);
  }, [user, visibleGroupsLoaded, visibleGroups]);

  // If the currently-selected group was deleted, fall back to personal
  // Guard with groupsLoaded to avoid resetting during initial load
  useEffect(() => {
    if (!visibleGroupsLoaded) return;
    if (visibleGroupId && !visibleGroups.find((g) => g.id === visibleGroupId)) {
      setCurrentGroupId(""); // Uses persisting setter (clears stored value too)
    }
  }, [visibleGroups, visibleGroupsLoaded, visibleGroupId, setCurrentGroupId]);

  return (
    <GroupContext.Provider value={{
      groups: visibleGroups,
      currentGroupId: visibleGroupId,
      setCurrentGroupId,
      refreshGroups,
      loadingGroups,
      groupsLoaded: visibleGroupsLoaded,
      selectionRestored: visibleSelectionRestored,
      groupsError: visibleGroupsError,
    }}>
      {children}
    </GroupContext.Provider>
  );
}

export function useGroup() {
  return useContext(GroupContext);
}
