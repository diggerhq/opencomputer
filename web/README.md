# Dashboard (`web/`) — local dev

A Vite SPA on `localhost:3000`. It has no backend of its own — `vite.config.ts`
proxies API calls to whatever the env vars point at. There are two proxy
targets: the **shell / control-plane** and the **Agents/Sessions `/v3`** API.

## Quick start (against the GCP dev box)

```bash
cd web
npm install                        # once per checkout/worktree — node_modules is git-ignored and NOT shared across worktrees
source ~/.opensandbox-gcp-dev.env  # sets OC_API_TARGET -> the dev box (serves /me, /auth, /api/*); REQUIRED
npm run dev                        # -> http://localhost:3000
```

The GCP dev box (`deploy/gcp/deploy-qemu-dev.sh`) must be running. Always
`source` the env file — never `grep | cut` it: it uses `${VAR:-default}`
references that only expand when sourced (a literal `${...}` breaks WorkOS as
`invalid_client`; see `.agents/reference/dev-edge-setup.md`).

## The #1 gotcha: stuck on "Loading…"

Every route is gated on `getMe` -> `/api/dashboard/me`. That is **not** a `/v3`
path, so it proxies to `OC_API_TARGET`, which defaults to `http://localhost:8080`.
If nothing serves that, `/me` never resolves and you sit on the "Loading…"
spinner forever. Fix: `source ~/.opensandbox-gcp-dev.env` (points `OC_API_TARGET`
at the running dev box) before `npm run dev`.

## Env matrix — which var routes which requests

| var | routes | default |
|---|---|---|
| `OC_API_TARGET` | shell + control plane: `/api/*`, `/auth/*` — login, `/me`, org, billing, sandboxes | `http://localhost:8080` |
| `OC_V3_TARGET` | Agents/Sessions: `/api/dashboard/v3/*` | `https://api.opencomputer.dev` (prod) |
| `OC_V3_KEY` | when set, injects this `osb_` key into `/api/dashboard/v3/*` server-side (the key stays in the Node dev server, never in the browser bundle) so Agents/Sessions load without an edge or cookie | unset |

`OC_*` env vars are read at server **start** — restart `npm run dev` to change them.

## Viewing real prod Sessions/Agents

Keep the shell on the dev box (so `/me` resolves) and point `/v3` at prod with a
prod key:

```bash
source ~/.opensandbox-gcp-dev.env
OC_V3_TARGET=https://api.opencomputer.dev OC_V3_KEY='osb_…<prod org key>' npm run dev
```

Sessions/Agents pages then show that key's **prod** org. The shell identity
(sidebar/org) is still the dev box's — a cosmetic mismatch, fine for viewing.
`OC_V3_KEY` is effectively required to see any Sessions/Agents data locally
(without it `/v3` has no auth). Cookie auth can't bridge `localhost` to a remote
edge, so there is no clean full-prod-shell local path today.

## Worktrees / other branches

Each `git worktree` is its own directory with its own git-ignored `node_modules`,
so run `npm install` in `web/` the first time in any new worktree. `OC_*` vars are
per-invocation; nothing else differs by branch.

## Deeper references

- `.agents/reference/dev-edge-setup.md` — dev box + prod-mirror edge; CF / D1 / WorkOS quirks.
- `sessions-api` repo, `dev-env.md` — the `/v3` dev stack (`bolt-platform-dev`) and the `OC_V3_KEY` bypass.
