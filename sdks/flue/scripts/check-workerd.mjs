import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["@flue/runtime", "cloudflare:workers"],
  logLevel: "warning",
});
