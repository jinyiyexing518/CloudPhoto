import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "../../contexts/AuthContext";
import {
  clearNativeValidation,
  setChineseNativeValidation,
} from "./nativeValidation";
import PasswordField from "./PasswordField";

interface RegisterFormProps {
  active: boolean;
  onAuthIntent?: () => void;
}

export default function RegisterForm({ active, onAuthIntent }: RegisterFormProps) {
  const { register } = useAuth();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const usernameRef = useRef<HTMLInputElement>(null);

  const passwordIsLongEnough = password.length >= 6;
  const confirmHasValue = confirm.length > 0;
  const passwordsMatch = confirmHasValue && password === confirm;

  useEffect(() => {
    if (!active) return;
    setError("");
    usernameRef.current?.focus();
  }, [active]);

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
    onAuthIntent?.();
    setLoading(true);
    try {
      await register({
        username: username.trim(),
        email: email.trim(),
        displayName: displayName.trim(),
        password,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "注册失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {active && error && (
        <div className="auth-error" role="alert" aria-live="assertive">
          {error}
        </div>
      )}
      <div
        id="register-panel"
        role="tabpanel"
        aria-labelledby="register-tab"
        hidden={!active}
      >
        <form className="auth-form" onSubmit={handleRegister} aria-busy={loading}>
          <div className="auth-field">
            <label htmlFor="register-username">用户名</label>
            <input
              ref={usernameRef}
              id="register-username"
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
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
          <div className="auth-field">
            <label htmlFor="register-display-name">昵称</label>
            <input
              id="register-display-name"
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              onInput={(event) => clearNativeValidation(event.currentTarget)}
              onInvalid={(event) => setChineseNativeValidation(event.currentTarget)}
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
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onInput={(event) => clearNativeValidation(event.currentTarget)}
              onInvalid={(event) => setChineseNativeValidation(event.currentTarget)}
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
            value={password}
            onChange={setPassword}
            placeholder="至少 6 位"
            autoComplete="new-password"
            descriptionId="register-password-rule"
            invalid={password.length > 0 && !passwordIsLongEnough}
          />
          <p
            id="register-password-rule"
            className={`auth-field-status${
              password.length === 0
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
            value={confirm}
            onChange={setConfirm}
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
    </>
  );
}
