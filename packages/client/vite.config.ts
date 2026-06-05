import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

const appVersion = process.env.npm_package_version ?? "0.0.0";
const buildTime = new Date().toISOString();

export default defineConfig({
  resolve: {
    alias: {
      // Map @cloudphoto/algorithm to the TypeScript source so Vite
      // bundles it directly (tree-shaken, no separate build step needed).
      "@cloudphoto/algorithm": path.resolve(__dirname, "../algorithm/src/index.ts"),
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
      includeAssets: ["favicon.svg", "apple-touch-icon.svg", "maskable-icon.svg"],
      manifest: {
        name: "Cloud Photo",
        short_name: "CloudPhoto",
        description: "Cloud Photo gallery for personal and group memories.",
        theme_color: "#0078d4",
        background_color: "#f0f2f5",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "pwa-192x192.svg",
            sizes: "192x192",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: "pwa-512x512.svg",
            sizes: "512x512",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: "maskable-icon.svg",
            sizes: "512x512",
            type: "image/svg+xml",
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
            // Cache all /media/** requests (thumbnails, previews, originals, videos).
            // KEY: matchOptions.ignoreSearch strips SAS token query params from the cache
            // key — so a re-issued SAS URL still hits the cached response.
            // This turns the browser into a personal CDN: first visit fetches from network,
            // every repeat visit is instant (0 bytes). CacheFirst = serve cache without
            // even checking the network (thumbnails/previews don't change after upload).
            urlPattern: ({ url }) => url.pathname.startsWith("/media/"),
            handler: "CacheFirst" as const,
            options: {
              cacheName: "cf-media-v1",
              matchOptions: { ignoreSearch: true }, // ignore SAS ?sv=...&sig=...&se=...
              expiration: {
                maxEntries: 600,           // ~200 photos × 3 sizes (thumb+preview+orig)
                maxAgeSeconds: 7 * 24 * 60 * 60, // 7 days
                purgeOnQuotaError: true,   // auto-evict oldest if storage quota exceeded
              },
              cacheableResponse: { statuses: [0, 200] },
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
