# Self-host gateway (spike)

The hosted gateway, `services/managed-agents`, run on one VM under Miniflare: only the Computer path
(`src/selfhost/entry.ts`, `wrangler.selfhost.jsonc`). State persists under `/data`.

- `serve.mjs` builds the bundle (unless `GATEWAY_BUNDLE` names one), generates the gateway's keys once
  into `/data/keys.json`, applies D1 migrations and serves on `0.0.0.0:8080`.
- Sign-in: `Authorization: Bearer $SETUP_TOKEN` on `/v1/computer/*` (the hosted operator path, `BLUE_API_KEY`).
  The session API also needs `x-opencomputer-surface: api`.
- Host agent: `SP_GATEWAY_URL=ws://127.0.0.1:8080/v1/computer/host?organizationId=$GATEWAY_ORG`,
  `SP_HOST_ID=$GATEWAY_ORG`, `SP_HOST_TOKEN=$(cat /data/host-token)`.
- `dev/stub-model.mjs`: an echo stand-in for the Anthropic Messages API, for tests without a model key.
  `slow:<seconds>` in a prompt delays its answer.

```sh
SETUP_TOKEN=$(openssl rand -hex 32) GATEWAY_DATA=/tmp/gw node selfhost/gateway/serve.mjs
curl -H "Authorization: Bearer $SETUP_TOKEN" -H 'x-opencomputer-surface: api' -H 'content-type: application/json' \
  -d '{"input":"hello"}' localhost:8080/v1/computer/sessions
```
