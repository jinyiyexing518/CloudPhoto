export const UNCATEGORIZED_FOLDER_LABEL = "(未分类)";

export function getFolderDisplayName(name: string): string {
  return name.trim() || UNCATEGORIZED_FOLDER_LABEL;
}

export function getFolderGroupLabel(name: string): string {
  return `文件夹 ${getFolderDisplayName(name)}`;
}

export function getFolderOpenLabel(name: string, count: number): string {
  return `打开文件夹 ${getFolderDisplayName(name)}，${count} 张照片`;
}
