import { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Shown instead of the default fallback UI (optional) */
  fallback?: ReactNode;
  /** Label shown in the error card header (e.g. the tab name) */
  label?: string;
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

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Preserve the error in the console for debugging without crashing the app
    console.error("[ErrorBoundary] Caught render error:", error, info.componentStack);
  }

  private handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    const { children, fallback, label } = this.props;

    if (!error) return children;

    if (fallback !== undefined) return fallback;

    return (
      <div className="error-boundary-card">
        <div className="error-boundary-icon">⚠️</div>
        <p className="error-boundary-title">
          {label ? `「${label}」渲染出错` : "页面渲染出错"}
        </p>
        <p className="error-boundary-detail">{error.message || String(error)}</p>
        <button className="error-boundary-retry" onClick={this.handleReset}>
          重试
        </button>
      </div>
    );
  }
}
