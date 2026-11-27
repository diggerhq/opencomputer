# Self-host: the web dashboard and WorkOS sign-in on the single-VM gateway

Goal: the single-VM gateway (`selfhost/gateway`) serves the hosted web dashboard (`web/`) with
WorkOS sign-in, so an operator can sign in, see the dashboard, start a Computer session from the
UI and invite a member. Branch `feat/selfhost-web-ui`, onto `spike/selfhost-miniflare`.

## Shape

One Miniflare process, two Workers, one public origin (`:8080`):

- **api-edge** (`cloudflare-workers/api-edge`) is the public Worker, as in the hosted deployment:
  `/auth/*` (WorkOS AuthKit), `/api/dashboard/*`, `/api/managed-agents/*`, the SPA from `web/dist`
  as its `ASSETS`.
- **managed-agents** (`services/managed-agents/src/selfhost/entry.ts`) keeps `/setup`, `/healthz`,
  the host WebSocket and the Slack webhooks. A small router in front sends those paths to it and
  everything else to api-edge.
- api-edge reaches managed-agents through a service binding instead of `MANAGED_AGENTS_API_URL`,
  with the shared `OC_MANAGED_AGENTS_SECRET` / `OC_MANAGED_CRED_HMAC_SECRET` pairing that
  `api-edge/scripts/stack.mjs` uses. Secrets are generated into `/data/keys.json` on first start.
- A self-host flag in api-edge turns off billing (Autumn, Stripe, OpenRouter provisioning, the
  credit gate) and telemetry (Tinybird, PostHog, Loops, Slack alerts).
- WorkOS client ID and API key come from `/setup` (ACCOUNTS); the redirect URI is
  `<PUBLIC_URL>/auth/callback`. The first organization and its owner (the operator's email, from
  `/setup`) are seeded in api-edge's D1.
- Invites use api-edge's WorkOS invitations (WorkOS sends the email).

## Steps

1. serve.mjs: two Workers, api-edge's D1 migrations, assets; a router Worker.
2. api-edge self-host flag; service binding hop.
3. managed-agents entry: dashboard routes behind the api-edge principal (service binding only).
4. WorkOS settings from `/setup` into api-edge; seed org and owner.
5. Gateway image builds `web/` and bundles api-edge.
6. Tests: api-edge and managed-agents suites unchanged; self-host tests.
7. VM test on the Azure test VM; docs and `/setup` copy.
