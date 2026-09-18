import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": new URL(
        "./src/cloudflare_workers_test_stub.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
