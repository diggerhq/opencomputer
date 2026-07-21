// Ambient Cloudflare-Workers env access (design 013 §4). On the `flue build --target cloudflare`
// build, plain Worker bindings (`OC_GATEWAY`, `OC_SANDBOX_*`, `OC_INGEST`, …) are available on the
// AMBIENT env exported by `cloudflare:workers` — the same one Flue's generated entry reads
// (`import { env } from 'cloudflare:workers'`). Worker secrets such as `OC_SESSION_TOKEN` can instead
// arrive through the runtime-owned env reference at request time. That reference can be a proxy that
// supports direct property reads but not enumeration, so helpers retain it and never spread it.
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
 * Layer ambient plain bindings over a runtime-owned fallback without enumerating
 * the fallback. Defined ambient values win; missing ambient values are read
 * directly from the fallback at access time.
 */
export function layerOcEnv<T extends Record<string, unknown>>(
  ambient: Record<string, unknown> | undefined,
  fallback: T | undefined,
): T {
  if (!ambient) return (fallback ?? {}) as T;
  if (!fallback) return ambient as T;
  return new Proxy(ambient, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return value === undefined
        ? Reflect.get(fallback, property, fallback)
        : value;
    },
  }) as T;
}

/**
 * Resolve the effective OC env. On Cloudflare this layers ambient plain
 * bindings over the lazily read runtime env; off Cloudflare it returns the
 * fallback unchanged.
 */
export function ocResolveEnv<T extends Record<string, unknown>>(
  fallback: T | undefined,
): T {
  return layerOcEnv(ambientEnv, fallback);
}
