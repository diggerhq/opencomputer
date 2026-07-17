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
- **`ocRepoTools(ctx)`** — managed repository discovery, exact-SHA checkout into the session
  sandbox, and OpenComputer-authored GitHub pull requests.
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

## Repository work

Give a hosted agent the standard repository tools beside its sandbox:

```ts
import { defineAgent, defineAgentProfile } from "@flue/runtime";
import {
  DEFAULT_MODEL,
  ocRepoTools,
  ocSandbox,
  route,
  useOcGateway,
} from "@opencomputer/flue";

export { route };

export default defineAgent((ctx) => {
  useOcGateway(ctx);
  return {
    profile: defineAgentProfile({
      instructions:
        "List working repositories, resolve an exact owner/repository, add it, edit and test only in the returned source path, then open a pull request.",
    }),
    model: DEFAULT_MODEL,
    sandbox: ocSandbox(ctx.env),
    tools: ocRepoTools(ctx),
  };
});
```

`list_working_repos` returns only repositories allowed by the agent's current
OpenComputer policy and GitHub App grant. `add_source` pins the selected ref to
an exact commit and returns its `/workspace/sources/...` path.
`github_publish_pull_request` publishes that source's inspected changes on an
`oc/...` branch. The tools do not default to the deployment repository, expose
credentials, or perform fuzzy repository selection. A session supports up to
eight sources; reuse an existing source or start a new session after reaching
that limit.

Direct text sessions, managed Slack, workflows, and optional demand-driven
sandboxes continue to use ordinary Flue behavior.

## Environment (set on the tenant script by the OC deploy)

`OC_GATEWAY`, `OC_SESSION_TOKEN`, and `OC_REPO_API` are managed by
OpenComputer. Agents that explicitly use `ocSandbox` use the managed
`OC_SANDBOX_API`. User variables come from `agent.toml [vars]`; write-only
secrets are set with `oc agent secret` and both take effect on the next
deployment. Reserved `OC_`/`FLUE_` prefixes are platform-managed.
