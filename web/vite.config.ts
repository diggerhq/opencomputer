import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const target = process.env.OC_API_TARGET || 'http://localhost:8080'

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
      '/auth': target,
      // Trailing slash so the SPA route `/api-keys` isn't proxied to the
      // backend; all real API paths live under `/api/dashboard/`.
      '/api/': { target, ws: true },
      '/webhooks': target,
    },
  },
})
