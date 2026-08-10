export interface SettingsCloseActivity {
  maintenanceActive: boolean;
  trashActive: boolean;
}

export function getSettingsCloseGuardMessage({
  maintenanceActive,
  trashActive,
}: SettingsCloseActivity): string | null {
  if (trashActive) return "回收站任务运行中，请先点击“停止任务”";
  if (maintenanceActive) return "维护任务运行中，请先点击“停止任务”";
  return null;
}
