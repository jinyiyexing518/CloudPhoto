import { API_BASE, PROXY_API_BASE, isLocalSiteHost } from "../utils/apiBase";
import type { AuthResponse } from "./authApi";
import { fetchWithTimeout } from "./http";

const registrationApiBase = (
  typeof window !== "undefined" && !isLocalSiteHost(window.location.hostname)
    ? PROXY_API_BASE
    : API_BASE
);

export async function registerApi(data: {
  username: string;
  email: string;
  displayName: string;
  password: string;
}): Promise<AuthResponse> {
  const res = await fetchWithTimeout(
    `${registrationApiBase}/auth/register`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
  ).catch((e: unknown) => {
    throw new Error(
      e instanceof Error && e.name === "AbortError" ? "注册超时，请稍后重试" : "网络错误",
    );
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Registration failed" }));
    throw new Error((err as { error?: string }).error ?? "Registration failed");
  }
  return res.json() as Promise<AuthResponse>;
}
