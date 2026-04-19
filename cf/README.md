# cf/ — Cloudflare edge for OpenComputer

This directory hosts the global layer described in `~/.claude/plans/goofy-snuggling-sloth.md`. Phase 1 ships only `events-ingest`; `api-edge`, `shared/credit_account.ts`, and the DO-backed halt/resume dispatch land in phases 2 and 3.

## Layout

```
cf/
├── schema.sql            # D1 schema — events + orgs + sandboxes_index + credit_account_snapshots
├── README.md             # this file
├── shared/
│   └── credit_account.ts # CreditAccount Durable Object (imported by both Workers)
├── events-ingest/        # Worker that receives event batches from regional CPs
│   ├── wrangler.toml     # declares the CreditAccount DO + migration
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   └── src/
│       ├── index.ts
│       └── index.test.ts
└── api-edge/             # Worker for Stripe webhooks + /internal/halt-list
    ├── wrangler.toml     # binds to CreditAccount DO via script_name
    ├── package.json
    ├── tsconfig.json
    ├── vitest.config.ts
    └── src/
        ├── index.ts
        └── index.test.ts
```

## One-time setup

### 1. Create Cloudflare resources

Run once per account. Paste the returned IDs into `events-ingest/wrangler.toml`.

```sh
# D1
wrangler d1 create opencomputer
# → outputs database_id — paste into wrangler.toml under [[d1_databases]]

# KV (for dedup markers seen:{event_id})
wrangler kv namespace create SESSIONS_KV
# → outputs id — paste into wrangler.toml under [[kv_namespaces]]

# R2 (raw batch archive)
wrangler r2 bucket create opencomputer-events-archive
# bucket_name is already set in wrangler.toml
```

### 2. Apply D1 schema

```sh
# Local dev database
wrangler d1 execute opencomputer --file=./schema.sql

# Remote (prod) database
wrangler d1 execute opencomputer --file=./schema.sql --remote
```

### 3. Set the HMAC secrets

Two separate HMAC secrets:

- `EVENT_SECRET` — signs event batches from CPs to `events-ingest`. Match with CP's `OPENSANDBOX_CF_EVENT_SECRET`.
- `CF_ADMIN_SECRET` — signs halt/resume webhooks from the DO/api-edge to CPs, and signs halt-list pulls from CPs to api-edge. Match with CP's `OPENSANDBOX_CF_ADMIN_SECRET`. Both Workers use this.

```sh
# Generate both
EVENT_SECRET=$(openssl rand -hex 32)
ADMIN_SECRET=$(openssl rand -hex 32)

cd events-ingest
echo "$EVENT_SECRET" | wrangler secret put EVENT_SECRET
echo "$ADMIN_SECRET" | wrangler secret put CF_ADMIN_SECRET

cd ../api-edge
echo "$ADMIN_SECRET" | wrangler secret put CF_ADMIN_SECRET
# Stripe webhook secret (from `stripe listen --forward-to localhost:8787/webhooks/stripe`
# or the Stripe dashboard)
wrangler secret put STRIPE_WEBHOOK_SECRET
# Optional: Stripe API key for server-side calls (future-proofing; not strictly needed for
# webhook signature verify).
wrangler secret put STRIPE_SECRET_KEY
```

### 4. Configure cell endpoints for DO dispatch (local dev only)

The `CreditAccount` DO dispatches `/admin/halt-org` and `/admin/resume-org` to CPs. In local dev it reads a comma-separated list of `cell_id=url` pairs from the `CELL_ENDPOINTS` var. Set this in `events-ingest/wrangler.toml`:

```toml
[vars]
CELL_ENDPOINTS = "dev-cell-a=http://host.docker.internal:8080"
```

For production, a cell registry table in D1 will replace this.

## Running the Worker

### Local dev

Two Workers. Run them on different ports:

```sh
# Terminal 1 — events-ingest on :8787
cd events-ingest && npm install && npx wrangler dev

# Terminal 2 — api-edge on :8788
cd api-edge && npm install && npx wrangler dev --port 8788

# Terminal 3 — Stripe webhook forwarding (if testing upgrade flow)
stripe listen --forward-to http://localhost:8788/webhooks/stripe
# copy the whsec_ value into api-edge's STRIPE_WEBHOOK_SECRET
```

Point the Go side at them:

