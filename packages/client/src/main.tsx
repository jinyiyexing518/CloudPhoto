import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import {
  installDeploymentRecovery,
  reportLazyBoundaryFailure,
} from "./pwa/deploymentRecovery";

const PWA_UPDATE_READY_EVENT = "cloudphoto-pwa-update-ready";
const PWA_OFFLINE_READY_EVENT = "cloudphoto-pwa-offline-ready";
const PWA_REGISTRATION_IDLE_TIMEOUT_MS = 2_000;

const installWindow = window as Window & {
  __CF_PWA__?: Event;
  __CF_PWA_INSTALLED__?: boolean;
  __CF_PWA_UPDATE_READY__?: boolean;
  __CF_UPDATE_SW__?: (reloadPage?: boolean) => Promise<void>;
  __CF_SW_REGISTRATION__?: ServiceWorkerRegistration;
  __CF_SW_CONTAINER__?: ServiceWorkerContainer;
};
if ("serviceWorker" in navigator) {
  installWindow.__CF_SW_CONTAINER__ = navigator.serviceWorker;
}
installDeploymentRecovery(installWindow);

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installWindow.__CF_PWA__ = event;
});
window.addEventListener("appinstalled", () => {
  installWindow.__CF_PWA_INSTALLED__ = true;
});

const isStandaloneMode = () =>
  window.matchMedia("(display-mode: standalone)").matches
  || ((navigator as Navigator & { standalone?: boolean }).standalone === true);

let disposePwaUpdateChecks: (() => void) | undefined;

const registerPwa = async () => {
  if (!("serviceWorker" in navigator)) return;
  // Browser and installed sessions share the same small app-shell precache.
  // Feature chunks and authorization-bound media are cached only after first use.
  const { registerSW } = await import("virtual:pwa-register");
  const updateSW = registerSW({
    immediate: true,
    onRegisteredSW(_, registration) {
      if (!registration) return;
      installWindow.__CF_SW_REGISTRATION__ = registration;
      void import("./pwa/updateCheckPolicy").then(
        (policy) => {
          if (!policy) return;
          disposePwaUpdateChecks?.();
          disposePwaUpdateChecks = policy.installPwaUpdateChecks(registration, {
            standalone: isStandaloneMode(),
          });
        },
        reportLazyBoundaryFailure,
      );
    },
    onNeedRefresh() {
      installWindow.__CF_PWA_UPDATE_READY__ = true;
      window.dispatchEvent(new Event(PWA_UPDATE_READY_EVENT));
    },
    onNeedReload() {
      installWindow.__CF_PWA_UPDATE_READY__ = true;
      window.dispatchEvent(new Event(PWA_UPDATE_READY_EVENT));
    },
    onOfflineReady() {
      window.dispatchEvent(new Event(PWA_OFFLINE_READY_EVENT));
    },
  });

  installWindow.__CF_UPDATE_SW__ = updateSW;
};

const schedulePwaRegistration = () => {
  const startRegistration = () => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => {
        void registerPwa();
      }, { timeout: PWA_REGISTRATION_IDLE_TIMEOUT_MS });
      return;
    }
    window.setTimeout(() => {
      void registerPwa();
    }, 0);
  };

  if (document.readyState === "complete") startRegistration();
  else window.addEventListener("load", startRegistration, { once: true });
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

schedulePwaRegistration();
