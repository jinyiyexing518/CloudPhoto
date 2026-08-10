import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const PWA_UPDATE_READY_EVENT = "cloudphoto-pwa-update-ready";
const PWA_OFFLINE_READY_EVENT = "cloudphoto-pwa-offline-ready";

const installWindow = window as Window & {
  __CF_PWA__?: Event;
  __CF_PWA_INSTALLED__?: boolean;
  __CF_PWA_UPDATE_READY__?: boolean;
  __CF_UPDATE_SW__?: (reloadPage?: boolean) => Promise<void>;
};
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

const registerPwa = async () => {
  if (!("serviceWorker" in navigator)) return;
  // Browser and installed sessions share the same small app-shell precache.
  // Feature chunks and authorization-bound media are cached only after first use.
  const { registerSW } = await import("virtual:pwa-register");
  const updateSW = registerSW({
    immediate: true,
    onRegisteredSW(_, registration) {
      if (!registration) return;
      const checkForUpdates = () => { void registration.update(); };
      checkForUpdates();
      // Poll for updates — only check frequently in PWA mode; browsers rely on page reload
      const interval = isStandaloneMode() ? 30 * 1000 : 5 * 60 * 1000;
      window.setInterval(checkForUpdates, interval);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") checkForUpdates();
      });
      window.addEventListener("focus", checkForUpdates);
      window.addEventListener("online", checkForUpdates);
    },
    onNeedRefresh() {
      installWindow.__CF_PWA_UPDATE_READY__ = true;
      window.dispatchEvent(new Event(PWA_UPDATE_READY_EVENT));
    },
    onOfflineReady() {
      window.dispatchEvent(new Event(PWA_OFFLINE_READY_EVENT));
    },
  });

  installWindow.__CF_UPDATE_SW__ = updateSW;
};

void registerPwa();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