```sh
export OPENSANDBOX_CELL_ID=dev-cell-a
export OPENSANDBOX_REDIS_URL=redis://localhost:6379

# Event pipe
export OPENSANDBOX_CF_EVENT_ENDPOINT=http://localhost:8787/ingest
export OPENSANDBOX_CF_EVENT_SECRET=$EVENT_SECRET

# Admin loop (halt/resume callbacks + halt-list safety net)
export OPENSANDBOX_CF_ADMIN_SECRET=$ADMIN_SECRET
export OPENSANDBOX_HALT_LIST_URL=http://localhost:8788/internal/halt-list

make run-full-server
make run-full-worker
```

Create a sandbox, run a command in it, wait a minute, then:

```sh
# Watch events land in local D1
wrangler d1 execute opencomputer --command "SELECT id, type, cell_id, org_id, sandbox_id, ts FROM events ORDER BY ts DESC LIMIT 20"

# Inspect the Redis stream directly
redis-cli XLEN events:dev-cell-a
redis-cli XRANGE events:dev-cell-a - + COUNT 5

# Check that the consumer group has drained
redis-cli XPENDING events:dev-cell-a cf-forwarder
```

### End-to-end test walkthrough

With both Workers + Go stack running:

1. **Create a sandbox** on a free-tier org via the CLI: `./bin/oc sandbox create`
2. **Watch events flow**:
   ```sh
   redis-cli XLEN events:dev-cell-a                       # should grow
   redis-cli XPENDING events:dev-cell-a cf-forwarder      # stays near zero
   wrangler d1 execute opencomputer --command "SELECT type, count(*) FROM events GROUP BY type"
   ```
3. **Watch sandboxes_index populate**:
   ```sh
   wrangler d1 execute opencomputer --command "SELECT id, org_id, cell_id, status FROM sandboxes_index"
   ```
4. **Watch DO debit**: after ~1 minute a `usage_tick` event lands. Inspect DO state:
   ```sh
   # (future: snapshot endpoint via api-edge; for now, watch api-edge logs)
   wrangler tail opencomputer-events-ingest
   ```
5. **Force a halt** (shortcut — set balance_cents to 1 and wait for next tick): easiest in phase 2 is to shrink the initial balance in `shared/credit_account.ts` temporarily, redeploy, and restart the test.
6. **Observe hibernate**: CP logs should show `admin: halt-org ... hibernated N/N sandbox(es)`. Confirm in PG: `SELECT sandbox_id, status FROM sandbox_sessions;`
7. **Upgrade flow**: trigger a real Stripe checkout completion (or `stripe trigger checkout.session.completed`). The api-edge Worker's logs should show the webhook hit, `DO mark-pro` fire, and — if there were hibernated sandboxes — `/admin/resume-org` dispatch that CP logs pick up.

### Tests

```sh
cd events-ingest && npm install && npm test
cd ../api-edge && npm install && npm test
```

### Deploy

```sh
cd events-ingest && npx wrangler deploy
cd ../api-edge && npx wrangler deploy
```

After deploy:
- `events-ingest` URL: `https://opencomputer-events-ingest.<subdomain>.workers.dev/ingest` → set as `OPENSANDBOX_CF_EVENT_ENDPOINT` on production CPs.
- `api-edge` URL: `https://opencomputer-api-edge.<subdomain>.workers.dev/internal/halt-list` → set as `OPENSANDBOX_HALT_LIST_URL` on production CPs. Register `https://<api-edge URL>/webhooks/stripe` as a Stripe webhook endpoint.

The DO is registered in `events-ingest`; `api-edge` references it via `script_name`. Deploy `events-ingest` first so the DO class exists when `api-edge` tries to bind.

## Troubleshooting

- **Events stuck in Redis stream** (`XPENDING` shows non-zero count that isn't draining): check CP logs for `event_forwarder: transient send error` — usually a bad HMAC secret mismatch or a 4xx from the Worker.
- **Worker returns 401 "bad signature"**: the CP's `OPENSANDBOX_CF_EVENT_SECRET` and the Worker's `EVENT_SECRET` must be byte-identical. Compare with `wrangler secret list` and the env var on the CP side.
- **Worker returns 401 "timestamp out of window"**: CP clock is skewed by more than 5 minutes. Fix NTP on the CP host.
- **D1 inserts silently failing**: the schema is applied to the wrong database. Re-run the `wrangler d1 execute` command with the correct `--database-name`.
