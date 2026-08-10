import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useAuth } from "../../contexts/AuthContext";
import {
  clearNativeValidation,
  setChineseNativeValidation,
} from "./nativeValidation";
import PasswordField from "./PasswordField";

type AuthTab = "login" | "register";

interface AuthPageProps {
  onAuthIntent?: () => void;
}

let registerFormPromise: Promise<typeof import("./RegisterForm")> | null = null;
const loadRegisterForm = () => {
  registerFormPromise ??= import("./RegisterForm");
  return registerFormPromise;
};
const RegisterForm = lazy(loadRegisterForm);
const PwaInstallEntry = lazy(() =>
  import("../../pwa/PwaInstallEntry").catch(() => ({
    default: () => <p>浏览器菜单安装；iOS：分享 → 添加到主屏幕。</p>,
  }))
);

export default function AuthPage({ onAuthIntent }: AuthPageProps) {
  const { login } = useAuth();
  const [tab, setTab] = useState<AuthTab>("login");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [registrationOpened, setRegistrationOpened] = useState(false);

  const loginTabRef = useRef<HTMLButtonElement>(null);
  const registerTabRef = useRef<HTMLButtonElement>(null);
  const loginUsernameRef = useRef<HTMLInputElement>(null);

  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  useEffect(() => {
    loginUsernameRef.current?.focus();
  }, []);

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    onAuthIntent?.();
    setLoading(true);
    try {
      await login(loginUsername.trim(), loginPassword);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  const switchTab = (nextTab: AuthTab) => {
    if (nextTab === "register") {
      setRegistrationOpened(true);
      void loadRegisterForm();
    }
    setTab(nextTab);
    setError("");
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

    event.preventDefault();
    const nextTab =
      event.key === "Home"
        ? "login"
        : event.key === "End"
          ? "register"
          : tab === "login"
            ? "register"
            : "login";
    switchTab(nextTab);
    requestAnimationFrame(() => {
      const nextTabButton = nextTab === "login" ? loginTabRef : registerTabRef;
      nextTabButton.current?.focus();
    });
  };

  return (
    <main className="auth-page">
      <div className="auth-shell">
        <section className="auth-brand" aria-labelledby="auth-brand-title">
          <div className="auth-logo">
            <span className="auth-logo-mark" aria-hidden="true">
              <svg viewBox="0 0 48 48" focusable="false">
                <path d="M15.5 37h20a9.5 9.5 0 0 0 1.1-18.94A13 13 0 0 0 11.48 19.8 8.7 8.7 0 0 0 15.5 37Z" />
                <path d="M19 26.5 23 31l7-8" />
              </svg>
            </span>
            <span className="auth-logo-text" id="auth-brand-title">CloudPhoto</span>
          </div>
          <div className="auth-brand-copy">
            <p className="auth-eyebrow">你的照片时光集</p>
            <h1>把散落的照片，整理成随时可回看的时光</h1>
            <p className="auth-brand-lead">
              按时间浏览、归入相册，在熟悉的设备上继续回顾每段记录。
            </p>
          </div>
          <ul className="auth-value-list">
            <li><span aria-hidden="true">01</span>清晰的时间线浏览</li>
            <li><span aria-hidden="true">02</span>相册与回忆集中整理</li>
            <li><span aria-hidden="true">03</span>适配电脑与手机屏幕</li>
          </ul>
        </section>

        <section className="auth-panel" aria-labelledby="auth-panel-title">
          <header className="auth-panel-header">
            <p className="auth-panel-kicker">{tab === "login" ? "欢迎回来" : "加入 CloudPhoto"}</p>
            <h2 id="auth-panel-title">{tab === "login" ? "登录账号" : "创建账号"}</h2>
            <p>{tab === "login" ? "继续查看和整理你的照片" : "填写以下信息即可开始使用"}</p>
          </header>

          <div className="auth-tabs" role="tablist" aria-label="账号入口">
            <button
              ref={loginTabRef}
              id="login-tab"
              className={`auth-tab${tab === "login" ? " active" : ""}`}
              type="button"
              role="tab"
              aria-selected={tab === "login"}
              aria-controls="login-panel"
              tabIndex={tab === "login" ? 0 : -1}
              onClick={() => switchTab("login")}
              onKeyDown={handleTabKeyDown}
            >
              登录
            </button>
            <button
              ref={registerTabRef}
              id="register-tab"
              className={`auth-tab${tab === "register" ? " active" : ""}`}
              type="button"
              role="tab"
              aria-selected={tab === "register"}
              aria-controls="register-panel"
              tabIndex={tab === "register" ? 0 : -1}
              onClick={() => switchTab("register")}
              onPointerEnter={() => void loadRegisterForm()}
              onFocus={() => void loadRegisterForm()}
              onKeyDown={handleTabKeyDown}
            >
              注册
            </button>
          </div>

          {tab === "login" && error && (
            <div className="auth-error" role="alert" aria-live="assertive">
              {error}
            </div>
          )}

          {tab === "login" && (
            <div
              id="login-panel"
              role="tabpanel"
              aria-labelledby="login-tab"
            >
              <form className="auth-form" onSubmit={handleLogin} aria-busy={loading}>
                <div className="auth-field">
                  <label htmlFor="login-username">用户名</label>
                  <input
                    ref={loginUsernameRef}
                    id="login-username"
                    type="text"
                    value={loginUsername}
                    onChange={(event) => setLoginUsername(event.target.value)}
                    onInput={(event) => clearNativeValidation(event.currentTarget)}
                    onInvalid={(event) => setChineseNativeValidation(event.currentTarget)}
                    placeholder="请输入用户名"
                    required
                    autoComplete="username"
                    inputMode="text"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </div>
                <PasswordField
                  id="login-password"
                  label="密码"
                  value={loginPassword}
                  onChange={setLoginPassword}
                  placeholder="请输入密码"
                  autoComplete="current-password"
                />
                <button
                  className="auth-submit"
                  type="submit"
                  disabled={loading}
                  aria-busy={loading}
                >
                  {loading ? "正在登录…" : "登录"}
                </button>
              </form>
            </div>
          )}
          {registrationOpened && (
            <Suspense
              fallback={tab === "register" ? (
                <div
                  id="register-panel"
                  className="auth-form"
                  role="tabpanel"
                  aria-labelledby="register-tab"
                  aria-live="polite"
                >
                  正在加载注册表单…
                </div>
              ) : null}
            >
              <RegisterForm active={tab === "register"} onAuthIntent={onAuthIntent} />
            </Suspense>
          )}
          <Suspense fallback={null}>
            <PwaInstallEntry />
          </Suspense>
        </section>
      </div>
    </main>
  );
}
