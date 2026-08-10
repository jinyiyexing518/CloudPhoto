import { useState } from "react";
import { useToast } from "../contexts/ToastContext";
import { getPwaInstallGuidance } from "./installPrompt";
import { usePwaInstall } from "./usePwaInstall";

export default function PwaInstallEntry() {
  const showToast = useToast();
  const pwaInstall = usePwaInstall();
  const [installGuide, setInstallGuide] = useState<string[] | null>(null);
  const isInstalled = pwaInstall.mode === "installed";

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
      <button
        type="button"
        className="auth-install-button"
        disabled={isInstalled}
        onClick={() => void handleInstallApp()}
      >
        {isInstalled ? "✓ 已安装到设备" : "📲 安装应用"}
      </button>
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
