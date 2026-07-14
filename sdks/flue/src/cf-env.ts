// Ambient Cloudflare-Workers env access (design 013 §4). On the `flue build --target cloudflare`
// build the real Worker bindings (`OC_GATEWAY`, `OC_SESSION_TOKEN`, `OC_SANDBOX_*`, `OC_INGEST`, …)
// live on the AMBIENT env exported by `cloudflare:workers` — the same one Flue's generated entry reads
// (`import { env } from 'cloudflare:workers'`). The per-agent `ctx.env` Flue threads into the
// initializer is EMPTY for these bindings, so OC helpers must read the ambient env instead.
//
// `cloudflare:workers` only resolves inside workerd, so importing it statically would break local
// `flue dev` on the node target and the package's own vitest. Load it lazily + guarded: on CF the
// dynamic import resolves and `ambientEnv` is populated during module graph evaluation (before any
// request); everywhere else the import rejects, is caught, and callers fall back to the passed env.

let ambientEnv: Record<string, unknown> | undefined;
try {
  // `@vite-ignore` so consumer/test bundlers don't try to statically resolve the workerd built-in;
  // on CF this is a runtime import of the ambient module, off CF it throws and we fall back.
  const mod = (await import(/* @vite-ignore */ "cloudflare:workers")) as {
    env?: Record<string, unknown>;
  };
  ambientEnv = mod.env;
} catch {
  ambientEnv = undefined;
}

/**
 * Resolve the effective OC env: the Cloudflare ambient bindings layered over `fallback` (ambient wins).
 * On CF this returns the real Worker bindings even though `ctx.env` is empty; off CF (local dev / node /
 * tests) it returns `fallback` unchanged so an explicitly-passed env still works.
 */
export function ocResolveEnv<T extends Record<string, unknown>>(fallback: T | undefined): T {
  const base = (fallback ?? {}) as T;
  if (!ambientEnv) return base;
  return { ...base, ...ambientEnv } as T;
}
