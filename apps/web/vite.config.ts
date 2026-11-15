import react from '@vitejs/plugin-react'
import { defaultClientConditions, defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

/** Product name in one place (ADR 0001: working title, renamed before the first release). */
const APP_NAME = process.env.VITE_APP_NAME ?? 'EasyBau'

export default defineConfig({
  plugins: [
    react(),
    // Installable app with an offline shell (ADR 0010). API answers are not cached by the service
    // worker – the app keeps the site data itself in IndexedDB (src/offline).
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: APP_NAME,
        short_name: APP_NAME,
        description: 'Betriebssoftware für Bau- und Handwerksbetriebe',
        lang: 'de',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f8fafc',
        theme_color: '#0f4c5c',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/healthz/, /^\/readyz/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  // Workspace packages are bundled from their TypeScript sources (condition "source").
  resolve: { conditions: ['source', ...defaultClientConditions] },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/readyz': 'http://localhost:3000',
    },
  },
  build: { target: 'es2022', sourcemap: true },
})
