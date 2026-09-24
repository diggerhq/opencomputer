import { fileURLToPath, URL } from 'node:url'
import type { Connect } from 'vite'
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
// Dev-only managed-agents bypass. With OC_MANAGED_AGENTS_TOKEN set, Vite
// forwards /api/managed-agents/* straight to a managed-agents backend
// (OC_MANAGED_AGENTS_TARGET) and injects the agent token server-side — so the
// projects UI works in `npm run dev` against a personal dev Worker, with no
// api-edge deploy and no WorkOS session. The token lives only in the Node dev
// server, never in the browser bundle (not a VITE_ var). Prod still goes
// through the edge, which mints its own token per request; this shortcut is
// local-only, and it bypasses the edge's route allowlist and response shaping.
const managedAgentsToken = process.env.OC_MANAGED_AGENTS_TOKEN
const managedAgentsTarget =
  process.env.OC_MANAGED_AGENTS_TARGET || 'https://managedagents.opencomputer.dev'
const managedAgentsProxy: Record<string, ProxyOptions> = managedAgentsToken
  ? {
      // The dashboard's API base is /api/dashboard, so its managed-agents
      // calls arrive under /api/dashboard/managed-agents — the same prefix
      // dashboard.ts proxies from in the edge.
      '/api/dashboard/managed-agents': {
        target: managedAgentsTarget,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/dashboard\/managed-agents/, '/v1'),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader(
              'x-opencomputer-agent-token',
              managedAgentsToken,
            )
          })
        },
      },
    }
  : {}

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

// Paired with the bypass above: ProtectedRoute redirects to /auth/login unless
// /me resolves, and /auth is the edge's own route, which a local dev server has
// no way to satisfy. Single-tenant development mode is supposed to return a
// local user from /me, so serve exactly that — gated on the same token, ahead
// of the proxy, and only for this one path.
const localUser = {
  name: 'managed-agents-local-user',
  configureServer(server: { middlewares: Connect.Server }) {
    if (!managedAgentsToken) return
    server.middlewares.use((req, res, next) => {
      if (req.url !== '/api/dashboard/me') return next()
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          id: 'local-dev-user',
          email: 'local@dev.invalid',
          orgId: 'local-dev-org',
          durableSessionsEnabled: false,
          infrastructureEnabled: false,
          authMode: 'development',
          capabilities: {
            signOut: false,
            manageMembers: false,
            switchOrganizations: false,
          },
        }),
      )
    })
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss(), localUser],
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
      ...managedAgentsProxy,
      '/auth': target,
      // Trailing slash so the SPA route `/api-keys` isn't proxied to the
      // backend; all real API paths live under `/api/dashboard/`.
      '/api/': { target, ws: true },
      '/webhooks': target,
    },
  },
})
