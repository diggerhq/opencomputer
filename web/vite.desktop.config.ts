import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The desktop bundle (tracks and threads, spec 25): the surface alone, loaded
// by the Electron shell from its own origin. `npm run build:desktop`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@opencomputer/sdk/computer': fileURLToPath(
        new URL('../sdks/typescript/src/computer/index.ts', import.meta.url),
      ),
    },
    // The SDK's source imports zod (its review schema); take this app's copy, so a build
    // needs only web/'s packages installed.
    dedupe: ['zod'],
  },
  build: {
    outDir: 'dist-desktop',
    rollupOptions: {
      input: fileURLToPath(new URL('./desktop.html', import.meta.url)),
    },
  },
  server: { port: 3001 },
})
