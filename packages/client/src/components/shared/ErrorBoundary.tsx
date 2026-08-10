import { Component, createRef, ErrorInfo, ReactNode } from "react";
import { requestDeploymentRefresh } from "../../pwa/deploymentRecovery";

interface Props {
  children: ReactNode;
  /** Shown instead of the default fallback UI (optional) */
  fallback?: ReactNode | ((error: Error) => ReactNode);
  /** Label shown in the error card header (e.g. the tab name) */
  label?: string;
  recovery?: boolean;
  onError?: (error: Error) => void;
}

interface State {
  error: Error | null;
}

/**
 * Catches render / lifecycle errors in the subtree and shows a recovery UI
 * instead of letting the whole app go white.
 *
 * Usage:
 *   <ErrorBoundary key={activeTab} label={activeTab}>
 *     {tabContent}
 *   </ErrorBoundary>
 *
 * The `key` prop is intentional: when the user switches tabs React remounts
 * this component, clearing any previous error state automatically.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  private retryButtonRef = createRef<HTMLButtonElement>();

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Caught render error:", error, info.componentStack);
    this.props.onError?.(error);
    this.retryButtonRef.current?.focus();
  }

  private handleReset = () => {
    if (this.props.recovery) {
      requestDeploymentRefresh();
      return;
    }
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    const { children, fallback, label, recovery } = this.props;

    if (!error) return children;

    if (fallback !== undefined) {
      return typeof fallback === "function" ? fallback(error) : fallback;
    }

    return (
      <div className="error-boundary-card" role="alert" aria-live="assertive">
        <div className="error-boundary-icon">⚠️</div>
        <p className="error-boundary-title">
          {label ? `「${label}」暂时无法加载` : "页面暂时无法加载"}
        </p>
        <p className="error-boundary-detail">
          {recovery
            ? "应用可能已有新版本，请刷新新版资源后继续。"
            : "请稍后重试；如果问题持续，请刷新页面。"}
        </p>
        <button
          ref={this.retryButtonRef}
          type="button"
          className="error-boundary-retry"
          onClick={this.handleReset}
        >
          {recovery ? "刷新新版" : "重试"}
        </button>
      </div>
    );
  }
}
