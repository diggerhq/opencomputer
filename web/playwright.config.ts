import { defineConfig, devices } from '@playwright/test'

// Browser tests of the surface over its demo host (`?fake`): what a reader
// sees frame by frame, which the unit tests cannot (work 139).
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://localhost:5198', viewport: { width: 1280, height: 900 } },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 900 } } },
  ],
  webServer: {
    // The build, as it ships: a dev server's first loads are slow enough to time a test out.
    command: 'npx vite build && npx vite preview --port 5198 --strictPort',
    url: 'http://localhost:5198',
    env: { VITE_PREVIEW: '1' },
  },
})
