const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";

function getToken(): string | null {
  return localStorage.getItem("cloudphoto_token");
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}`, ...extra } : { ...extra };
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---- Types ----
export interface Group {
  id: string;
  name: string;
  description?: string;
  createdBy: string;
  createdAt: string;
  folders: string[];
  myRole?: "admin" | "member";
}

export interface GroupMember {
  userId: string;
  username: string;
  email: string;
  displayName: string;
  role: "admin" | "member";
  joinedAt: string;
  addedBy: string;
}

export interface GroupDetail extends Group {
  members: GroupMember[];
}

// ---- API calls ----
export async function createGroupApi(data: { name: string; description?: string }): Promise<Group> {
  return handleResponse(
    await fetch(`${API_BASE}/groups`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(data),
    })
  );
}

export async function listGroupsApi(): Promise<Group[]> {
  return handleResponse(
    await fetch(`${API_BASE}/groups`, { headers: authHeaders() })
  );
}

export async function getGroupApi(groupId: string): Promise<GroupDetail> {
  return handleResponse(
    await fetch(`${API_BASE}/groups/${groupId}`, { headers: authHeaders() })
  );
}

export async function updateGroupApi(groupId: string, data: { name?: string; description?: string }): Promise<Group> {
  return handleResponse(
    await fetch(`${API_BASE}/groups/${groupId}`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(data),
    })
  );
}

export async function deleteGroupApi(groupId: string): Promise<void> {
  return handleResponse(
    await fetch(`${API_BASE}/groups/${groupId}`, { method: "DELETE", headers: authHeaders() })
  );
}

export async function addMemberApi(groupId: string, identifier: string): Promise<GroupMember & { message?: string }> {
  const isEmail = identifier.includes("@");
  return handleResponse(
    await fetch(`${API_BASE}/groups/${groupId}/members`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(isEmail ? { email: identifier } : { username: identifier }),
    })
  );
}

export async function removeMemberApi(groupId: string, memberId: string): Promise<void> {
  return handleResponse(
    await fetch(`${API_BASE}/groups/${groupId}/members/${memberId}`, { method: "DELETE", headers: authHeaders() })
  );
}

// ─── Invites ─────────────────────────────────────────────────────────────────

export interface PendingInvite {
  id: string;
  email: string;
  invitedByName: string;
  createdAt: string;
  expiresAt: string;
}

export interface InviteInfo {
  id: string;
  groupId: string;
  groupName: string;
  email: string;
  invitedByName: string;
  status: "pending" | "accepted" | "declined" | "cancelled";
  expiresAt: string;
}

export async function createInviteApi(groupId: string, email: string): Promise<{ id: string; email: string; groupName: string; expiresAt: string }> {
  return handleResponse(
    await fetch(`${API_BASE}/groups/${groupId}/invites`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ email }),
    })
  );
}

export async function listGroupInvitesApi(groupId: string): Promise<PendingInvite[]> {
  return handleResponse(
    await fetch(`${API_BASE}/groups/${groupId}/invites`, { headers: authHeaders() })
  );
}

export async function getInviteApi(token: string): Promise<InviteInfo> {
  return handleResponse(await fetch(`${API_BASE}/invites/${token}`));
}

export async function respondInviteApi(token: string, action: "accept" | "decline"): Promise<{ message: string; member?: GroupMember }> {
  return handleResponse(
    await fetch(`${API_BASE}/invites/${token}/respond`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ action }),
    })
  );
}

export async function cancelInviteApi(token: string): Promise<void> {
  return handleResponse(
    await fetch(`${API_BASE}/invites/${token}`, { method: "DELETE", headers: authHeaders() })
  );
}
