import { useState, type RefObject } from "react";

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

export default function PasswordField({
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
          onChange={(event) => {
            event.currentTarget.setCustomValidity("");
            onChange(event.target.value);
          }}
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
