export class AuthSessionChangedError extends Error {
  constructor(message = "登录状态已变更，上传已停止") {
    super(message);
    this.name = "AuthSessionChangedError";
  }
}
