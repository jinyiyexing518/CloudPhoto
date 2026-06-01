import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const isStandaloneMode = () =>
  window.matchMedia("(display-mode: standalone)").matches
  || ((navigator as Navigator & { standalone?: boolean }).standalone === true);

const disableBrowserPwaCaching = async () => {
  if (!("serviceWorker" in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
  if ("caches" in window) {
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys.map((key) => caches.delete(key)));
  }
};

const registerPwa = async () => {
  if (!("serviceWorker" in navigator)) return;
  if (!isStandaloneMode()) {
    await disableBrowserPwaCaching();
    return;
  }
  const { registerSW } = await import("virtual:pwa-register");
  let refreshTriggered = false;
  const updateSW = registerSW({
    immediate: true,
    onRegisteredSW(_, registration) {
      if (!registration) return;
      const checkForUpdates = () => { void registration.update(); };
      checkForUpdates();
      window.setInterval(checkForUpdates, 30 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") checkForUpdates();
      });
      window.addEventListener("focus", checkForUpdates);
      window.addEventListener("online", checkForUpdates);
    },
    onNeedRefresh() {
      if (!refreshTriggered) {
        refreshTriggered = true;
        void updateSW(true);
      }
      window.dispatchEvent(new Event("cloudphoto-pwa-update-ready"));
    },
    onOfflineReady() {
      window.dispatchEvent(new Event("cloudphoto-pwa-offline-ready"));
    },
  });

  (window as Window & { __CF_UPDATE_SW__?: (reloadPage?: boolean) => Promise<void> }).__CF_UPDATE_SW__ = updateSW;
};

void registerPwa();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
