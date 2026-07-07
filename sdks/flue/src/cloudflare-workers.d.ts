// Minimal ambient type for the workerd-only `cloudflare:workers` virtual module, so the guarded
// dynamic import in `cf-env.ts` typechecks without pulling in `@cloudflare/workers-types`. The real
// module (present only on the `--target cloudflare` build) exports the ambient Worker `env` bindings.
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
