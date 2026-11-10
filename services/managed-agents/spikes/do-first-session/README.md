# DO-first full session example

This spike runs the existing Serverless Agents session and OpenCode runtime,
but changes when the runtime starts. Session creation initializes only the
session Durable Object. The first queued turn persists and streams its normal
session events, claims one runtime start, pulls the pinned deployment from the
existing account Durable Object, and then requests the existing MicroVM runtime.

The runtime still downloads and verifies the deployment artifact, renders the
reactive agent, requests model configuration, and streams runtime events through
the existing session WebSocket. No agent artifact or user code executes in the
control-plane Worker.

## Local verification

The local full-example configuration deliberately has no runtime service. Its
test proves that the session is created without a runtime, a turn streams before
runtime availability, deployment configuration is resolved, and a failed start
claim is released for retry:

```bash
npx vitest run --project do-first-session-full-example
```

## Development deployment

A development deployment needs its own Wrangler configuration (not checked in;
start from `wrangler.jsonc`), here called `wrangler.dev.jsonc`. It is isolated
from the development edge Worker: it owns a separate session Durable Object
namespace, reads deployment configuration from that Worker's account Durable
Objects (a `script_name` binding), and calls the development platform Worker
(service bindings).

Before deploying:

1. Set `BLUE_ACCOUNT_ID` in `wrangler.dev.jsonc` to the account that owns the
   development agent.
2. Create a dedicated random API key. Do not reuse a production credential:

   ```bash
   npx wrangler secret put BLUE_API_KEY --config spikes/do-first-session/wrangler.dev.jsonc
   ```

3. Give the isolated Worker a development OpenRouter key for its model gateway.
   Worker secrets are not inherited from the development edge Worker:

   ```bash
   npx wrangler secret put OPENROUTER_API_KEY --config spikes/do-first-session/wrangler.dev.jsonc
   ```

4. Deploy only the isolated development Worker:

   ```bash
   npm run deploy -- --config spikes/do-first-session/wrangler.dev.jsonc
   ```

Run a deployed agent and print every event with elapsed milliseconds:

```bash
DO_FIRST_SPIKE_URL=https://<worker-name>.<subdomain>.workers.dev \
DO_FIRST_SPIKE_API_KEY=<dedicated-development-key> \
DO_FIRST_SPIKE_AGENT=<agent-id>@development \
node spikes/do-first-session/run-full-example.mjs
```

Expected ordering is `session.created`, `message.received`, `turn.queued`,
`session.status_changed` to `waiting_runtime`, `runtime.log` phases for the
durable start claim and configuration lookup, then `runtime.connected`,
`turn.started`, model/tool deltas, and `turn.completed`.

The runner prints `session_created`, `stream_connected`, and every event with an
`elapsedMs` field so the real DO response, MicroVM handoff, runtime connection,
and first output can be compared directly.
