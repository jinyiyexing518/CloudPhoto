import { useEffect, useState } from "react";
import { useToast } from "../contexts/ToastContext";
import { getPwaInstallGuidance } from "./installPrompt";
import {
  activatePwaUpdate,
  isPwaUpdateReady,
  PWA_UPDATE_READY_EVENT,
  type PwaUpdateBrowserWindow,
} from "./updatePolicy";
import { usePwaInstall } from "./usePwaInstall";

export default function PwaInstallEntry() {
  const showToast = useToast();
  const pwaInstall = usePwaInstall();
  const [installGuide, setInstallGuide] = useState<string[] | null>(null);
  const [updateReady, setUpdateReady] = useState(
    () => typeof window !== "undefined" && isPwaUpdateReady(window as PwaUpdateBrowserWindow),
  );
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const isInstalled = pwaInstall.mode === "installed";

  useEffect(() => {
    const onUpdateReady = () => setUpdateReady(true);
    window.addEventListener(PWA_UPDATE_READY_EVENT, onUpdateReady);
    if (isPwaUpdateReady(window as PwaUpdateBrowserWindow)) setUpdateReady(true);
    return () => window.removeEventListener(PWA_UPDATE_READY_EVENT, onUpdateReady);
  }, []);

  const handleUpdateApp = async () => {
    setUpdating(true);
    setUpdateError("");
    try {
      const result = await activatePwaUpdate(window as PwaUpdateBrowserWindow);
      if (result === "missing-updater") {
        const message = "更新服务暂不可用，请刷新页面后重试";
        setUpdateError(message);
        showToast(message, "error");
      } else if (result === "blocked-transferring") {
        const message = "当前操作完成后才能更新";
        setUpdateError(message);
        showToast(message, "info");
      } else if (result === "timed-out") {
        const message = "更新超时，请稍后重试";
        setUpdateError(message);
        showToast(message, "error");
      }
    } catch {
      const message = "更新失败，请稍后重试";
      setUpdateError(message);
      showToast(message, "error");
    } finally {
      setUpdating(false);
    }
  };

  const handleInstallApp = async () => {
    try {
      const result = await pwaInstall.requestInstall();
      if (result.status === "guidance") {
        setInstallGuide(getPwaInstallGuidance(pwaInstall.platform));
      } else if (result.status === "prompted" && result.outcome === "accepted") {
        showToast("已确认安装，请按浏览器提示完成", "success");
      } else if (result.status === "prompted") {
        showToast("已取消安装，可随时再次打开安装步骤", "info");
      }
    } catch {
      showToast("无法打开原生安装提示，请按手动步骤安装", "error");
      setInstallGuide(getPwaInstallGuidance(pwaInstall.platform));
    }
  };

  return (
    <div className="auth-install-entry">
      {updateReady && (
        <button
          type="button"
          className="auth-install-button"
          disabled={updating}
          aria-label="立即更新应用"
          onClick={() => void handleUpdateApp()}
        >
          {updating ? "正在更新…" : "立即更新"}
        </button>
      )}
      <button
        type="button"
        className="auth-install-button"
        disabled={isInstalled}
        onClick={() => void handleInstallApp()}
      >
        {isInstalled ? "✓ 已安装到设备" : "📲 安装应用"}
      </button>
      {updateError && <div className="auth-error" role="alert">{updateError}</div>}
      {installGuide && !isInstalled && (
        <div className="auth-install-guide" role="note">
          <strong>安装步骤</strong>
          <ol>
            {installGuide.map((item) => <li key={item}>{item}</li>)}
          </ol>
        </div>
      )}
    </div>
  );
}
