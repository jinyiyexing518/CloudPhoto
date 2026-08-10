export const PWA_UPDATE_READY_EVENT = "cloudphoto-pwa-update-ready";
export const PWA_OFFLINE_READY_EVENT = "cloudphoto-pwa-offline-ready";

export interface PwaUpdateBrowserWindow extends EventTarget {
  __CF_PWA_UPDATE_READY__?: boolean;
  __CF_UPDATE_SW__?: (reloadPage?: boolean) => Promise<void>;
}

export type PwaUpdateActivationResult =
  | "updated"
  | "blocked-transferring"
  | "missing-updater";

export function markPwaUpdateReady(target: PwaUpdateBrowserWindow): void {
  target.__CF_PWA_UPDATE_READY__ = true;
  target.dispatchEvent(new Event(PWA_UPDATE_READY_EVENT));
}

export function isPwaUpdateReady(target: PwaUpdateBrowserWindow): boolean {
  return target.__CF_PWA_UPDATE_READY__ === true;
}

export async function activatePwaUpdate(
  target: PwaUpdateBrowserWindow,
  options: { transferring: boolean },
): Promise<PwaUpdateActivationResult> {
  if (options.transferring) return "blocked-transferring";
  const updateSW = target.__CF_UPDATE_SW__;
  if (!updateSW) return "missing-updater";
  await updateSW(true);
  return "updated";
}
