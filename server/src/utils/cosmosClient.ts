import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

const endpoint = process.env.COSMOS_ENDPOINT as string;
const databaseId = process.env.COSMOS_DATABASE ?? "cloudphoto";

let _client: CosmosClient | null = null;

function getClient(): CosmosClient {
  if (!_client) {
    // On Azure Functions: uses System-assigned Managed Identity.
    // Locally: falls back to Azure CLI credentials (az login).
    // Runtime access only uses existing database/container resources.
    // Required role: "Cosmos DB Built-in Data Contributor" assigned via
    //   az cosmosdb sql role assignment create ...
    _client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
  }
  return _client;
}

function getDatabase() {
  return getClient().database(databaseId);
}

function getContainer(containerId: string): Container {
  return getDatabase().container(containerId);
}

export async function getUsersContainer(): Promise<Container> {
  return getContainer("users");
}

export async function isAdminCandidate(email: string, username: string): Promise<boolean> {
  const container = getContainer("admins");
  const { resources } = await container.items
    .query({
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.email = @email OR c.username = @username",
      parameters: [
        { name: "@email", value: email },
        { name: "@username", value: username },
      ],
    })
    .fetchAll();
  return (resources[0] as number) > 0;
}

export async function getAdminsContainer(): Promise<Container> {
  return getContainer("admins");
}

export interface UserDoc {
  id: string;
  username: string;
  email: string;
  displayName: string;
  passwordHash: string;
  avatar?: string;
  role: "admin" | "viewer";
  privateFolders: string[];
  createdAt: string;
  lastLoginAt: string;
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

export interface GroupDoc {
  id: string;
  name: string;
  description?: string;
  createdBy: string;
  createdAt: string;
  members: GroupMember[];
  folders: string[];
}

export async function getGroupsContainer(): Promise<Container> {
  return getContainer("groups");
}

export async function getUserById(userId: string): Promise<UserDoc | null> {
  try {
    const container = await getUsersContainer();
    const { resource } = await container.item(userId, userId).read<UserDoc>();
    return resource ?? null;
  } catch { return null; }
}

export async function isGroupMember(groupId: string, userId: string): Promise<boolean> {
  try {
    const container = await getGroupsContainer();
    const { resource } = await container.item(groupId, groupId).read<GroupDoc>();
    return resource?.members.some((m) => m.userId === userId) ?? false;
  } catch { return false; }
}

export async function isGroupAdmin(groupId: string, userId: string): Promise<boolean> {
  try {
    const container = await getGroupsContainer();
    const { resource } = await container.item(groupId, groupId).read<GroupDoc>();
    return resource?.members.some((m) => m.userId === userId && m.role === "admin") ?? false;
  } catch { return false; }
}

export async function addFolderToGroup(groupId: string, folderName: string): Promise<void> {
  try {
    const container = await getGroupsContainer();
    const { resource: group } = await container.item(groupId, groupId).read<GroupDoc>();
    if (!group || group.folders.includes(folderName)) return;
    const updated: GroupDoc = { ...group, folders: [...group.folders, folderName] };
    await container.item(groupId, groupId).replace(updated);
  } catch { /* ignore */ }
}

export async function addPrivateFolder(userId: string, folderName: string): Promise<void> {
  try {
    const container = await getUsersContainer();
    const { resource: user } = await container.item(userId, userId).read<UserDoc>();
    if (!user) return;
    const folders = user.privateFolders ?? [];
    if (folders.includes(folderName)) return;
    const updated: UserDoc = { ...user, privateFolders: [...folders, folderName] };
    await container.item(userId, userId).replace(updated);
  } catch { /* ignore */ }
}

// ─── Invites ─────────────────────────────────────────────────────────────────

export type InviteStatus = "pending" | "accepted" | "declined" | "cancelled";

export interface InviteDoc {
  id: string;             // random UUID — used as the invite token
  groupId: string;
  groupName: string;
  email: string;          // lowercase, the invited address
  invitedByUserId: string;
  invitedByName: string;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;      // 7 days after creation
  respondedAt?: string;
}

export async function getInvitesContainer(): Promise<Container> {
  return getContainer("invites");
}

export type ShareLinkStatus = "active" | "revoked" | "expired";
export type ShareLinkTargetType = "photo" | "folder";

export interface ShareLinkDoc {
  docType?: "share";
  id: string;
  createdByUserId: string;
  createdByName: string;
  blobName?: string;
  displayName: string;
  groupId?: string;
  targetType?: ShareLinkTargetType;
  folderPath?: string;
  targetPrefix?: string;
  createdAt: string;
  expiresAt: string;
  status: ShareLinkStatus;
  viewCount: number;
  lastViewedAt?: string;
  revokedAt?: string;
}

export async function getShareLinksContainer(): Promise<Container> {
  return getContainer("sharelinks");
}

export interface MomentInsightDoc {
  id: string;
  photoName: string;
  scopeType: "personal" | "group";
  scopeId: string;
  totalViews: number;
  lastViewedAt?: string;
  lastViewedBy?: string;
  viewers: Record<string, number>;
  dailyViews: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

export async function getMomentsContainer(): Promise<Container> {
  return getContainer("moments");
}
