import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            STRIPE_WEBHOOK_SECRET: "whsec_test",
            CF_ADMIN_SECRET: "test-admin-secret",
          },
          d1Databases: ["OPENCOMPUTER_DB"],
          // In tests we stub the DO binding; the real one is provided via
          // script_name in wrangler.toml and isn't present in vitest isolation.
        },
      },
    },
  },
});
