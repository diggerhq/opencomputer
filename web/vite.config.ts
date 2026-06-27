import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const target = process.env.OC_API_TARGET || 'http://localhost:8080'

// Dev-only /v3 bypass. With OC_V3_KEY set, Vite forwards /api/dashboard/v3/*
// straight to prod /v3 (OC_V3_TARGET) and injects the osb_ key server-side — so
// Agents/Sessions work in `npm run dev` with no edge deploy and no OC-core
// proxy. The key lives only in the Node dev server, never in the browser bundle
// (not a VITE_ var). Owner is the key's tenant (oc:sha256(key)) — the same one
// the SDK/demo use, so you also see their data. Prod still uses the edge's
// org-token; this shortcut is local-only.
const v3Key = process.env.OC_V3_KEY
const v3Target = process.env.OC_V3_TARGET || 'https://api.opencomputer.dev'
const injectKey: ProxyOptions['configure'] = (proxy) => {
  proxy.on('proxyReq', (proxyReq) => {
    if (v3Key) proxyReq.setHeader('x-api-key', v3Key)
  })
}
// Both must precede '/api/' below — first matching rule wins.
const v3Proxy: Record<string, ProxyOptions> = v3Key
  ? {
      // /v3 lives at the prod root (/v3/*).
      '/api/dashboard/v3': {
        target: v3Target,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/dashboard/, ''),
        configure: injectKey,
      },
      // Sandbox webhooks live at the prod public API (/api/webhooks/*).
      '/api/dashboard/webhooks': {
        target: v3Target,
        changeOrigin: true,
        rewrite: (p) =>
          p.replace(/^\/api\/dashboard\/webhooks/, '/api/webhooks'),
        configure: injectKey,
      },
    }
  : {}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 3000,
    proxy: {
      ...v3Proxy,
      '/auth': target,
      // Trailing slash so the SPA route `/api-keys` isn't proxied to the
      // backend; all real API paths live under `/api/dashboard/`.
      '/api/': { target, ws: true },
      '/webhooks': target,
    },
  },
})
