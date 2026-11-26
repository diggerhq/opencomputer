import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The desktop bundle (tracks and threads, spec 25): the surface alone, loaded
// by the Electron shell from its own origin. `npm run build:desktop`.
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@opencomputer/sdk/computer/fake': fileURLToPath(
        new URL('../sdks/typescript/src/computer/fake/index.ts', import.meta.url),
      ),
      '@opencomputer/sdk/computer': fileURLToPath(
        new URL('../sdks/typescript/src/computer/index.ts', import.meta.url),
      ),
    },
  },
  build: {
    outDir: 'dist-desktop',
    rollupOptions: { input: fileURLToPath(new URL('./desktop.html', import.meta.url)) },
  },
  server: { port: 3001 },
})
