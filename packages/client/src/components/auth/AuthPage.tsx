import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useAuth } from "../../contexts/AuthContext";

type AuthTab = "login" | "register";

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoComplete: "current-password" | "new-password";
  descriptionId?: string;
  invalid?: boolean;
  inputRef?: RefObject<HTMLInputElement>;
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  placeholder,
  autoComplete,
  descriptionId,
  invalid,
  inputRef,
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      <div className="auth-password">
        <input
          ref={inputRef}
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          required
          autoComplete={autoComplete}
          aria-describedby={descriptionId}
          aria-invalid={invalid || undefined}
        />
        <button
          className="auth-password-toggle"
          type="button"
          onClick={() => setVisible((current) => !current)}
          aria-controls={id}
          aria-pressed={visible}
          aria-label={`${visible ? "隐藏" : "显示"}${label}`}
        >
          {visible ? "隐藏" : "显示"}
        </button>
      </div>
    </div>
  );
}

export default function AuthPage() {
  const { login, register } = useAuth();
  const [tab, setTab] = useState<AuthTab>("login");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const loginTabRef = useRef<HTMLButtonElement>(null);
  const registerTabRef = useRef<HTMLButtonElement>(null);
  const loginUsernameRef = useRef<HTMLInputElement>(null);
  const regUsernameRef = useRef<HTMLInputElement>(null);

  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  const [regUsername, setRegUsername] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regDisplayName, setRegDisplayName] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regConfirm, setRegConfirm] = useState("");

  const passwordIsLongEnough = regPassword.length >= 6;
  const confirmHasValue = regConfirm.length > 0;
  const passwordsMatch = confirmHasValue && regPassword === regConfirm;

  useEffect(() => {
    loginUsernameRef.current?.focus();
  }, []);

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(loginUsername.trim(), loginPassword);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!passwordIsLongEnough) {
      setError("密码至少需要 6 位");
      return;
    }
    if (!passwordsMatch) {
      setError("两次输入的密码不一致");
      return;
    }
    setLoading(true);
    try {
      await register({
        username: regUsername.trim(),
        email: regEmail.trim(),
        displayName: regDisplayName.trim(),
        password: regPassword,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "注册失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  const switchTab = (nextTab: AuthTab, focusFirstField = true) => {
    setTab(nextTab);
    setError("");
    if (focusFirstField) {
      requestAnimationFrame(() => {
        const firstField = nextTab === "login" ? loginUsernameRef : regUsernameRef;
        firstField.current?.focus();
      });
    }
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
    switchTab(nextTab, false);
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
              onKeyDown={handleTabKeyDown}
            >
              注册
            </button>
          </div>

          {error && (
            <div className="auth-error" role="alert" aria-live="assertive">
              {error}
            </div>
          )}

          {tab === "login" ? (
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
          ) : (
            <div
              id="register-panel"
              role="tabpanel"
              aria-labelledby="register-tab"
            >
              <form className="auth-form" onSubmit={handleRegister} aria-busy={loading}>
                <div className="auth-field">
                  <label htmlFor="register-username">用户名</label>
                  <input
                    ref={regUsernameRef}
                    id="register-username"
                    type="text"
                    value={regUsername}
                    onChange={(event) => setRegUsername(event.target.value)}
                    placeholder="请输入用户名"
                    required
                    autoComplete="username"
                    inputMode="text"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </div>
                <div className="auth-field">
                  <label htmlFor="register-display-name">昵称</label>
                  <input
                    id="register-display-name"
                    type="text"
                    value={regDisplayName}
                    onChange={(event) => setRegDisplayName(event.target.value)}
                    placeholder="输入希望显示的名称"
                    required
                    autoComplete="nickname"
                  />
                </div>
                <div className="auth-field">
                  <label htmlFor="register-email">邮箱</label>
                  <input
                    id="register-email"
                    type="email"
                    value={regEmail}
                    onChange={(event) => setRegEmail(event.target.value)}
                    placeholder="name@example.com"
                    required
                    autoComplete="email"
                    inputMode="email"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </div>
                <PasswordField
                  id="register-password"
                  label="密码"
                  value={regPassword}
                  onChange={setRegPassword}
                  placeholder="至少 6 位"
                  autoComplete="new-password"
                  descriptionId="register-password-rule"
                  invalid={regPassword.length > 0 && !passwordIsLongEnough}
                />
                <p
                  id="register-password-rule"
                  className={`auth-field-status${
                    regPassword.length === 0
                      ? ""
                      : passwordIsLongEnough
                        ? " is-valid"
                        : " is-invalid"
                  }`}
                >
                  <span aria-hidden="true">{passwordIsLongEnough ? "✓" : "•"}</span>
                  {passwordIsLongEnough ? "已满足至少 6 位" : "密码至少需要 6 位"}
                </p>
                <PasswordField
                  id="register-confirm"
                  label="确认密码"
                  value={regConfirm}
                  onChange={setRegConfirm}
                  placeholder="再次输入密码"
                  autoComplete="new-password"
                  descriptionId="register-confirm-status"
                  invalid={confirmHasValue && !passwordsMatch}
                />
                <p
                  id="register-confirm-status"
                  className={`auth-field-status${
                    !confirmHasValue ? "" : passwordsMatch ? " is-valid" : " is-invalid"
                  }`}
                  aria-live="polite"
                >
                  <span aria-hidden="true">{passwordsMatch ? "✓" : "•"}</span>
                  {!confirmHasValue
                    ? "再次输入以确认密码"
                    : passwordsMatch
                      ? "两次输入一致"
                      : "两次输入不一致"}
                </p>
                <button
                  className="auth-submit"
                  type="submit"
                  disabled={loading}
                  aria-busy={loading}
                >
                  {loading ? "正在创建账号…" : "创建账号"}
                </button>
              </form>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
