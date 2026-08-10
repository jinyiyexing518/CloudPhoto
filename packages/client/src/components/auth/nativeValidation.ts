type NativeValidationInput = Pick<
  HTMLInputElement,
  "id" | "setCustomValidity" | "validity"
>;

const REQUIRED_MESSAGES: Record<string, string> = {
  "login-username": "请输入用户名",
  "login-password": "请输入密码",
  "register-username": "请输入用户名",
  "register-display-name": "请输入昵称",
  "register-email": "请输入邮箱",
  "register-password": "请输入密码",
  "register-confirm": "请再次输入密码",
};

export function clearNativeValidation(input: NativeValidationInput) {
  input.setCustomValidity("");
}

export function setChineseNativeValidation(input: NativeValidationInput) {
  clearNativeValidation(input);

  if (input.validity.valueMissing) {
    input.setCustomValidity(REQUIRED_MESSAGES[input.id] ?? "请填写此字段");
  } else if (input.validity.typeMismatch && input.id === "register-email") {
    input.setCustomValidity("请输入有效的邮箱地址");
  }
}
