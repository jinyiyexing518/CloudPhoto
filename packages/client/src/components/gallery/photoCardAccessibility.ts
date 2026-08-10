const UNNAMED_PHOTO_LABEL = "(未命名照片)";

export function getPhotoCardDisplayName(displayName: string): string {
  return displayName.trim() || UNNAMED_PHOTO_LABEL;
}

export function getPhotoCardGroupLabel(displayName: string): string {
  return `照片 ${getPhotoCardDisplayName(displayName)}`;
}

export function getPhotoCardPrimaryLabel(
  displayName: string,
  mediaType: string,
  dateLabel: string | null,
  selectionMode: boolean,
  selected: boolean,
): string {
  const action = selectionMode ? (selected ? "取消选择" : "选择") : "打开";
  const date = dateLabel ? `，${dateLabel}` : "";
  return `${action}${mediaType} ${getPhotoCardDisplayName(displayName)}${date}`;
}
