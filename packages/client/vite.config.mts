import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import type { WorkboxPlugin } from "workbox-core";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appVersion = process.env.npm_package_version ?? "0.0.0";
const buildTime = new Date().toISOString();
const clientDir = path.dirname(fileURLToPath(import.meta.url));
export const privateCacheWriteFence = {
  handlerWillStart: async ({ state }) => {
    if (state) {
      const readyKey = ["__cloudPhotoPrivate", "CacheFenceReady"].join("");
      const ready = (
        globalThis as typeof globalThis & Record<string, unknown>
      )[readyKey];
      if (ready && typeof (ready as Promise<void>).then === "function") {
        await ready;
      }
      const generationKey = ["__cloudPhotoPrivate", "CacheGeneration"].join("");
      const generation = (
        globalThis as typeof globalThis & Record<string, unknown>
      )[generationKey];
      state.cloudPhotoPrivateCacheGeneration =
        typeof generation === "number" ? generation : 0;
      const enabledKey = ["__cloudPhotoPrivate", "CacheEnabled"].join("");
      state.cloudPhotoPrivateCacheWriteAllowed = (
        globalThis as typeof globalThis & Record<string, unknown>
      )[enabledKey] === true;
    }
  },
  cacheWillUpdate: async ({ response, state }) => {
    const generationKey = ["__cloudPhotoPrivate", "CacheGeneration"].join("");
    const enabledKey = ["__cloudPhotoPrivate", "CacheEnabled"].join("");
    const guard = globalThis as typeof globalThis & Record<string, unknown>;
    return state?.cloudPhotoPrivateCacheWriteAllowed === true
      && guard[enabledKey] === true
      && state?.cloudPhotoPrivateCacheGeneration === guard[generationKey]
      ? response
      : null;
  },
  cachedResponseWillBeUsed: async ({ cachedResponse, state }) => {
    const generationKey = ["__cloudPhotoPrivate", "CacheGeneration"].join("");
    const enabledKey = ["__cloudPhotoPrivate", "CacheEnabled"].join("");
    const guard = globalThis as typeof globalThis & Record<string, unknown>;
    return state?.cloudPhotoPrivateCacheWriteAllowed === true
      && guard[enabledKey] === true
      && state?.cloudPhotoPrivateCacheGeneration === guard[generationKey]
      ? cachedResponse
      : null;
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
            handler: "CacheFirst" as const,
            options: {
              cacheName: "photo-media-v1",
              matchOptions: { ignoreSearch: false },
              plugins: [privateCacheWriteFence],
              expiration: {
                maxEntries: 600,           // ~200 photos × thumbnail, preview, or image original
                maxAgeSeconds: 60 * 60,    // never outlive the one-hour private freshness window
                purgeOnQuotaError: true,   // auto-evict oldest if storage quota exceeded
              },
              cacheableResponse: { statuses: [200] },
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
