import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Service Worker: App-Shell aus dem Cache (Folgebesuche starten ohne Netz-
    // Roundtrip), Kartenkacheln + Schriften gecacht. Echtzeit-APIs und die
    // GTFS-JSONs gehen weiter direkt ans Netz – letztere cacht gtfs.ts selbst in
    // IndexedDB (stale-while-revalidate), ein zweiter Cache davor würde nur
    // Updates verzögern.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      manifest: {
        name: 'Zirndorf Mobil – Busse & Bahnen in Echtzeit',
        short_name: 'Zirndorf Mobil',
        description: 'Echtzeitkarte des ÖPNV im Zirndorfer Gemeindegebiet',
        lang: 'de',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#ffffff',
        icons: [
          { src: '/oz-logo-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/oz-logo-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
      },
      workbox: {
        // Neuer SW übernimmt sofort (auch die erste Seite, nicht erst nach Reload)
        clientsClaim: true,
        skipWaiting: true,
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // Original-Logo (1 MB) nur für README/Sharepic
        globIgnores: ['**/oz-logo.png', '**/gtfs_*.json'],
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/tile\.openstreetmap\.org\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'osm-tiles',
              expiration: { maxEntries: 800, maxAgeSeconds: 7 * 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 20, maxAgeSeconds: 365 * 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
})
