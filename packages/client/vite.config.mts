import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import type { WorkboxPlugin } from "workbox-core";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appVersion = process.env.npm_package_version ?? "0.0.0";
const buildTime = new Date().toISOString();
const clientDir = path.dirname(fileURLToPath(import.meta.url));
type PrivateMediaCacheSnapshot = {
  generation: number;
  enabled: boolean;
  ready: boolean;
};

type PrivateMediaCachePolicy = {
  snapshot: () => PrivateMediaCacheSnapshot;
  current: (snapshot: PrivateMediaCacheSnapshot) => boolean;
  accepts: (
    response: Response,
    snapshot: PrivateMediaCacheSnapshot,
  ) => boolean;
  read: (request: Request, snapshot: PrivateMediaCacheSnapshot) => Promise<Response | null>;
  write: (
    request: Request,
    response: Response,
    snapshot: PrivateMediaCacheSnapshot,
  ) => Promise<boolean>;
};

export const privateMediaCache = {
  handlerWillStart: ({ state }) => {
    if (state) {
      const policyKey = ["__cloudPhotoPrivate", "MediaCachePolicy"].join("");
      const policy = (
        globalThis as typeof globalThis & Record<string, unknown>
      )[policyKey] as PrivateMediaCachePolicy | undefined;
      state.cloudPhotoPrivateMediaSnapshot = policy?.snapshot() ?? {
        generation: 0,
        enabled: false,
        ready: false,
      };
    }
  },
  cachedResponseWillBeUsed: async ({ cachedResponse, state }) => {
    const policyKey = ["__cloudPhotoPrivate", "MediaCachePolicy"].join("");
    const policy = (
      globalThis as typeof globalThis & Record<string, unknown>
    )[policyKey] as PrivateMediaCachePolicy | undefined;
    const snapshot = state?.cloudPhotoPrivateMediaSnapshot as
      | PrivateMediaCacheSnapshot
      | undefined;
    return cachedResponse
      && policy
      && snapshot?.enabled === true
      && snapshot.ready === true
      && policy.current(snapshot)
      && policy.accepts(cachedResponse, snapshot)
      ? cachedResponse
      : null;
  },
  requestWillFetch: async ({ request, state }) => {
    if (
      !state
      || new URL(request.url).searchParams.get("cf_cover") !== "1"
    ) {
      return request;
    }
    const controller = new AbortController();
    const abortFromRequest = () => {
      controller.abort(request.signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (request.signal.aborted) {
      abortFromRequest();
    } else {
      request.signal.addEventListener("abort", abortFromRequest, { once: true });
    }
    state.cloudPhotoPrivateMediaController = controller;
    state.cloudPhotoPrivateMediaRequestSignal = request.signal;
    state.cloudPhotoPrivateMediaAbortListener = abortFromRequest;
    state.cloudPhotoPrivateMediaTimeout = globalThis.setTimeout(() => {
      request.signal.removeEventListener("abort", abortFromRequest);
      controller.abort(new DOMException("Private media request timed out", "TimeoutError"));
    }, 6_000);
    return new Request(request, { signal: controller.signal });
  },
  fetchDidSucceed: async ({ request, response, event, state }) => {
    if (state?.cloudPhotoPrivateMediaTimeout !== undefined) {
      globalThis.clearTimeout(state.cloudPhotoPrivateMediaTimeout as number);
    }
    const requestSignal = state?.cloudPhotoPrivateMediaRequestSignal as AbortSignal | undefined;
    const abortListener = state?.cloudPhotoPrivateMediaAbortListener as
      | (() => void)
      | undefined;
    if (requestSignal && abortListener) {
      requestSignal.removeEventListener("abort", abortListener);
    }
    const policyKey = ["__cloudPhotoPrivate", "MediaCachePolicy"].join("");
    const guard = globalThis as typeof globalThis & Record<string, unknown>;
    const policy = guard[policyKey] as PrivateMediaCachePolicy | undefined;
    const snapshot = state?.cloudPhotoPrivateMediaSnapshot as
      | PrivateMediaCacheSnapshot
      | undefined;
    if (
      response.status === 408
      || response.status === 429
      || response.status >= 500
    ) {
      const cached = policy && snapshot?.enabled === true && snapshot.ready === true
        ? await policy.read(request, snapshot)
        : null;
      if (cached) return cached;
      return response;
    }
    if (
      policy
      && snapshot?.enabled === true
      && snapshot.ready === true
      && response.status === 200
    ) {
      event.waitUntil(policy.write(request, response.clone(), snapshot));
    }
    return response;
  },
  fetchDidFail: async ({ state }) => {
    if (state?.cloudPhotoPrivateMediaTimeout !== undefined) {
      globalThis.clearTimeout(state.cloudPhotoPrivateMediaTimeout as number);
    }
    const requestSignal = state?.cloudPhotoPrivateMediaRequestSignal as AbortSignal | undefined;
    const abortListener = state?.cloudPhotoPrivateMediaAbortListener as
      | (() => void)
      | undefined;
    if (requestSignal && abortListener) {
      requestSignal.removeEventListener("abort", abortListener);
    }
  },
  handlerDidError: async ({ request, state, error }) => {
    const policyKey = ["__cloudPhotoPrivate", "MediaCachePolicy"].join("");
    const guard = globalThis as typeof globalThis & Record<string, unknown>;
    const policy = guard[policyKey] as PrivateMediaCachePolicy | undefined;
    const snapshot = state?.cloudPhotoPrivateMediaSnapshot as
      | PrivateMediaCacheSnapshot
      | undefined;
    const cached = policy && snapshot?.enabled === true && snapshot.ready === true
      ? await policy.read(request, snapshot)
      : null;
    if (cached) return cached;
    console.warn("[PrivateMediaCache]", {
      label: "network-and-cache-unavailable",
      source: new URL(request.url).pathname.startsWith("/media/")
        ? "media-proxy"
        : "blob-storage",
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return new Response("", {
      status: 504,
      statusText: "Private media unavailable",
      headers: { "Cache-Control": "no-store" },
    });
  },
} satisfies WorkboxPlugin;

export default defineConfig({
  resolve: {
    alias: {
      // Map @cloudphoto/algorithm to the TypeScript source so Vite
      // bundles it directly (tree-shaken, no separate build step needed).
      "@cloudphoto/algorithm": path.resolve(clientDir, "../algorithm/src/index.ts"),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_BUILD_TIME__: JSON.stringify(buildTime),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      includeAssets: [
        "favicon.svg",
        "apple-touch-icon.png",
        "pwa-192x192.png",
        "pwa-512x512.png",
        "maskable-icon.png",
      ],
      manifest: {
        id: "/",
        lang: "zh-CN",
        name: "Cloud Photo",
        short_name: "CloudPhoto",
        description: "CloudPhoto 私人及群组云相册。",
        theme_color: "#0078d4",
        background_color: "#f0f2f5",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "maskable-icon.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        importScripts: ["private-cache-fence.js"],
        globPatterns: [
          "index.html",
          "assets/index-*.{js,css}",
          "assets/react-vendor-*.js",
          "assets/privateCacheReset-*.js",
          "assets/virtual_pwa-register-*.js",
          "assets/workbox-window*.js",
        ],
        navigateFallback: "/index.html",
        skipWaiting: false,
        runtimeCaching: [
          {
            urlPattern: ({ url, request, sameOrigin }) =>
              sameOrigin &&
              request.method === "GET" &&
              url.pathname.startsWith("/assets/"),
            handler: "CacheFirst" as const,
            options: {
              cacheName: "app-code-v1",
              expiration: {
                maxEntries: 80,
                maxAgeSeconds: 30 * 24 * 60 * 60,
                purgeOnQuotaError: true,
              },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: /\/api\/.*$/i,
            handler: "NetworkOnly",
          },
          {
            // Cache only verifiable image GET responses. Opaque status-0,
            // Range/HEAD probes, and original video bodies stay out of this cache.
            // Keep the SAS query in the key: a service-worker write that finishes
            // after logout then cannot satisfy another account's guessed media path.
            // The list layer reuses the same still-valid SAS URL across refreshes,
            // preserving cache hits without weakening this authorization boundary.
            urlPattern: ({ url, request }) => {
              // Workbox serializes this callback into sw.js, so it cannot close
              // over helpers imported by the Vite config.
              const isCacheablePhotoPath =
                /\.(?:bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(url.pathname);
              return request.method === "GET"
                && !request.headers.has("range")
                && (
                  url.pathname.startsWith("/media/")
                  || url.hostname.endsWith(".blob.core.windows.net")
                )
                && isCacheablePhotoPath;
            },
            handler: "NetworkOnly" as const,
            options: {
              plugins: [privateMediaCache],
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  build: {
    target: "esnext",
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        manualChunks: { "react-vendor": ["react", "react-dom"] },
      },
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:7071",
        changeOrigin: true,
      },
    },
  },
});
