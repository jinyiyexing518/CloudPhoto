import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const appVersion = process.env.npm_package_version ?? "0.0.0";
const buildTime = new Date().toISOString();

export default defineConfig({
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
            // Cache Azure Blob image URLs with stale-while-revalidate strategy
            urlPattern: /\.blob\.core\.windows\.net\/.*$/i,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "cf-blob-images",
              expiration: { maxEntries: 300, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Cache local /api/photos thumbnail URLs
            urlPattern: /\/api\/photos\?.*$/i,
            handler: "NetworkFirst",
            options: {
              cacheName: "cf-api-photos",
              expiration: { maxEntries: 10, maxAgeSeconds: 60 },
              networkTimeoutSeconds: 5,
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
