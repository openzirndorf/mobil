import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Service Worker: App-Shell aus dem Cache (Folgebesuche starten ohne Netz-
    // Roundtrip), Kartenkacheln gecacht. Echtzeit-APIs und die
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
        // Original-Logo (1 MB) nur für README/Sharepic; latin-ext-Schriften lädt der
        // Browser nur bei Bedarf (Zeichen außerhalb Latin-1)
        globIgnores: ['**/oz-logo.png', '**/gtfs_*.json', '**/*-latin-ext-*.woff2'],
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
        ],
      },
    }),
  ],
})
