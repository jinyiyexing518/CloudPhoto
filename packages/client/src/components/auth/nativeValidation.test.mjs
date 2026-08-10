import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  clearNativeValidation,
  setChineseNativeValidation,
} from "./nativeValidation.ts";

const read = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const authPage = read("./AuthPage.tsx");
const registerForm = read("./RegisterForm.tsx");
const passwordField = read("./PasswordField.tsx");
const sourceHtml = read("../../../index.html");

const messages = new Map([
  ["login-username", "请输入用户名"],
  ["login-password", "请输入密码"],
  ["register-username", "请输入用户名"],
  ["register-display-name", "请输入昵称"],
  ["register-email", "请输入邮箱"],
  ["register-password", "请输入密码"],
  ["register-confirm", "请再次输入密码"],
]);

function input(id, validity) {
  return {
    id,
    validity: {
      valueMissing: false,
      typeMismatch: false,
      ...validity,
    },
    validationMessage: "",
    setCustomValidity(message) {
      this.validationMessage = message;
    },
  };
}

test("required auth fields expose field-specific Chinese native messages", () => {
  for (const [id, expected] of messages) {
    const target = input(id, { valueMissing: true });
    setChineseNativeValidation(target);
    assert.equal(target.validationMessage, expected, id);
  }
});

test("register email type mismatch exposes a Chinese native message", () => {
  const target = input("register-email", { typeMismatch: true });
  setChineseNativeValidation(target);
  assert.equal(target.validationMessage, "请输入有效的邮箱地址");
});

test("input reliably clears a previous custom validation error", () => {
  const target = input("register-email", { typeMismatch: true });
  setChineseNativeValidation(target);
  assert.equal(target.validationMessage, "请输入有效的邮箱地址");

  target.validity.typeMismatch = false;
  clearNativeValidation(target);
  assert.equal(target.validationMessage, "");
});

test("unknown validity failures do not invent a stale custom error", () => {
  const target = input("register-email", {});
  target.validationMessage = "旧错误";
  setChineseNativeValidation(target);
  assert.equal(target.validationMessage, "");
});

test("auth forms preserve native validation and wire localization before submit", () => {
  assert.match(sourceHtml, /<html lang="zh-CN">/);
  assert.doesNotMatch(authPage, /noValidate|novalidate/);
  assert.doesNotMatch(registerForm, /noValidate|novalidate/);

  for (const source of [authPage, registerForm]) {
    assert.match(source, /onInvalid=/);
  }
  for (const source of [authPage, registerForm, passwordField]) {
    assert.match(
      source,
      /onChange=\{\(event\) => \{[\s\S]*?(?:clearNativeValidation|setCustomValidity)/,
    );
  }

  assert.match(authPage, /id="login-username"[\s\S]*required[\s\S]*autoComplete="username"/);
  assert.match(passwordField, /required[\s\S]*autoComplete=\{autoComplete\}/);
  assert.match(registerForm, /id="register-email"[\s\S]*type="email"[\s\S]*required[\s\S]*autoComplete="email"/);
});
