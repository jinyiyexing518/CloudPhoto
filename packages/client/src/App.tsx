import { lazy, Suspense } from "react";
import AuthPage from "./components/auth/AuthPage";
import ErrorBoundary from "./components/shared/ErrorBoundary";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { ToastProvider } from "./contexts/ToastContext";
import { getToken } from "./services/http";

let authenticatedAppPromise: Promise<typeof import("./AuthenticatedApp")> | undefined;

function loadAuthenticatedApp() {
  authenticatedAppPromise ??= import("./AuthenticatedApp");
  return authenticatedAppPromise;
}

if (getToken()) void loadAuthenticatedApp();

const AuthenticatedApp = lazy(loadAuthenticatedApp);

function AppSplash() {
  return (
    <div className="app-splash">
      <div className="app-splash-icon">📷</div>
      <div className="app-splash-title">Cloud Photo</div>
      <div className="app-splash-dots">
        <span /><span /><span />
      </div>
    </div>
  );
}

function WorkspaceLoadError() {
  return (
    <div className="error-boundary-card" role="alert">
      <div className="error-boundary-icon">⚠️</div>
      <p className="error-boundary-title">照片空间加载失败</p>
      <p className="error-boundary-detail">应用可能已有新版本，请刷新后重试。</p>
      <button
        className="error-boundary-retry"
        onClick={() => { window.location.reload(); }}
      >
        刷新重试
      </button>
    </div>
  );
}

function App() {
  const { user, loading } = useAuth();

  if (loading) return <AppSplash />;
  if (!user) {
    return <AuthPage onAuthIntent={() => { void loadAuthenticatedApp(); }} />;
  }

  return (
    <ErrorBoundary fallback={<WorkspaceLoadError />}>
      <Suspense fallback={<AppSplash />}>
        <AuthenticatedApp />
      </Suspense>
    </ErrorBoundary>
  );
}

function AppWithProvider() {
  return (
    <ToastProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ToastProvider>
  );
}

export default AppWithProvider;
