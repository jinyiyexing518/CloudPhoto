import { getDangerousOperationSnapshot } from "./dangerousOperationGate.ts";

export const PWA_UPDATE_READY_EVENT = "cloudphoto-pwa-update-ready";
export const PWA_OFFLINE_READY_EVENT = "cloudphoto-pwa-offline-ready";

export interface PwaUpdateBrowserWindow extends EventTarget {
  __CF_PWA_UPDATE_READY__?: boolean;
  __CF_UPDATE_SW__?: (reloadPage?: boolean) => Promise<void>;
  __CF_SW_REGISTRATION__?: ServiceWorkerRegistration;
  __CF_SW_CONTAINER__?: ServiceWorkerContainer;
  __CF_HARD_REFRESH__?: () => void;
}

export type PwaUpdateActivationResult =
  | "updated"
  | "blocked-transferring"
  | "missing-updater"
  | "timed-out";

const UPDATE_ACTIVATION_TIMEOUT_MS = 1_500;

function bounded<T>(promise: Promise<T>): Promise<T | "timed-out"> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve("timed-out"), UPDATE_ACTIVATION_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function waitForWorkerState(worker: ServiceWorker): Promise<void> {
  if (worker.state !== "installing") return Promise.resolve();
  return new Promise((resolve) => {
    const onStateChange = () => {
      if (worker.state === "installing") return;
      worker.removeEventListener("statechange", onStateChange);
      resolve();
    };
    worker.addEventListener("statechange", onStateChange);
  });
}

function waitForControllerChange(container: ServiceWorkerContainer): Promise<void> {
  return new Promise((resolve) => {
    const onControllerChange = () => {
      container.removeEventListener("controllerchange", onControllerChange);
      resolve();
    };
    container.addEventListener("controllerchange", onControllerChange);
  });
}

export function markPwaUpdateReady(target: PwaUpdateBrowserWindow): void {
  target.__CF_PWA_UPDATE_READY__ = true;
  target.dispatchEvent(new Event(PWA_UPDATE_READY_EVENT));
}

export function isPwaUpdateReady(target: PwaUpdateBrowserWindow): boolean {
  return target.__CF_PWA_UPDATE_READY__ === true;
}

export async function activatePwaUpdate(
  target: PwaUpdateBrowserWindow,
): Promise<PwaUpdateActivationResult> {
  if (getDangerousOperationSnapshot().active) return "blocked-transferring";
  const prepared = await preparePwaUpdateForRefresh(target);
  if (prepared === "timed-out") return "timed-out";
  if (prepared === "missing-updater" || !target.__CF_HARD_REFRESH__) {
    return "missing-updater";
  }
  if (getDangerousOperationSnapshot().active) return "blocked-transferring";
  target.__CF_HARD_REFRESH__();
  return "updated";
}

export async function preparePwaUpdateForRefresh(
  target: PwaUpdateBrowserWindow,
): Promise<"ready" | "missing-updater" | "timed-out"> {
  const registration = target.__CF_SW_REGISTRATION__;
  if (!registration) return "missing-updater";
  const updateResult = await bounded(registration.update());
  if (updateResult === "timed-out") return "timed-out";

  const installingWorker = registration.installing;
  if (installingWorker) {
    const installResult = await bounded(waitForWorkerState(installingWorker));
    if (installResult === "timed-out") return "timed-out";
  }
  const waitingWorker = registration.waiting;
  if (!waitingWorker) return "ready";

  const controllerChanged = target.__CF_SW_CONTAINER__
    ? bounded(waitForControllerChange(target.__CF_SW_CONTAINER__))
    : Promise.resolve("timed-out" as const);
  waitingWorker.postMessage({ type: "SKIP_WAITING" });
  const activationResult = await controllerChanged;
  return activationResult === "timed-out" ? "timed-out" : "ready";
}
