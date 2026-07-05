// The default OC hosting app. A scaffolded starter uses this as its `src/app.ts` (or the CF build
// generates an equivalent when no app.ts exists). It mounts Flue's routes, adds the `/health` probe the
// OC deploy/activate step needs (stock Flue exposes NO health route — Spike B finding), and installs the
// telemetry forwarder. Apps that own their `app.ts` instead `import '@opencomputer/flue/wire'` (§wire).
//
// Default export = a `Fetchable` (Hono qualifies), per Flue's routing contract.

import { Hono } from "hono";
import { flue } from "@flue/runtime/routing";
import { installOcObserver } from "./observe.js";

installOcObserver();

const app = new Hono();
app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/", flue());

export default app;
