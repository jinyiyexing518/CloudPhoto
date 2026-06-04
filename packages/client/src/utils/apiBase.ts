/**
 * Determine the API base URL at runtime.
 * - On cloudphotos.top → use relative "/api" (Nginx proxy → Azure Functions, works in China without VPN)
 * - Everywhere else   → use the direct Azure Functions URL (shortest path, no VM hop)
 */
export const API_BASE: string = (() => {
  if (typeof window !== "undefined" && window.location.hostname === "cloudphotos.top") {
    return "/api";
  }
  // Falls back to VITE_API_BASE (set to direct Azure URL in GitHub Secret),
  // or "/api" for local dev where Vite proxy handles it.
  return (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";
})();
