import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const registerPwa = async () => {
  if (!("serviceWorker" in navigator)) return;
  const { registerSW } = await import("virtual:pwa-register");
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
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
