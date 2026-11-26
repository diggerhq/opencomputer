import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: { __OC_EDGE__: '"https://edge.test"', __OC_UI_KEY__: '""', __OC_UPDATE_URL__: '""' },
  test: { testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false },
})
