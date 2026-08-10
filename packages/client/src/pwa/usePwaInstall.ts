import { useSyncExternalStore } from "react";
import { getPwaInstallController } from "./installPrompt";

export function usePwaInstall() {
  const controller = getPwaInstallController();
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return {
    ...snapshot,
    requestInstall: controller.requestInstall,
  };
}
