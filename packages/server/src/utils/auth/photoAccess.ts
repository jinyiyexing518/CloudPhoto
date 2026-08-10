export interface PhotoAccessIdentity {
  userId: string;
  role: string;
}

export type GroupMembershipCheck = (
  groupId: string,
  userId: string,
) => Promise<boolean>;

export async function canAccessPhotoPath(
  blobName: string,
  identity: PhotoAccessIdentity,
  isGroupMember: GroupMembershipCheck,
): Promise<boolean> {
  if (!blobName || blobName.includes("\\") || blobName.startsWith("/")) return false;
  const segments = blobName.split("/");
  if (
    segments.length < 4
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return false;
  }

  const filename = segments[segments.length - 1];
  const folderSegments = segments.slice(2, -1);
  if (filename.startsWith("_th_") || folderSegments.includes("_voice")) return false;

  const [scopeType, scopeId] = segments;
  if (scopeType === "personal") {
    return scopeId === identity.userId || identity.role === "admin";
  }
  if (scopeType === "groups") {
    return isGroupMember(scopeId, identity.userId);
  }
  return false;
}

function cleanFilename(value: string): string {
  return value
    .replace(/[\/\\:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .trim();
}

export function sanitizeDownloadFilename(
  candidate: string | null | undefined,
  fallback: string,
): string {
  const safeFallback = cleanFilename(fallback) || "photo";
  const cleaned = cleanFilename(candidate ?? "");
  const selected = cleaned && cleaned !== "." && cleaned !== ".."
    ? cleaned
    : safeFallback;
  return Array.from(selected).slice(0, 180).join("");
}
