# Sandbox lifecycle webhooks — implementation plan

Status: **design draft, implementation not started** (opened 2026-06-24, off `main`
@ `6ed835c`). Branch: `feat/sandbox-webhooks`. This is a **complete reference** — a
future implementer should be able to work from this doc + the cited code without the
conversation that produced it.

## Goal

Let a user **subscribe to sandbox lifecycle events** (`POST /api/webhooks`) and have
OpenComputer deliver them to an HTTPS endpoint with the **same delivery semantics** the
managed-agent control plane (`sessions-api`) already ships for session webhooks:
retried, dead-lettered, redeliverable, signed (Standard Webhooks), idempotent.

This brings webhooks down a layer — from the agent/session product (sessions-api) to
**OC core itself** (the sandbox platform), so any sandbox user, not just Durable Agent
Sessions users, can react to sandbox state changes.

### Non-goals (v1)
- Inbound webhooks (we already have Stripe + admin DO callbacks; those stay).
- Per-event-content webhooks beyond the lifecycle taxonomy in §3 (no exec output, no
  file events).
- A dashboard UI (P4, separate).

## Sources / prior art

The semantics here are a deliberate port of the **sessions-api** webhook subsystem; read
it before implementing. Sibling repos under `~/Digger/_ws_opencomputer/`.

- **sessions-api (the reference implementation to mirror):**
  - Schema: `sessions-api/migrations-v3/001_init.sql` (`destinations`, `deliveries`,
    `dispatch_outbox`), `migrations-v3/002_credential_secrets.sql` (encrypted secrets).
  - Projection (event → deliveries): `src/v3/delivery/projection.ts`.
  - Claim + ledger: `src/v3/delivery/claim.ts`. Send + signing: `src/v3/delivery/egress.ts`.
    SSRF: `src/v3/delivery/ssrf.ts`. Reconciler: `src/v3/delivery/reconcile.ts`.
  - Public API: `src/v3/api/destinations.ts`. Internal send endpoint:
    `src/v3/internal/deliveries.ts`. Queue worker: `workers/product-async/src/index.ts`.
  - User-facing docs to mirror for the core docs page:
    `opencomputer/docs/agent-sessions/webhooks.mdx`.
- **oc-bg-agents (the conceptual design of the delivery/outbox model):**
  - `oc-bg-agents/.agents/design/005-messaging-and-channels.md` — delivery as events,
    the outbox/connector pattern, redelivery, dedupe.
  - `oc-bg-agents/.agents/design/003-runtime-contract.md` §5 (event taxonomy / planes).
- **OC core building blocks we reuse** (file refs from a 2026-06-24 survey; confirm exact
  lines at implementation):
  - Lifecycle event source: `internal/cellevents/publish.go` (`PublishLifecycle`),
    `internal/controlplane/event_forwarder.go` (Redis Streams consumer-group + reclaim),
    `internal/worker/redis_event_publisher.go` (deterministic event IDs).
  - Lifecycle hooks: `internal/sandbox/lifecycle.go` (`LifecycleObserver`),
    `internal/db/store.go` (`UpdateSandboxSessionStatus` + its terminal hook),
    `internal/sandbox/router.go` (state machine).
  - **Outbox-poller delivery pattern to copy:** `internal/billing/billable_events_sender.go`
    + the `billable_events` table (migration `030`).
  - HMAC + backoff + Retry-After: `internal/controlplane/cf_event_client.go`.
  - Auth + API conventions: `internal/auth/middleware.go` (`PGAPIKeyMiddleware`,
    `auth.GetOrgID`), `internal/api/router.go`, `internal/api/sandbox.go` (handler
    template), `internal/db/store.go` (store template), `internal/db/migrations/`,
    `pkg/types/`.
  - Existing operator SSE (not user-facing): `internal/api/admin_events.go`.

## The one load-bearing design decision: mirror semantics, own the timer in Postgres

sessions-api runs delivery on **Cloudflare Queues + a relay + a regional send hop** — the
queue is the retry timer, a `dispatch_outbox` table bridges the DB to the queue, and the
signing secret stays in the regional container. OC core has **no equivalent queue in this
path**; its durable async pattern is a **Postgres-backed poller** (`BillableEventsSender`).

So core mirrors the *observable* semantics (state machine, backoff schedule, dead-letter,
redelivery, signing, SSRF) but **owns the retry timer in Postgres** via a `next_attempt_at`
column and a poll loop. Consequences, all simplifications:
- **No `dispatch_outbox` table.** The `webhook_deliveries` ledger *is* the work queue
  (rows due when `next_attempt_at <= now()`).
