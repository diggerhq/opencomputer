import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "cloudflare:workers": fileURLToPath(new URL("./test/cloudflare-workers-stub.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // The OAuth provider imports `cloudflare:workers`; inline it so the alias applies under Node.
    server: { deps: { inline: [/@cloudflare\/workers-oauth-provider/] } },
  },
});
