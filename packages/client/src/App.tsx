import { lazy, Suspense } from "react";
import AuthPage from "./components/auth/AuthPage";
import ErrorBoundary from "./components/shared/ErrorBoundary";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { ToastProvider } from "./contexts/ToastContext";
import { reportLazyBoundaryFailure } from "./pwa/deploymentRecovery";
import { getToken, preloadApiHedgePolicy } from "./services/http";

let authenticatedAppPromise: Promise<typeof import("./AuthenticatedApp")> | undefined;

function loadAuthenticatedApp() {
  void preloadApiHedgePolicy().catch(reportLazyBoundaryFailure);
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

function App() {
  const { user, loading } = useAuth();

  return (
    <ToastProvider key={user?.id}>
      {loading ? <AppSplash /> : !user ? (
        <ErrorBoundary
          label="登录与注册"
          recovery
          onError={reportLazyBoundaryFailure}
        >
          <AuthPage onAuthIntent={() => { void loadAuthenticatedApp(); }} />
        </ErrorBoundary>
      ) : (
        <ErrorBoundary
          label="照片空间"
          recovery
          onError={reportLazyBoundaryFailure}
        >
          <Suspense fallback={<AppSplash />}>
            <AuthenticatedApp />
          </Suspense>
        </ErrorBoundary>
      )}
    </ToastProvider>
  );
}

function AppWithProvider() {
  return (
    <AuthProvider>
      <App />
    </AuthProvider>
  );
}

export default AppWithProvider;
