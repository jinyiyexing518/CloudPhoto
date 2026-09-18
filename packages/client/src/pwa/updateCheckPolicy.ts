export const PWA_UPDATE_MIN_GAP_MS = 60 * 1000;
export const PWA_STANDALONE_UPDATE_INTERVAL_MS = 5 * 60 * 1000;
export const PWA_BROWSER_UPDATE_INTERVAL_MS = 15 * 60 * 1000;

type UpdateRegistration = Pick<ServiceWorkerRegistration, "update">;
type UpdateWindow = Pick<
  Window,
  "addEventListener" | "removeEventListener" | "setInterval" | "clearInterval"
> & Partial<Pick<Window, "matchMedia">>;
type UpdateDocument = Pick<
  Document,
  "addEventListener" | "removeEventListener" | "visibilityState"
>;
type UpdateNavigator = Pick<Navigator, "onLine"> & { standalone?: boolean };

interface PwaUpdateCheckOptions {
  standalone?: boolean;
  target?: UpdateWindow;
  document?: UpdateDocument;
  navigator?: UpdateNavigator;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export function getPwaUpdateIntervalMs(standalone: boolean): number {
  return standalone
    ? PWA_STANDALONE_UPDATE_INTERVAL_MS
    : PWA_BROWSER_UPDATE_INTERVAL_MS;
}

export function installPwaUpdateChecks(
  registration: UpdateRegistration,
  options: PwaUpdateCheckOptions = {},
): () => void {
  const target = options.target ?? window;
  const pageDocument = options.document ?? document;
  const connection: UpdateNavigator = options.navigator ?? navigator;
  const now = options.now ?? Date.now;
  const onError = options.onError ?? ((error: unknown) => {
    console.warn("[PWA] Background update check failed:", error);
  });
  const standalone = options.standalone ?? (
    target.matchMedia?.("(display-mode: standalone)").matches === true
    || connection.standalone === true
  );
  let lastStartedAt = now();
  let updateInFlight = false;

  const checkForUpdates = (force = false) => {
    const currentTime = now();
    if (
      pageDocument.visibilityState !== "visible"
      || connection.onLine === false
      || updateInFlight
      || (!force && currentTime - lastStartedAt < PWA_UPDATE_MIN_GAP_MS)
    ) {
      return;
    }

    lastStartedAt = currentTime;
    updateInFlight = true;
    let update: Promise<unknown>;
    try {
      update = registration.update();
    } catch (error) {
      updateInFlight = false;
      onError(error);
      return;
    }
    void update.catch(onError).finally(() => {
      updateInFlight = false;
    });
  };

  const onVisibilityChange = () => {
    if (pageDocument.visibilityState === "visible") checkForUpdates();
  };
  const onFocus = () => checkForUpdates();
  const onOnline = () => checkForUpdates(true);
  const interval = target.setInterval(
    checkForUpdates,
    getPwaUpdateIntervalMs(standalone),
  );

  pageDocument.addEventListener("visibilitychange", onVisibilityChange);
  target.addEventListener("focus", onFocus);
  target.addEventListener("online", onOnline);

  return () => {
    target.clearInterval(interval);
    pageDocument.removeEventListener("visibilitychange", onVisibilityChange);
    target.removeEventListener("focus", onFocus);
    target.removeEventListener("online", onOnline);
  };
}
