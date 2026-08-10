interface PhotoIdentity {
  name: string;
  originalName?: string;
}

function decodeName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function getPhotoDisplayName(photo: PhotoIdentity): string {
  let candidate = decodeName(photo.originalName?.trim() || photo.name.trim());
  try {
    candidate = decodeName(new URL(candidate).pathname);
  } catch {
    // Blob names are paths rather than absolute URLs.
  }
  const path = candidate.split(/[?#]/, 1)[0].replace(/\\/g, "/");
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] || "未命名照片";
}

export function getMapMarkerLabel(photo: PhotoIdentity): string {
  return `查看照片位置：${getPhotoDisplayName(photo)}`;
}

export function createMapTooltipContent(
  photo: PhotoIdentity,
  documentRoot: Pick<Document, "createElement"> = document,
): HTMLElement {
  const content = documentRoot.createElement("span");
  content.textContent = getPhotoDisplayName(photo);
  return content;
}
