# Dev edge — prod-mirroring dashboard setup (igor-dev)

A personal **api-edge Worker** that mirrors prod's serving topology in front of
Igor's GCP dev box, so the dashboard frontend runs the *real* edge path (SPA
served from the Worker + WorkOS auth at the edge), not the local Vite dev
server. Use this when you need to validate edge behavior — e.g. the WorkOS
hosted-logout flow, which the vite-local setup bypasses (Vite proxies `/auth`
straight to the box's Go server, never through the edge).

## Two ways to run the dashboard against the dev box

1. **Vite local** (default, fastest) — `cd web && source ~/.opensandbox-gcp-dev.env && npm run dev`.
   SPA on `localhost:3000`, proxies `/api`,`/auth` to the box's Go server
   (`OC_API_TARGET`). Auth is the box's *combined-mode* Go path
   (`HandleLogin/Callback/Logout`). Good for UI iteration.
2. **Prod-mirror edge** (this doc) — a deployed CF Worker serves the SPA + runs
   the *edge* WorkOS path + reads dashboard data from D1, exactly like prod.
   Use when validating edge-specific behavior.

These are different auth code paths. The edge mints an `oc_session` JWT and
serves `/api/dashboard/*` from D1; the box's combined mode gates `/api/dashboard/*`
on the WorkOS cookie. Don't mix them.

## What's deployed

| Thing | Value |
|---|---|
| CF account | **Mo's** — `b8f23cb87a7a6c64040d3134643da448` |
| Worker | `opencomputer-api-edge-igor-dev` (also the sandbox-webhooks e2e worker — one edge, all routes, like prod) |
| URL | `https://opencomputer-api-edge-igor-dev.mo-b8f.workers.dev` |
| Config | `cloudflare-workers/api-edge/wrangler.igor-dev.toml` |
| D1 | `opencomputer-igor-dev` (`d5bbb12a-0491-4a95-9d7d-32ed8c3ce15d`) |
| Backend (cell) | Igor's GCP dev box `34.181.232.88:8080` (see `deploy/gcp/deploy-qemu-dev.sh`) |

The edge runs the **same `src/index.ts`** as prod. The only differences (see the
config header): no public routes (uses the `workers.dev` URL), no autumn cron, no
tail_consumer, no SESSIONS_KV (unused by the code).

## How requests flow (mirrors prod)

```
browser → opencomputer-api-edge-igor-dev.mo-b8f.workers.dev (Worker, run_worker_first)
  /auth/*            → WorkOS (edge mints oc_session JWT; hosted logout)
  /api/dashboard/*   → edge-native handlers, read from D1  (handleDashboard / dashboard.ts)
  /api/sandboxes …   → proxy to the owning cell (needs box wired as a cell — see below)
  everything else    → [assets] = the dashboard SPA (web/dist), SPA fallback
```

Because `/api/dashboard/*` is served from **D1 at the edge** (not proxied to a
cell), login + the dashboard render with **only** the edge + D1. The box-as-cell
wiring is needed only for real sandbox **data/ops** (otherwise the lists are
empty — see "Wire the box as a cell").

## Reproduce from scratch

All `wrangler` commands run from `cloudflare-workers/api-edge` with
`--config wrangler.igor-dev.toml` (which pins Mo's account + the D1). The repo
root has no `wrangler.toml`; the one in `api-edge/` points at **prod** — always
pass `--config`.

1. **D1 + schema.** The DB already exists; to recreate:
   `wrangler d1 create opencomputer-igor-dev` (in Mo's account), put the id in the
   config, then apply **only** the base schema:
   ```
   cd cloudflare-workers
   wrangler d1 execute opencomputer-igor-dev --config api-edge/wrangler.igor-dev.toml \
     --remote --file=schema.sql -y
   ```
   **Do NOT apply `schema_phase*.sql`** — `schema.sql` is the full current
   snapshot; the phase files are historical migrations and error with
   `duplicate column` on a fresh DB.
2. **Secrets** (`wrangler secret put <NAME> --config wrangler.igor-dev.toml`):
   - `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` — **staging** WorkOS, the *same app the
     dev box uses* (`client_01KHP753DZSAF3PMR9D28HDMRW`); values in
     `~/.opensandbox-gcp-dev.env`.
   - `SESSION_JWT_SECRET` — signs `oc_session`. Generated once and saved as
     `EDGE_SESSION_JWT_SECRET` in `~/.opensandbox-gcp-dev.env` (gitignored). Must
     equal the box's `OPENSANDBOX_SESSION_JWT_SECRET` to wire the box as a cell.
   - `EVENT_SECRET`, `SVIX_API_TOKEN` — webhooks e2e only (optional).
   - The remaining Env secrets (Stripe/Autumn/etc.) are path-specific and unused
     by the dashboard/auth path — leave unset.
3. **Build + stage the SPA** (mirrors `.github/workflows/deploy-api-edge.yml`):
   ```
   cd web && npm run build
   rm -rf cloudflare-workers/api-edge/assets \
     && cp -R web/dist/. cloudflare-workers/api-edge/assets/
   ```
   `api-edge/assets/` is gitignored (built output).
4. **Deploy:** `cd cloudflare-workers/api-edge && wrangler deploy --config wrangler.igor-dev.toml`.
5. **WorkOS dashboard (staging env)** — required, one-time per URL:
   - Allowlist the callback: `https://opencomputer-api-edge-igor-dev.mo-b8f.workers.dev/auth/callback`
   - Set the **Sign-out redirect** to `https://opencomputer-api-edge-igor-dev.mo-b8f.workers.dev/`
     (without it, logout → `app-homepage-url-not-found`).

## Redeploy after a frontend change

```
cd web && npm run build
rm -rf cloudflare-workers/api-edge/assets && cp -R web/dist/. cloudflare-workers/api-edge/assets/
cd cloudflare-workers/api-edge && wrangler deploy --config wrangler.igor-dev.toml
```

## Smoke test

```
URL=https://opencomputer-api-edge-igor-dev.mo-b8f.workers.dev
curl -s -o /dev/null -w '%{http_code}\n' "$URL/"                 # 200 (SPA)
curl -s -D - "$URL/auth/login" | grep -i location                # 302 → WorkOS, redirect_uri = $URL/auth/callback
curl -s -o /dev/null -w '%{http_code}\n' "$URL/api/dashboard/me" # 401 (unauth)
```

## Wire the box as a cell (deferred — only for real sandbox data/ops)

Login, logout, and the dashboard shell work without this, but session/checkpoint
lists stay empty until the box reports into the edge's D1. To wire it:

1. Set `OPENSANDBOX_SESSION_JWT_SECRET=$EDGE_SESSION_JWT_SECRET` on the box and
   redeploy (`deploy/gcp/deploy-qemu-dev.sh deploy`). This makes the box register
   its `/internal/*` routes and validate the edge's cap-tokens.
2. Insert a `cells` row in the D1 so the edge can route to it:
   ```
   wrangler d1 execute opencomputer-igor-dev --config api-edge/wrangler.igor-dev.toml --remote -y \
     --command="INSERT INTO cells (cell_id, cloud, region, base_url, status, accepts_new_orgs)
                VALUES ('gcp-use4-igor-dev','gcp','us-east4','http://34.181.232.88:8080','active',1);"
   ```
   (Reachability: CF Workers can `fetch` the box's public IP over http. Prod cells
   use HTTPS CF Tunnels; this dev shortcut may need revisiting if CF blocks it.)

## Status

Frontend + WorkOS auth + hosted logout: **live** at the URL above (pending the
WorkOS dashboard allowlist in step 5). Box-as-cell: **not wired** (dashboard
data empty until then).
