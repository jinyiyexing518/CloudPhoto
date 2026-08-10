import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appVersion = process.env.npm_package_version ?? "0.0.0";
const buildTime = new Date().toISOString();
const clientDir = path.dirname(fileURLToPath(import.meta.url));

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
      registerType: "autoUpdate",
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
        clientsClaim: true,
        globPatterns: ["**/*.{js,css,html,ico,png,svg,json}"],
        navigateFallback: "/index.html",
        skipWaiting: true,
        runtimeCaching: [
          {
            urlPattern: /\/api\/.*$/i,
            handler: "NetworkOnly",
          },
          {
            // Cache only verifiable successful GET responses. Opaque status-0
            // responses and Range/HEAD probes must never enter this private cache.
            // Keep the SAS query in the key: a service-worker write that finishes
            // after logout then cannot satisfy another account's guessed media path.
            // The list layer reuses the same still-valid SAS URL across refreshes,
            // preserving cache hits without weakening this authorization boundary.
            urlPattern: ({ url, request }) =>
              request.method === "GET" &&
              !request.headers.has("range") &&
              (
                url.pathname.startsWith("/media/") ||
                url.hostname.endsWith(".blob.core.windows.net")
              ),
            handler: "CacheFirst" as const,
            options: {
              cacheName: "photo-media-v1",
              matchOptions: { ignoreSearch: false },
              expiration: {
                maxEntries: 600,           // ~200 photos × 3 sizes (thumb+preview+orig)
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
