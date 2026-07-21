// Ambient Cloudflare-Workers env access (design 013 §4). On the `flue build --target cloudflare`
// build, plain Worker bindings (`OC_GATEWAY`, `OC_SANDBOX_*`, `OC_INGEST`, …) are available on the
// AMBIENT env exported by `cloudflare:workers` — the same one Flue's generated entry reads
// (`import { env } from 'cloudflare:workers'`). Worker secrets such as `OC_SESSION_TOKEN` can instead
// arrive through the runtime-owned env reference at request time. Helpers therefore retain that
// fallback reference and resolve it lazily, layering ambient plain bindings over its current values.
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
 * On CF this adds ambient plain Worker bindings without discarding request-time values from `fallback`;
 * off CF (local dev / node / tests) it returns `fallback` unchanged.
 */
export function ocResolveEnv<T extends Record<string, unknown>>(fallback: T | undefined): T {
  const base = (fallback ?? {}) as T;
  if (!ambientEnv) return base;
  return { ...base, ...ambientEnv } as T;
}
