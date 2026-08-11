export interface PhotoAccessIdentity {
  userId: string;
  role: string;
}

export type GroupMembershipCheck = (
  groupId: string,
  userId: string,
) => Promise<boolean>;

interface ParsedPhotoPath {
  scopeType: "personal" | "groups";
  scopeId: string;
  folderSegments: string[];
  filename: string;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function isInvalidPathSegment(segment: string): boolean {
  return (
    !segment
    || segment === "."
    || segment === ".."
    || segment.includes("\\")
    || CONTROL_CHARACTERS.test(segment)
  );
}

export function isPhotoFolderPath(folderPath: string): boolean {
  const segments = folderPath.split("/");
  return Boolean(
    folderPath
    && segments.every((segment) => !isInvalidPathSegment(segment) && segment !== "_voice"),
  );
}

function parsePhotoPath(blobName: string): ParsedPhotoPath | null {
  if (!blobName || blobName.startsWith("/")) return null;
  const segments = blobName.split("/");
  if (
    segments.length < 4
    || segments.some(isInvalidPathSegment)
  ) {
    return null;
  }

  const [scopeType, scopeId] = segments;
  if (scopeType !== "personal" && scopeType !== "groups") return null;
  return {
    scopeType,
    scopeId,
    folderSegments: segments.slice(2, -1),
    filename: segments[segments.length - 1],
  };
}

function isGalleryPhotoParts(path: ParsedPhotoPath): boolean {
  return (
    !path.filename.startsWith("_th_")
    && isPhotoFolderPath(path.folderSegments.join("/"))
  );
}

export function isGalleryPhotoPath(blobName: string): boolean {
  const path = parsePhotoPath(blobName);
  return Boolean(path && isGalleryPhotoParts(path));
}

export function isPhotoPathWithinScope(
  blobName: string,
  scopePrefix: string,
): boolean {
  const path = parsePhotoPath(blobName);
  const scopeSegments = scopePrefix.split("/");
  return Boolean(
    path
    && isGalleryPhotoParts(path)
    && scopeSegments.length === 2
    && (scopeSegments[0] === "personal" || scopeSegments[0] === "groups")
    && scopeSegments[0] === path.scopeType
    && scopeSegments[1] === path.scopeId,
  );
}

function isSamePhotoScope(left: ParsedPhotoPath, right: ParsedPhotoPath): boolean {
  return left.scopeType === right.scopeType && left.scopeId === right.scopeId;
}

export function isPhotoPathWithinSameScope(
  sourceBlobName: string,
  destinationBlobName: string,
): boolean {
  const source = parsePhotoPath(sourceBlobName);
  const destination = parsePhotoPath(destinationBlobName);
  return Boolean(
    source
    && destination
    && isGalleryPhotoParts(source)
    && isGalleryPhotoParts(destination)
    && isSamePhotoScope(source, destination),
  );
}

export function isVoiceMemoPathWithinPhotoScope(
  photoBlobName: string,
  voiceMemoBlobName: string,
): boolean {
  const photo = parsePhotoPath(photoBlobName);
  const voiceMemo = parsePhotoPath(voiceMemoBlobName);
  return Boolean(
    photo
    && voiceMemo
    && isGalleryPhotoParts(photo)
    && isSamePhotoScope(photo, voiceMemo)
    && voiceMemo.folderSegments.length === 1
    && voiceMemo.folderSegments[0] === "_voice"
    && !voiceMemo.filename.startsWith("_th_"),
  );
}

export async function canAccessPhotoPath(
  blobName: string,
  identity: PhotoAccessIdentity,
  isGroupMember: GroupMembershipCheck,
): Promise<boolean> {
  const path = parsePhotoPath(blobName);
  if (!path || !isGalleryPhotoParts(path)) return false;
  if (path.scopeType === "personal") {
    return path.scopeId === identity.userId || identity.role === "admin";
  }
  return isGroupMember(path.scopeId, identity.userId);
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
