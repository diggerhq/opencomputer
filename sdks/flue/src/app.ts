// The default OC hosting app. A scaffolded starter uses this as its `src/app.ts`. It composes the
// SAME app Flue's Cloudflare build generates for the no-`app.ts` case, then adds the `/health` probe
// the OC deploy/activate step needs (stock Flue exposes NO health route — Spike B finding) and installs
// the telemetry forwarder. Apps that own their `app.ts` instead `import '@opencomputer/flue/wire'` (§wire).
//
// WHY `createDefaultFlueApp()` from `@flue/runtime/internal` (and NOT `flue()` from
// `@flue/runtime/routing`): `flue()`'s route handlers read the module-scoped `runtimeConfig` at REQUEST
// time, which the generated Cloudflare entry sets via `configureFlueRuntime(...)` (imported from
// `@flue/runtime/internal`) at module load. The generated entry's no-`app.ts` path builds its app with
// `createDefaultFlueApp()` — the exact same `@flue/runtime/internal` entry — so the mounted `flue()` and
// the `configureFlueRuntime()` that seeds it share one module instance and requests never hit
// "flue() route invoked before runtime was configured". A `src/app.ts` that instead mounted `flue()`
// from `@flue/runtime/routing` (a different published entry) risked resolving a second `@flue/runtime`
// module instance whose `runtimeConfig` is never configured → every request 500s. Composing via the
// build's own entry keeps this app on the configured instance.
//
// Default export = a `Fetchable` (Hono qualifies), per Flue's routing contract.

import { createDefaultFlueApp } from "@flue/runtime/internal";
import { installOcObserver } from "./observe.js";

installOcObserver();

// createDefaultFlueApp() mounts flue() at '/' and installs Flue's canonical notFound/onError envelopes.
// Adding a path-specific '/health' route afterwards is safe — flue() only registers its own concrete
// paths (/agents, /workflows, /runs, /channels), so GET /health matches this handler directly.
const app = createDefaultFlueApp();
app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
