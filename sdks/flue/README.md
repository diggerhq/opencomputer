# @opencomputer/flue

Make a stock [Flue](https://flue.dev) agent OpenComputer-native. A Flue app built with
`flue build --target cloudflare` runs unchanged as an OpenComputer durable session (a Workers-for-Platforms
tenant script); this package supplies the OC-specific wiring the app opts into.

## What it gives you

- **`useOcGateway(ctx)` + `DEFAULT_MODEL`** — point the managed `anthropic` provider at the OC model
  gateway (org key injected + per-session metering). Call it **inside** your `defineAgent` initializer.
- **`route`** — the HTTP-transport opt-in every OC-hosted agent must export (`export { route }`).
- **`ocSandbox(env)`** — optional, demand-driven Linux shell/files. Declaring it makes no network
  request; the first actual sandbox operation resolves the persistent session sandbox.
- **`ocRepoTools(env)`** — `publish_pull_request` and friends (open PRs as the OpenComputer GitHub App).
- **`@opencomputer/flue/app`** — a default hosting app (`flue()` routes + `/health` + telemetry). Or
  `import '@opencomputer/flue/wire'` from your own `app.ts` for telemetry only.

## Minimal agent

```ts
import { defineAgent, defineAgentProfile } from "@flue/runtime";
import { useOcGateway, route, DEFAULT_MODEL } from "@opencomputer/flue";

export { route };

export default defineAgent((ctx) => {
  useOcGateway(ctx);
  return {
    profile: defineAgentProfile({ instructions: "You help customers." }),
    model: DEFAULT_MODEL, // prompt-caching-safe
  };
});
```

`src/app.ts`:

```ts
export { default } from "@opencomputer/flue/app";
```

Then `flue build --target cloudflare` and `oc agent deploy`. See `oc-flue-starter` for a full example.

## Environment (set on the tenant script by the OC deploy)

`OC_GATEWAY` and `OC_SESSION_TOKEN` are always managed by OC. Agents that explicitly use
`ocSandbox` use the managed `OC_SANDBOX_API`; `OC_SANDBOX_ID` may be pre-resolved. Reserved
`OC_`/`FLUE_` prefixes are platform-managed.
