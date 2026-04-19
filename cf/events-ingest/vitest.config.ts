import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            EVENT_SECRET: "test-secret-not-for-prod",
            CF_ADMIN_SECRET: "test-admin-secret",
            CELL_ENDPOINTS: "",
          },
          d1Databases: ["OPENCOMPUTER_DB"],
          kvNamespaces: ["SESSIONS_KV"],
          r2Buckets: ["EVENTS_ARCHIVE"],
          durableObjects: {
            CREDIT_ACCOUNT: "CreditAccount",
          },
        },
      },
    },
  },
});