- **No queue, no relay, no separate send hop.** One in-process Go dispatcher does
  claim → sign → send → record. The secret never leaves the control-plane process by
  construction (sessions-api needs explicit care to keep it regional).
- **We set the retry window explicitly** instead of inheriting Cloudflare's ~10-tries/~1h.

### Decisions locked (challenge before building)

| # | Decision | Rationale |
|---|---|---|
| D1 | Delivery = Postgres-backed Go poller (mirror `BillableEventsSender`), **not** CF Queues | Fits core's stack; no new infra; self-contained |
| D2 | `webhook_deliveries` ledger doubles as the work queue (`next_attempt_at`); no outbox table | The outbox in sessions-api exists only to bridge to CF Queues |
| D3 | Projection seam = a **new Redis consumer group** on the existing lifecycle stream (reuse `event_forwarder.go`'s consumer-group + `XAUTOCLAIM` reclaim) | It's the one place every lifecycle event is already normalized; consumer groups are independent of the existing CF-forwarder consumer |
| D4 | Subscriptions are **org-scoped** with optional filters (`event_types`, `sandbox_id`) | Core has no "session"; org is the tenancy unit |
| D5 | Signing = **Standard Webhooks** (`webhook-id`/`webhook-timestamp`/`webhook-signature`), identical to sessions-api | Consistency; recipients can reuse the same verifier across both products |
| D6 | At-least-once; the **delivery row is source of truth**; recipients dedupe on `webhook-id` | Same contract as sessions-api |
| D7 | Event names namespaced `sandbox.*` (e.g. `sandbox.stopped`) | A stable public taxonomy distinct from the bare worker strings (`"stopped"`) used internally today |

## 3. Event taxonomy (the public surface)

Each delivered event is one sandbox lifecycle moment. **Several already emit on the Redis
stream; several do not yet and must be added — this is the largest non-plumbing line item.**

| Public type | Emits today? | Source site | Notes |
|---|---|---|---|
| `sandbox.created` | ✅ (`"created"`) | worker create → `redis_event_publisher.go` | includes memory/cpu/template |
| `sandbox.running` | ✅ (`"running"`) | worker, post-boot | may fold into `created` — see O3 |
| `sandbox.hibernated` | ✅ (`"hibernated"`) | `api/sandbox.go:hibernateSandbox` + `OnSandboxHibernate` | |
| `sandbox.woke` | ✅ (`"woke"`) | `api/sandbox.go:wakeSandbox` + `OnSandboxWake` | |
| `sandbox.stopped` | ✅ (`"stopped"`) | `db/store.go:UpdateSandboxSessionStatus` terminal hook | carries `reason` (incl. `crash`) |
| `sandbox.migrated` | ✅ (`"migrated"`) | worker migrate | |
| `sandbox.checkpoint.created` | ❌ **gap** | `api/sandbox.go:createCheckpoint` | not a state change today → no event |
| `sandbox.forked` | ⚠️ partial | `api/sandbox.go:forkSandbox` | emits `created` for the child; no explicit `forked` w/ parent ref |
| `sandbox.scaled` | ❌ **gap** | `api/sandbox.go:setSandboxResourceLimits` + `OnSandboxScale` | hook exists (billing); no external event |
| `sandbox.preview_url.changed` | ❌ **gap** | `api/sandbox.go:updateSandboxPort` | proxy-only today |
| `sandbox.crashed` | ⚠️ as `stopped(reason=crash)` | worker orphan reaper → terminal hook | decide: distinct type or `stopped.reason` |

**Event id (dedup key).** Reuse the worker's deterministic envelope id
(`{sandboxID}:{generation}:{row_id}` — `redis_event_publisher.go`). For events added in the
gap rows above, mint an equally deterministic id at the emit site so replay is idempotent.

**Envelope** (the JSON body POSTed; mirrors sessions-api's shape):
```json
{
  "type": "sandbox.stopped",
  "sandbox_id": "sb-xxxxxxxx",
  "event_id": "sb-xxxxxxxx:3:142",
  "event": {
    "id": "sb-xxxxxxxx:3:142",
    "ts": "2026-06-24T12:00:00Z",
    "org_id": "<uuid>",
    "sandbox_id": "sb-xxxxxxxx",
    "type": "sandbox.stopped",
    "data": { "reason": "user_requested" }
  }
}
```

## 4. Data model

New migration `internal/db/migrations/0NN_sandbox_webhooks.up.sql` (+ `.down.sql`). Raw
SQL + pgx, matching `store.go`. Two tables; **no outbox** (D2).

```sql
-- Subscriptions.
CREATE TABLE webhook_destinations (
  id            text PRIMARY KEY,                 -- 'whk_' + random
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  url           text NOT NULL,                    -- https only; SSRF-validated at write + send
  event_types   text[] NOT NULL DEFAULT '{}',     -- empty = all; exact ('sandbox.stopped') or prefix ('sandbox.*')
  sandbox_id    text,                             -- optional: scope to one sandbox (NULL = all org sandboxes)
  -- secret, encrypted at rest (AES-256-GCM); write-only (never returned)
  secret_ciphertext bytea,
  secret_iv         bytea,
  secret_tag        bytea,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_dest_org_idx ON webhook_destinations(org_id) WHERE enabled;

-- Delivery ledger (also the work queue).
CREATE TABLE webhook_deliveries (
  id            text PRIMARY KEY,                 -- 'whd_' + random
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  destination_id text NOT NULL REFERENCES webhook_destinations(id) ON DELETE CASCADE,
  event_id      text NOT NULL,                    -- deterministic; dedup
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,                   -- the rendered envelope (lifecycle payloads are small)
  status        text NOT NULL DEFAULT 'pending',  -- pending|delivering|delivered|failed|dead_letter
  attempts      int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),  -- the timer
  locked_by     text,
  locked_until  timestamptz,
  response_code int,
  error         text,                             -- <=400 chars
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz,
  UNIQUE (destination_id, event_id)               -- idempotent projection
);
-- The poll query's index: rows that are due.
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries(next_attempt_at)
  WHERE status IN ('pending','failed');
CREATE INDEX webhook_deliveries_dest_idx ON webhook_deliveries(destination_id, created_at DESC);
```

**Secret storage.** Mirror `credential_secrets` (sessions-api): AES-256-GCM, key from an
env-configured master key (reuse core's existing secret-encryption key if one exists —
confirm in `internal/secretsproxy`/secret store; else add `WEBHOOK_SECRET_KEY`). Write-only:
the API never returns it, only `has_secret: bool`. `whsec_`-prefixed secrets are
base64-decoded for HMAC key bytes; otherwise UTF-8 (Standard Webhooks convention).

## 5. Projection: lifecycle event → delivery rows

A new control-plane component, **`webhook-projector`**, joins the lifecycle Redis stream as
its own consumer group (reuse the consumer-group + `XAUTOCLAIM` reclaim machinery in
`event_forwarder.go`; it runs independently of the existing `cf-forwarder` consumer).

Per consumed lifecycle event, in **one transaction**:
1. Map the bare worker type (`"stopped"`) → the public type (`sandbox.stopped`).
2. `SELECT` enabled destinations for `event.org_id` where the type matches the
   `event_types` filter (empty = all; exact or `prefix.*`) **and** (`sandbox_id IS NULL`
   OR `sandbox_id = event.sandbox_id`).
3. For each, `INSERT INTO webhook_deliveries (... status='pending', next_attempt_at=now())
   ON CONFLICT (destination_id, event_id) DO NOTHING` — replay-safe.
4. After commit, `pg_notify('webhook_due', '')` to wake the dispatcher (low latency).

**Why the stream, not the `LifecycleObserver`/terminal hook:** worker-published events
(`created`/`running`/`woke`) never pass through the CP status write, so only the Redis
stream sees *all* transitions. (For the subset that does flow through
`UpdateSandboxSessionStatus`, a same-transaction insert is the truest outbox and may be
added later as an optimization — O4.)

## 6. Delivery worker (the dispatcher)

A Go background loop in the control plane (mirror `billable_events_sender.go`'s structure:
ticker + `select{}` graceful stop), additionally woken by `LISTEN webhook_due` for latency.
Multiple CP instances run it safely via row locks.

Per pass:
1. **Claim** a batch:
   ```sql
   SELECT * FROM webhook_deliveries
   WHERE status IN ('pending','failed') AND next_attempt_at <= now()
   ORDER BY next_attempt_at
   FOR UPDATE SKIP LOCKED LIMIT 50;
   ```
   For each claimed row: `UPDATE … SET status='delivering', attempts=attempts+1,
   locked_by=$me, locked_until=now()+interval '60 seconds'`.
2. Load destination + decrypt secret (in-process). **SSRF-validate + pin the URL** (§8).
3. **Sign** (§7) and POST: 10s connect / 15s read, **no redirects**, response body bounded
   (capture ≤64KB, store ≤400-char snippet in `error`).
4. **Classify** (mirror `egress.ts:classifyStatus`):
   - `2xx` → `status='delivered'`, `delivered_at=now()`, clear lock.
   - `5xx` / timeout / network error → `status='failed'`, `next_attempt_at = now() +
     backoff(attempts)`, clear lock.
   - `4xx` / `3xx` / SSRF-block → `status='failed'` **permanent** (do not reschedule) →
     treated as terminal-fail (see dead-letter).
   - When `attempts >= MAX_ATTEMPTS` → `status='dead_letter'`.
5. Clear `locked_by/until`.

**Backoff** (`backoff(attempts)`, mirror sessions-api): 10s, 30s, 60s, 5m, 15m (capped at
15m). **`MAX_ATTEMPTS` / window** is ours to set (D1) — proposed 12 attempts (~a few hours)
→ `dead_letter`; confirm in O2.

**Latency.** Billing polls every 5 min — far too slow here. Use a short base interval
(~1s) plus `LISTEN/NOTIFY` wake so a fresh event delivers in ~ms.

## 7. Signing (Standard Webhooks)

Identical to sessions-api (`egress.ts:signStandardWebhook`) so one verifier works across
both products. Headers on every POST:
- `webhook-id`: the event id (recipients dedupe on this).
- `webhook-timestamp`: unix seconds (replay guard, ±5 min).
- `webhook-signature`: `v1,<base64(HMAC-SHA256(secretBytes, "{id}.{ts}.{rawBody}"))>`.
- `X-OC-Delivery-ID`, `X-OC-Sandbox-ID`; `User-Agent: OpenComputer-Webhooks/1`;
  `Content-Type: application/json`.

Core already has the HMAC primitive (`cf_event_client.go`); this is a reformat into the
Standard Webhooks header layout, not new crypto. Ship a verifier snippet in the docs.

## 8. SSRF defense (security-critical, net-new)

Core only calls its own fixed endpoints today, so there is **no** SSRF guard. User URLs
need one. Port `src/v3/delivery/ssrf.ts` to Go:
- **At registration** (`POST/PATCH /api/webhooks`): require `https`, resolve the host,
  reject if any resolved IP is in a blocked range.
- **At send**: re-resolve, re-check, **pin** the connection to the resolved IP (custom
  `DialContext`) to defeat DNS-rebind; do not follow redirects.
- **Blocked ranges** (fail-closed if *any* resolved address matches): loopback, RFC1918
  private, link-local incl. `169.254.0.0/16` (cloud metadata), IPv6 ULA/link-local,
  multicast, reserved, CGNAT, TEST-NET.

## 9. Reconciler

A periodic sweep (can be a slower tick in the same dispatcher process, mirror
`reconcile.ts` but smaller — no outbox to republish):
- **Reclaim crashed senders:** `status='delivering'` AND `locked_until < now()-30s` →
  `status='failed'`, clear lock (the poll loop requeues it).
- **Alert only:** count non-terminal rows with `updated_at < now()-1h` → emit an alert
  metric (no write).

## 10. Public API

Echo handlers in `internal/api/webhooks.go`, wired in `router.go`, store methods in
`store.go`, types in `pkg/types/webhook.go`. Auth: `PGAPIKeyMiddleware`, org-scoped via
`auth.GetOrgID`. New scopes `webhooks:read` / `webhooks:write` in `api_keys.scopes`.

| Method · Path | Scope | Purpose |
|---|---|---|
| `POST /api/webhooks` | write | Register: `{ url, secret?, event_types?, sandbox_id?, enabled? }` → SSRF-validate |
| `GET /api/webhooks` | read | List org destinations |
| `GET /api/webhooks/:id` | read | One destination (no secret; `has_secret`) |
| `PATCH /api/webhooks/:id` | write | Update url/event_types/sandbox_id/enabled; rotate secret |
| `DELETE /api/webhooks/:id` | write | Remove |
| `GET /api/webhooks/:id/deliveries?status=&after=&limit=` | read | Delivery history |
| `GET /api/webhooks/:id/deliveries/:deliveryId` | read | One delivery, detail |
| `POST /api/webhooks/:id/deliveries/:deliveryId/redeliver` | write | Re-enqueue **any** delivery (set `pending`, `next_attempt_at=now()`, clear lock; **preserve `attempts`**) |
| `POST /api/webhooks/:id/test` | write | Send a synthetic `sandbox.test` event to validate the endpoint+secret |

Destination response: `{ id, url, event_types, sandbox_id, enabled, has_secret,
created_at, updated_at }`. Delivery response mirrors sessions-api (`id, destination,
event_id, event_type, status, attempts, last_attempt_at, response_code, error,
created_at, delivered_at`).

## 11. Reliability semantics (the contract we're promising)

- **At-least-once.** Retries can duplicate; recipients dedupe on `webhook-id`.
- **Idempotent projection.** `UNIQUE(destination_id, event_id)` — one delivery row per
  destination+event regardless of stream replay.
- **Ordering.** Per destination, claimed in `next_attempt_at` order; no cross-destination
  order guarantee (parallel sends). Not strict per-sandbox ordering — document it.
- **Source of truth** is the `webhook_deliveries` row, not any queue.
- **Dead-letter** is terminal in the DB; `redeliver` is the escape hatch (works on any
  status, preserves history).

## 12. Implementation map (files)

| Area | New / changed |
|---|---|
| Migration | `internal/db/migrations/0NN_sandbox_webhooks.{up,down}.sql` |
| Store | `internal/db/store.go` — `CreateWebhookDestination`, `List/Get/Update/Delete`, delivery list/get, `ClaimDueDeliveries`, `RecordDeliveryResult`, `ReclaimStaleDeliveries`, `ProjectDeliveriesForEvent` |
| Types | `pkg/types/webhook.go` |
| API | `internal/api/webhooks.go` (handlers) + routes in `internal/api/router.go` + scopes |
| Projector | `internal/controlplane/webhook_projector.go` (new Redis consumer group) |
| Dispatcher + reconciler | `internal/controlplane/webhook_dispatcher.go` (poll/claim/send + sweep) |
| Signing | `internal/webhook/sign.go` (Standard Webhooks) |
| SSRF | `internal/webhook/ssrf.go` (port of `ssrf.ts`) |
| Secret crypto | reuse core secret encryption, else `internal/webhook/secret.go` |
| Event emission gaps | emit `sandbox.checkpoint.created` / `sandbox.scaled` / `sandbox.preview_url.changed` / explicit `sandbox.forked` at their sites (`api/sandbox.go`) via `cellevents.PublishLifecycle` |
| Docs | `docs/sandboxes/webhooks.mdx` (mirror `docs/agent-sessions/webhooks.mdx`) |
| Wiring | start projector + dispatcher in `cmd/server/main.go` |

## 13. Phasing

- **P1 — subscribe + send (happy path).** Migration + 2 tables, CRUD API, encrypted
  secret, projector off the lifecycle stream (the events that emit today), dispatcher with
  signing + SSRF + classify. Delivers value for `created/stopped/hibernated/woke/migrated`.
- **P2 — reliability parity ("redeliveries and all").** Backoff + dead-letter, `locked_until`
  + reconciler reclaim, redelivery + delivery list/get, `/test`.
- **P3 — taxonomy completeness.** Emit the gap events (checkpoint/scale/preview-url/explicit
  fork), per-type filtering polish, docs + verifier snippet.
- **P4 — dashboard** (delivery history + manual retry UI).

## 14. Decisions to confirm (open questions)

- **O1 — subscription scope.** Org-wide + optional `sandbox_id`/`event_types` (D4). Do we
  also want label-selector filtering (tags exist — see `sandbox-tags-impl.md`)? Probably P3.
- **O2 — retry window.** `MAX_ATTEMPTS` + total window (proposed 12 / a few hours). Confirm.
- **O3 — `created` vs `running`.** Two events or one? (Worker emits both; users likely want
  one "sandbox is up" signal.)
- **O4 — projection seam.** Redis consumer group (D3) is primary; do we *also* add a
  same-tx outbox insert for CP-initiated transitions for stronger atomicity, or is the
  stream's at-least-once + unique-index enough? (Proposed: stream only for v1.)
- **O5 — secret key management.** Reuse an existing core master key or introduce
  `WEBHOOK_SECRET_KEY`? Confirm against `internal/secretsproxy`/secret store.
- **O6 — crash signal.** Distinct `sandbox.crashed` type, or `sandbox.stopped` with
  `data.reason="crash"` (current internal shape)? Recommend the latter for fewer types.
- **O7 — prod DB rule.** Per `AGENTS.md`, prod DB mutations need approval and migrations are
  gated; the migration + any backfill must follow that process (this doc adds tables only,
  no backfill).
