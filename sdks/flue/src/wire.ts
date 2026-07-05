// Side-effect module for apps that own their `app.ts`: `import '@opencomputer/flue/wire'` to forward
// Flue observations to OC_INGEST without adopting the default app. (Add `/health` to your own Hono app
// too — the OC deploy/activate probe expects it.) Marked in package.json `sideEffects` so it survives
// tree-shaking.

import { installOcObserver } from "./observe.js";

installOcObserver();
