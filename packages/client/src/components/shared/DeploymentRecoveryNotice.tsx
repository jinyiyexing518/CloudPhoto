import { useEffect, useRef, useState } from "react";
import {
  dismissDeploymentRecovery,
  getDeploymentRecoveryState,
  requestDeploymentRefresh,
  subscribeDeploymentRecovery,
  type DeploymentRecoveryState,
} from "../../pwa/deploymentRecovery";

export default function DeploymentRecoveryNotice() {
  const [state, setState] = useState<DeploymentRecoveryState>(
    getDeploymentRecoveryState,
  );
  const primaryButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => subscribeDeploymentRecovery(setState), []);
  useEffect(() => {
    if (state.status === "blocked-operation" || state.status === "exhausted") {
      primaryButtonRef.current?.focus();
    }
  }, [state.status]);

  if (state.status === "idle" || state.status === "recovering") return null;
  const refreshDisabled = state.status === "blocked-operation" || state.status === "blocked-offline";

  return (
    <div className="deployment-recovery-notice" role="status" aria-live="assertive">
      <div>
        <strong>需要加载新版资源</strong>
        <span>{state.message}</span>
      </div>
      <div className="deployment-recovery-actions">
        <button
          ref={primaryButtonRef}
          type="button"
          disabled={refreshDisabled}
          onClick={requestDeploymentRefresh}
        >
          {refreshDisabled && state.status === "blocked-operation"
            ? "当前操作完成后刷新"
            : "刷新新版"}
        </button>
        <button type="button" className="deployment-recovery-later" onClick={dismissDeploymentRecovery}>
          稍后重试
        </button>
      </div>
    </div>
  );
}
