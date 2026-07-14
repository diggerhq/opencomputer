# @opencomputer/flue

Run a stock [Flue](https://flueframework.com) app as an OpenComputer agent. Your compiled app is the
runtime; OpenComputer connects it to managed sessions, model access, and optional sandboxes. This
package supplies the OpenComputer-specific wiring the app opts into. Deployments use Flue's stock
`flue build --target cloudflare` output, with one Durable Object per session.

## What it gives you

- **`useOcGateway(ctx)` + `DEFAULT_MODEL`**: point the managed `anthropic` provider at the
  OpenComputer model gateway. Call it **inside** your `defineAgent` initializer.
- **`route`** — the HTTP-transport opt-in every OC-hosted agent must export (`export { route }`).
- **`ocSandbox(env)`** — optional, demand-driven Linux shell/files. Declaring it makes no network
  request; the first actual sandbox operation resolves the persistent session sandbox.
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

The current profile supports direct text sessions and optional demand-driven sandboxes. Channels,
workflows, repository sources, pull-request publishing, attachments, and arbitrary Worker egress are
not supported yet.

## Environment (set on the tenant script by the OC deploy)

`OC_GATEWAY` and `OC_SESSION_TOKEN` are always managed by OpenComputer. Agents that explicitly use
`ocSandbox` use the managed `OC_SANDBOX_API`. User variables come from `agent.toml [vars]`; write-only
secrets are set with `oc agent secret` and both take effect on the next deployment. Reserved
`OC_`/`FLUE_` prefixes are platform-managed.
