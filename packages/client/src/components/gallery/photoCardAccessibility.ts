const UNNAMED_PHOTO_LABEL = "(未命名照片)";

export type PhotoAction = "move" | "favorite" | "unfavorite" | "delete";

export interface PhotoCardLabelInput {
  displayName: string;
  isVideo: boolean;
  mediaKind?: "GIF" | "动态照片" | "动图" | "音频";
  favorite: boolean;
  takenDate?: string | null;
  uploadDate?: string | null;
  selectionMode?: boolean;
  selected?: boolean;
}

export interface PhotoMediaKindInput {
  contentType?: string | null;
  isAnimated?: boolean;
}

export function getPhotoMediaKind(input: PhotoMediaKindInput): PhotoCardLabelInput["mediaKind"] {
  const contentType = input.contentType?.toLowerCase();
  if (contentType?.startsWith("audio/")) return "音频";
  if (contentType === "image/gif") return "GIF";
  if (!input.isAnimated) return undefined;
  if (contentType === "image/jpeg" || contentType === "image/jpg") return "动态照片";
  return "动图";
}

function mediaType(input: PhotoCardLabelInput): string {
  if (input.isVideo) return "视频";
  return input.mediaKind ?? "照片";
}

function stateParts(input: PhotoCardLabelInput): string[] {
  const parts = [];
  if (input.selectionMode) parts.push(input.selected ? "已选择" : "未选择");
  parts.push(input.favorite ? "已收藏" : "未收藏");
  return parts;
}

export function getPhotoCardDisplayName(displayName: string): string {
  return displayName.trim() || UNNAMED_PHOTO_LABEL;
}

export function getPhotoDisplayName(name: string, originalName?: string): string {
  if (originalName?.trim()) return originalName.trim();
  const basename = name.split("/").pop() ?? name;
  return getPhotoCardDisplayName(basename.replace(/^\d+-/, ""));
}

export function getPhotoCardGroupLabel(input: PhotoCardLabelInput): string {
  return [`${mediaType(input)} ${getPhotoCardDisplayName(input.displayName)}`, ...stateParts(input)].join("，");
}

export function getPhotoPrimaryActionLabel(input: PhotoCardLabelInput): string {
  const action = input.selectionMode
    ? (input.selected ? "取消选择" : "选择")
    : "打开";
  const parts = [`${action}${mediaType(input)} ${getPhotoCardDisplayName(input.displayName)}`];
  if (input.takenDate) parts.push(`拍摄日期 ${input.takenDate}`);
  if (input.uploadDate) parts.push(`上传日期 ${input.uploadDate}`);
  parts.push(input.favorite ? "已收藏" : "未收藏");
  return parts.join("，");
}

export function getPhotoActionLabel(action: PhotoAction, displayName: string): string {
  const verbs: Record<PhotoAction, string> = {
    move: "移动照片",
    favorite: "收藏照片",
    unfavorite: "取消收藏照片",
    delete: "删除照片",
  };
  return `${verbs[action]} ${getPhotoCardDisplayName(displayName)}`;
}
