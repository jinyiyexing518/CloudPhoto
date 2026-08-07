const configuredApiBase = import.meta.env.VITE_API_BASE as string | undefined;

export const DIRECT_API_BASE = (
  configuredApiBase?.startsWith("http")
    ? configuredApiBase
    : "https://cloudphoto-api.azurewebsites.net/api"
).replace(/\/+$/, "");

export const PROXY_API_BASE = (
  (import.meta.env.VITE_PROXY_API_BASE as string | undefined) ??
  "https://cloudphotos.top/api"
).replace(/\/+$/, "");

/** Hosts whose HTML is always served by the Nginx proxy. */
export function isProxySiteHost(hostname: string): boolean {
  return hostname === "cloudphotos.top" || hostname === "cn.cloudphotos.top";
}

/**
 * Use same-origin API only on the dedicated proxy entry. `www` and global
 * entries prefer Azure directly, then http.ts can fall back to the proxy.
 */
export const API_BASE: string = (() => {
  if (typeof window !== "undefined") {
    const { hostname } = window.location;
    if (isProxySiteHost(hostname)) return "/api";
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      return configuredApiBase?.replace(/\/+$/, "") ?? "/api";
    }
    return configuredApiBase?.replace(/\/+$/, "") ?? DIRECT_API_BASE;
  }
  return configuredApiBase?.replace(/\/+$/, "") ?? "/api";
})();
