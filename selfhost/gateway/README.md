# Self-host gateway (spike)

The hosted gateway, `services/managed-agents`, run on one VM under Miniflare: only the Computer path
(`src/selfhost/entry.ts`, `wrangler.selfhost.jsonc`). In front of it, on the same port, `cloudflare-workers/api-edge`
with `SELFHOST=1` (WorkOS sign-in, invitations, no billing) serves the dashboard, `web/` built with `VITE_SELFHOST=1`.
A router Worker sends `/healthz`, `/setup*`, `/v1/*` and Slack's callback to managed-agents, the rest to api-edge.
State persists under `/data`.

- `serve.mjs` builds the bundles (unless `GATEWAY_BUNDLE` / `EDGE_BUNDLE` name them), generates the keys once
  into `/data/keys.json`, applies both D1 databases' migrations and serves on `0.0.0.0:8080`. It needs
  `web/dist` (`cd web && VITE_SELFHOST=1 npm run build`, or `WEB_DIST`).
- Dashboard sign-in: the WorkOS app and the owner's email from `/setup`; register `<PUBLIC_URL>/auth/callback`
  as the app's redirect URI. Others sign in once the owner invites them.
- Sign-in: `Authorization: Bearer $SETUP_TOKEN` on `/v1/computer/*` (the hosted operator path, `BLUE_API_KEY`).
  The session API also needs `x-opencomputer-surface: api`.
- Host agent: `SP_GATEWAY_URL=ws://127.0.0.1:8080/v1/computer/host?organizationId=$GATEWAY_ORG`,
  `SP_HOST_ID=$GATEWAY_ORG`, `SP_HOST_TOKEN=$(cat /data/host-token)`.
- Attachments: the bytes are in the `ATTACHMENTS` bucket under `/data/r2`, uploaded to and read from the gateway's
  own signed URLs (`/v1/computer/attachment-objects/…`, key `ATTACHMENTS_URL_KEY` in `keys.json`). With
  `ATTACHMENTS_S3_ENDPOINT`, `ATTACHMENTS_S3_BUCKET`, `ATTACHMENTS_S3_ACCESS_KEY_ID` and
  `ATTACHMENTS_S3_SECRET_ACCESS_KEY` set (optional `ATTACHMENTS_S3_REGION`), an S3-compatible store holds them instead.
- `dev/stub-model.mjs`: an echo stand-in for the Anthropic Messages API, for tests without a model key.
  `slow:<seconds>` in a prompt delays its answer.

```sh
SETUP_TOKEN=$(openssl rand -hex 32) GATEWAY_DATA=/tmp/gw node selfhost/gateway/serve.mjs
curl -H "Authorization: Bearer $SETUP_TOKEN" -H 'x-opencomputer-surface: api' -H 'content-type: application/json' \
  -d '{"input":"hello"}' localhost:8080/v1/computer/sessions
```

## Keeping it up (rootless Podman)

`restart: always` alone does not keep the gateway up. Podman counts `podman kill` as a stop by the user and leaves the
container `Exited (137)`, and after a reboot only `podman-restart.service` revives `always` containers. Instead, run the
stack under systemd as `oc-gateway`, with `selfhost/systemd/opencomputer-gateway.service`. It runs a foreground
`podman-compose up --abort-on-container-exit` with `Restart=always`, so any exit of the gateway brings it back in about 5 s,
and lingering starts it at boot.

```sh
sudo loginctl enable-linger oc-gateway
sudo -iu oc-gateway   # the stack in ~/selfhost (compose.yaml, .env)
install -D -m 0644 ~/selfhost/systemd/opencomputer-gateway.service ~/.config/systemd/user/opencomputer-gateway.service
systemctl --user daemon-reload && systemctl --user enable --now opencomputer-gateway.service
systemctl --user status opencomputer-gateway   # podman logs opencomputer_gateway_1: the gateway itself
```

Another directory, a tunnel profile or a project name: `systemctl --user edit opencomputer-gateway` and set
`WorkingDirectory=`, `Environment=COMPOSE_PROFILES=cloudflared` or `Environment=COMPOSE_PROJECT_NAME=…`. Stop it with
`systemctl --user stop`, not `podman stop`, or systemd starts it again.
