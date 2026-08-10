export type PwaInstallMode = "installed" | "native" | "ios" | "manual";
export type PwaInstallOutcome = "accepted" | "dismissed" | null;
export type PwaInstallPlatform = "ios" | "android" | "chromium" | "safari" | "firefox" | "other";

export interface PwaInstallSnapshot {
  mode: PwaInstallMode;
  outcome: PwaInstallOutcome;
  platform: PwaInstallPlatform;
}

export type PwaInstallRequestResult =
  | { status: "prompted"; outcome: Exclude<PwaInstallOutcome, null> }
  | { status: "guidance" }
  | { status: "installed" };

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

interface InstallEventTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

interface DisplayModeQuery {
  matches: boolean;
}

interface CompatibleMediaQueryList extends DisplayModeQuery {
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
}

export interface PwaInstallEnvironment {
  eventTarget: InstallEventTarget;
  displayModeQuery: DisplayModeQuery;
  subscribeToDisplayModeChange: (listener: () => void) => () => void;
  initialPrompt?: Event;
  initialAppInstalled?: boolean;
  navigatorStandalone: boolean;
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

export interface PwaInstallController {
  getSnapshot: () => PwaInstallSnapshot;
  subscribe: (listener: () => void) => () => void;
  requestInstall: () => Promise<PwaInstallRequestResult>;
  dispose: () => void;
}

export function subscribeToMediaQueryChanges(
  query: CompatibleMediaQueryList,
  listener: () => void,
): () => void {
  if (query.addEventListener && query.removeEventListener) {
    query.addEventListener("change", listener);
    return () => query.removeEventListener?.("change", listener);
  }
  if (query.addListener && query.removeListener) {
    query.addListener(listener);
    return () => query.removeListener?.(listener);
  }
  throw new Error("This browser does not expose a compatible display-mode change listener");
}

export function detectPwaInstallPlatform(
  userAgent: string,
  platform: string,
  maxTouchPoints: number,
): PwaInstallPlatform {
  const normalizedAgent = userAgent.toLowerCase();
  const isIpadDesktopMode = platform === "MacIntel" && maxTouchPoints > 1;
  if (/iphone|ipad|ipod/.test(normalizedAgent) || isIpadDesktopMode) return "ios";
  if (/android/.test(normalizedAgent)) return "android";
  if (/edg|chrome|crios/.test(normalizedAgent)) return "chromium";
  if (/firefox|fxios/.test(normalizedAgent)) return "firefox";
  if (/safari/.test(normalizedAgent)) return "safari";
  return "other";
}

export function getPwaInstallGuidance(platform: PwaInstallPlatform): string[] {
  switch (platform) {
    case "ios":
      return [
        "使用 Safari 打开 CloudPhoto",
        "点击工具栏的“分享”按钮",
        "选择“添加到主屏幕”，再确认添加",
        "返回主屏幕，从 CloudPhoto 图标启动",
      ];
    case "android":
      return [
        "使用 Chrome 或 Edge 打开 CloudPhoto",
        "打开浏览器菜单，选择“安装应用”或“添加到主屏幕”",
        "确认后从主屏幕的 CloudPhoto 图标启动",
      ];
    case "chromium":
      return [
        "打开 Chrome 或 Edge 的浏览器菜单",
        "选择“安装 CloudPhoto”或“应用 → 将此站点作为应用安装”",
        "确认后从桌面、开始菜单或应用列表启动",
      ];
    case "safari":
      return [
        "在 Safari 中打开 CloudPhoto",
        "选择“文件 → 添加到程序坞”，或从分享菜单选择“添加到程序坞”",
        "确认后从程序坞或“应用程序”启动",
      ];
    case "firefox":
      return [
        "Firefox 桌面版目前不提供网页应用安装",
        "请改用 Chrome 或 Edge 打开 CloudPhoto",
        "从浏览器菜单选择“安装 CloudPhoto”",
      ];
    default:
      return [
        "打开浏览器菜单，查找“安装应用”或“添加到主屏幕”",
        "如果菜单中没有该选项，请使用最新版 Chrome 或 Edge 重新打开 CloudPhoto",
        "安装后从桌面、开始菜单或主屏幕启动",
      ];
  }
}

export function createPwaInstallController(environment: PwaInstallEnvironment): PwaInstallController {
  const listeners = new Set<() => void>();
  const platform = detectPwaInstallPlatform(
    environment.userAgent,
    environment.platform,
    environment.maxTouchPoints,
  );
  let installed = environment.initialAppInstalled === true
    || environment.displayModeQuery.matches
    || environment.navigatorStandalone;
  let deferredPrompt = (environment.initialPrompt as BeforeInstallPromptEvent | undefined) ?? null;
  if (deferredPrompt) deferredPrompt.preventDefault();
  let outcome: PwaInstallOutcome = null;
  let installRequest: Promise<PwaInstallRequestResult> | null = null;
  let snapshot: PwaInstallSnapshot = {
    mode: installed ? "installed" : deferredPrompt ? "native" : platform === "ios" ? "ios" : "manual",
    outcome,
    platform,
  };

  const publish = () => {
    const mode: PwaInstallMode = installed
      ? "installed"
      : deferredPrompt
        ? "native"
        : platform === "ios"
          ? "ios"
          : "manual";
    if (snapshot.mode === mode && snapshot.outcome === outcome) return;
    snapshot = { mode, outcome, platform };
    listeners.forEach((listener) => listener());
  };

  const onBeforeInstallPrompt: EventListener = (event) => {
    const promptEvent = event as BeforeInstallPromptEvent;
    if (typeof promptEvent.prompt !== "function" || !promptEvent.userChoice) return;
    promptEvent.preventDefault();
    deferredPrompt = promptEvent;
    outcome = null;
    publish();
  };

  const onAppInstalled: EventListener = () => {
    installed = true;
    deferredPrompt = null;
    outcome = "accepted";
    publish();
  };

  const onDisplayModeChange = () => {
    installed = environment.displayModeQuery.matches || environment.navigatorStandalone;
    if (installed) deferredPrompt = null;
    publish();
  };

  environment.eventTarget.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  environment.eventTarget.addEventListener("appinstalled", onAppInstalled);
  const unsubscribeFromDisplayMode = environment.subscribeToDisplayModeChange(onDisplayModeChange);

  const requestInstall = async (): Promise<PwaInstallRequestResult> => {
    if (installRequest) return installRequest;
    if (installed) return { status: "installed" };
    const promptEvent = deferredPrompt ?? null;
    if (!promptEvent) return { status: "guidance" };

    deferredPrompt = null;
    publish();
    installRequest = (async () => {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      outcome = choice.outcome;
      publish();
      return { status: "prompted", outcome: choice.outcome };
    })();
    try {
      return await installRequest;
    } finally {
      installRequest = null;
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestInstall,
    dispose: () => {
      environment.eventTarget.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      environment.eventTarget.removeEventListener("appinstalled", onAppInstalled);
      unsubscribeFromDisplayMode();
      listeners.clear();
    },
  };
}

let browserController: PwaInstallController | undefined;

export function initializePwaInstallController(): PwaInstallController {
  const installWindow = window as Window & {
    __CF_INSTALL_PROMPT__?: Event;
    __CF_APP_INSTALLED__?: boolean;
  };
  const displayModeQuery = window.matchMedia("(display-mode: standalone)");
  browserController ??= createPwaInstallController({
    eventTarget: window,
    displayModeQuery,
    subscribeToDisplayModeChange: (listener) =>
      subscribeToMediaQueryChanges(displayModeQuery, listener),
    initialPrompt: installWindow.__CF_INSTALL_PROMPT__,
    initialAppInstalled: installWindow.__CF_APP_INSTALLED__,
    navigatorStandalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  });
  return browserController;
}

export function getPwaInstallController(): PwaInstallController {
  return browserController ?? initializePwaInstallController();
}
