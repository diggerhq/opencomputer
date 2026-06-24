# Sandbox lifecycle webhooks — implementation plan

Status: **design draft, rev 2 (code-review fixes folded in 2026-06-24), implementation not
started** (off `main` @ `6ed835c`). Branch: `feat/sandbox-webhooks`. This is a **complete
reference** — a future implementer should be able to work from this doc + the cited code
without the conversation that produced it.

Rev-2 resolved the five blockers a review flagged — **signing-secret behavior** (auto-generated,
returned once; §7), **source durability** (dual projection path; §5, §11), **Redis reclaim
method** (XPENDING+XCLAIM, not XAUTOCLAIM; §5), **deterministic event IDs** (§3), and the
**delivery state machine** (`failed`=retryable vs `dead_letter`=terminal; §6) — plus the P2/P3
items (scopes, mutation semantics, missing tenancy, schema cleanup).

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
| D3 | **Dual projection.** CP-DB transitions (terminal hook + CP-side gap emitters) insert delivery rows **in the same DB transaction** as the state write (durable, deterministic id, no Redis). Worker-published transitions are projected by a **new Redis consumer group** on the lifecycle stream, reclaiming via **`XPENDING`+`XCLAIM`** (NOT `XAUTOCLAIM` — Azure Redis 6.0 lacks it; copy `event_forwarder.go:171`) | The DB path makes the important events (stopped/crash) fully durable; the stream path covers worker-only events; both dedupe on `UNIQUE(dest,event_id)` |
| D4 | Subscriptions are **org-scoped** with optional filters (`event_types`, `sandbox_id`) | Core has no "session"; org is the tenancy unit |
| D5 | Signing = **Standard Webhooks** (`webhook-id`/`webhook-timestamp`/`webhook-signature`), identical to sessions-api | Consistency; recipients can reuse the same verifier across both products |
| D6 | At-least-once; the **delivery row is source of truth**; recipients dedupe on `webhook-id` | Same contract as sessions-api |
| D7 | Event names namespaced `sandbox.*` (e.g. `sandbox.stopped`) | A stable public taxonomy distinct from the bare worker strings (`"stopped"`) used internally today |
| D8 | **Every webhook is signed; the secret is auto-generated.** Create mints a `whsec_…` secret if the caller gives none, returns it **once** in the response, and stores it write-only (encrypted). No unsigned path | The "every delivery is signed" contract can't coexist with an optional secret |
| D9 | **State machine is explicit.** `failed` = retryable (always carries a future `next_attempt_at`, in the due index); `dead_letter` = terminal (permanent failure OR exhausted attempts, never in the due index) | A `failed` row that is also permanent would be re-claimed forever (the P2 ambiguity) |
| D10 | **No granular scopes in v1.** Auth = a valid org API key (org-scoped ownership), like every other `/api/*` route. Scope enforcement doesn't exist in `middleware.go`/`ValidateAPIKey` yet | Don't advertise `webhooks:read/write` scopes the platform can't enforce |
| D11 | **Secret + payload crypto reuse `internal/crypto/encrypt.go`** (one `nonce‖ciphertext` bytea), not bespoke ciphertext/iv/tag columns | Match the existing encryptor; one less crypto surface |

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

**Event id (dedup key) — must be deterministic.** Worker-published events already carry a
deterministic envelope id (`{sandboxID}:{generation}:{row_id}` — `redis_event_publisher.go`),
which is what makes `ON CONFLICT (destination_id, event_id)` idempotent across stream
replay/reclaim. **Gotcha:** the CP helper `cellevents.PublishLifecycle` mints a fresh
`uuid.NewString()` per call (`internal/cellevents/publish.go:30`) — routing gap events through
it as-is would give every replay a new id and **defeat dedup**. So:
- For **CP-DB transitions** (the durable path, D3), the delivery row is inserted in the same
  transaction and its `event_id` is derived from the source DB row (e.g.
  `{sandbox_id}:{status}:{status_changed_at}` or the session-status row id) — deterministic by
  construction.
- For any event still emitted via the Redis helper, add **`PublishLifecycleWithID(id, …)`**
  (or make `PublishLifecycle` require a stable source id) so the emitter controls the id.
Never let a webhook-eligible event get a random id.

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
  -- signing secret, ALWAYS present (auto-generated 'whsec_…' if not supplied), returned ONCE
  -- on create/rotate, then write-only. Encrypted via internal/crypto/encrypt.go, which stores
  -- nonce‖ciphertext in a single bytea (do NOT model iv/tag as separate columns — D11).
  secret_enc    bytea NOT NULL,
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
  -- pending: scheduled, not yet attempted | delivering: claimed, in flight
  -- delivered: 2xx (terminal) | failed: RETRYABLE, carries a future next_attempt_at (due index)
  -- dead_letter: TERMINAL — permanent failure (4xx/SSRF) OR exhausted MAX_ATTEMPTS (never due)
  status        text NOT NULL DEFAULT 'pending',
  attempts      int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),  -- the timer (meaningful only for pending|failed)
  locked_by     text,
  locked_until  timestamptz,
  response_code int,
  error         text,                             -- <=400 chars
  last_attempt_at timestamptz,                     -- stamped on every send attempt
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

**Secret storage.** Encrypt with the existing core helper `internal/crypto/encrypt.go:43`
(it stores `nonce‖ciphertext` in one bytea — match it; do not reinvent iv/tag columns, D11).
The secret is **mandatory and auto-generated**: on create, if the caller supplies none, mint
`whsec_` + base64url(32 random bytes); return it **once** in the create response and never
again (reads return only `has_secret: true`). Rotation (`PATCH`) mints/accepts a new secret
and likewise returns it once. For HMAC, strip the `whsec_` prefix and base64-decode to key
bytes (Standard Webhooks convention). Master key: reuse whatever key `internal/crypto`
already uses; only add a dedicated `WEBHOOK_SECRET_KEY` if that helper isn't key-configurable
(confirm at implementation — O5).

## 5. Projection: lifecycle event → delivery rows

Projection has **two paths** (D3), because the two classes of event have different
durability and id properties. Both run the same core step — *map type → select matching
destinations → idempotent insert* — factored into one `projectDeliveries(tx, event)` helper:

```
1. Map the bare worker type ("stopped") → the public type ("sandbox.stopped").
2. SELECT enabled destinations for event.org_id where the event_types filter matches
   (empty = all; exact or 'prefix.*') AND (sandbox_id IS NULL OR sandbox_id = event.sandbox_id).
3. For each: INSERT INTO webhook_deliveries (... status='pending', next_attempt_at=now())
   ON CONFLICT (destination_id, event_id) DO NOTHING.   -- replay-safe, dedup across both paths
4. pg_notify('webhook_due', '') after commit to wake the dispatcher.
```

**Path A — CP-DB transitions (durable, v1).** For transitions that already happen inside a
DB transaction (the terminal-status write in `UpdateSandboxSessionStatus`, and the CP-side
gap emitters in §3), call `projectDeliveries` **in that same transaction**. The delivery row
is then as durable as the state change itself, with a deterministic `event_id` from the
source row — no Redis in the path. This covers the events users care most about
(`stopped`/`crash`, and the gap events we add CP-side).

**Path B — worker-published transitions (best-effort source).** `created`/`running`/`woke`/
`migrated` originate on the worker and reach the CP only via the lifecycle **Redis stream**.
A new control-plane consumer, **`webhook-projector`**, joins that stream as its **own
consumer group** (independent of the existing `cf-forwarder` consumer) and runs
`projectDeliveries` per message. **Reclaim of pending entries from crashed consumers uses
`XPENDING` + `XCLAIM`, NOT `XAUTOCLAIM`** — Azure Redis 6.0 (prod) does not support
`XAUTOCLAIM`, and `event_forwarder.go:171` already implements the `XPENDING`+`XCLAIM`
pattern to copy. Once `projectDeliveries` commits the row, delivery is at-least-once; before
that, Path B inherits the stream's guarantees (see §11 — the source is best-effort, with a
bounded loss window).

**Missing/blank tenancy (P2-d).** Both paths key destination selection on `event.org_id`. A
lifecycle envelope can arrive with a blank `org_id` if the worker's metadata resolver wasn't
wired (`redis_event_publisher.go:31`). The projector must: **skip** projection for an event
with no resolvable `org_id`/`sandbox_id`, **emit a metric + warn log** (don't crash the
consumer, don't ack-drop silently), and the resolver wiring must be **mandatory** for any
webhook-eligible event. Treat a malformed envelope as skip-with-metric, never a panic.

## 6. Delivery worker (the dispatcher)

A Go background loop in the control plane (mirror `billable_events_sender.go`'s structure:
ticker + `select{}` graceful stop), additionally woken by `LISTEN webhook_due` for latency.
Multiple CP instances run it safely via row locks.

Per pass:
1. **Claim** a small batch — and **only for enabled destinations** (a disabled destination is
   *paused*: its pending rows are not claimed and simply wait, P2-c):
   ```sql
   SELECT d.* FROM webhook_deliveries d
   JOIN webhook_destinations dst ON dst.id = d.destination_id AND dst.enabled
   WHERE d.status IN ('pending','failed') AND d.next_attempt_at <= now()
   ORDER BY d.next_attempt_at
   FOR UPDATE OF d SKIP LOCKED LIMIT 20;
   ```
   For each claimed row: `UPDATE … SET status='delivering', attempts=attempts+1,
   last_attempt_at=now(), locked_by=$me, locked_until=now()+interval '2 minutes'`.
2. Load the **live** destination + decrypt secret in-process (so a URL fix / secret rotation
   applies to in-flight retries — P2-c). **SSRF-validate + pin the URL** (§8).
3. **Sign** (§7) and POST: 10s connect / 15s read, **no redirects**, response body bounded
   (capture ≤64KB, store a ≤400-char snippet in `error`).
4. **Classify → record** (mirror `egress.ts:classifyStatus`), then clear `locked_by/until`:
   - `2xx` → `status='delivered'`, `delivered_at=now()` (terminal).
   - `429` → `status='failed'`, `next_attempt_at = now() + max(Retry-After, backoff(attempts))` (retryable).
   - `5xx` / timeout / network error → `status='failed'`, `next_attempt_at = now() + backoff(attempts)` (retryable).
   - `4xx` (non-429) / `3xx` / SSRF-block → `status='dead_letter'` **immediately** (permanent;
     **NOT `failed`**, so the due index never re-claims it — D9, P2-a).
   - On a *retryable* outcome where `attempts >= MAX_ATTEMPTS` → `status='dead_letter'` instead.

**Concurrency & self-expiry (P1-e).** The lock window (2 min) must exceed worst-case send
time, and a batch must not serialize past it. So **send the claimed batch concurrently
through a bounded worker pool** (≈8 in flight) rather than a sequential loop — total wall
time ≈ ceil(batch/pool)·15s ≪ 2 min for a batch of 20. (Equivalently: claim per-row. Do not
claim 50 and send sequentially with a 60s lock — later rows get reclaimed mid-flight.) The
reconciler (§9) reclaims a `delivering` row only after `locked_until` has passed.

**Backoff** (`backoff(attempts)`, mirror sessions-api): 10s, 30s, 60s, 5m, 15m (capped).
**`MAX_ATTEMPTS` / total window** is ours to set (D1) — proposed 12 attempts (~a few hours)
→ `dead_letter`; confirm in O2.

**Latency.** Billing polls every 5 min — far too slow here. Use a short base interval (~1s)
plus `LISTEN webhook_due` wake so a fresh event delivers in ~ms.

## 7. Signing (Standard Webhooks)

**Every delivery is signed** — there is no unsigned path, because the secret is mandatory and
auto-generated at create (D8, §4). The HMAC key is the destination secret with its `whsec_`
prefix stripped and base64-decoded.

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
`store.go`, types in `pkg/types/webhook.go`. Auth: `PGAPIKeyMiddleware`, **org-scoped via
`auth.GetOrgID` — a valid org key, no granular scopes** (scope enforcement doesn't exist in
`middleware.go`/`ValidateAPIKey` yet — D10, P2-b; revisit if/when it lands).

| Method · Path | Purpose |
|---|---|
| `POST /api/webhooks` | Register: `{ url, secret?, event_types?, sandbox_id?, enabled? }` → SSRF-validate. **Response includes the `secret` (the supplied one, or an auto-minted `whsec_…`) — the only time it's ever returned.** |
| `GET /api/webhooks` | List org destinations |
| `GET /api/webhooks/:id` | One destination (no secret; `has_secret: true`) |
| `PATCH /api/webhooks/:id` | Update url/event_types/sandbox_id/enabled; rotate secret. **If the secret is rotated, the new value is returned once.** |
| `DELETE /api/webhooks/:id` | Remove |
| `GET /api/webhooks/:id/deliveries?status=&after=&limit=` | Delivery history |
| `GET /api/webhooks/:id/deliveries/:deliveryId` | One delivery, detail |
| `POST /api/webhooks/:id/deliveries/:deliveryId/redeliver` | Re-enqueue **any** delivery (set `pending`, `next_attempt_at=now()`, clear lock; **preserve `attempts`**) |
| `POST /api/webhooks/:id/test` | Send a synthetic `sandbox.test` event to validate the endpoint+secret |

Destination response: `{ id, url, event_types, sandbox_id, enabled, has_secret, created_at,
updated_at }` — plus `secret` **only** in the create response and a secret-rotating patch.
Delivery response: `{ id, destination, event_id, event_type, status, attempts,
last_attempt_at, response_code, error, created_at, delivered_at }` (all backed by columns —
§4).

## 11. Reliability semantics (the contract we're promising)

- **At-least-once — *from the delivery row onward*.** Once a `webhook_deliveries` row exists
  it is durable and will be delivered or dead-lettered; retries can duplicate, so recipients
  dedupe on `webhook-id`. **Before** the row exists the guarantee depends on the projection
  path (P1-d): **Path A (CP-DB transitions) is fully durable** — the row is written in the
  same transaction as the state change. **Path B (worker→Redis events) is best-effort at the
  source** — the lifecycle stream uses approximate `MAXLEN` trimming and `PublishLifecycle`
  can return `false` after 3 failed `XADD`s (`publish.go:23`), so a worker event can be lost
  before projection under a Redis outage. The worker's per-sandbox SQLite + retrying publisher
  (`redis_event_publisher.go`) narrows this to a small window; document it as a known limit,
  and the most important events ride Path A. (Hardening Path B with a worker-side durable
  outbox is future work — O4.)
- **Idempotent projection.** `UNIQUE(destination_id, event_id)` — one delivery row per
  destination+event regardless of stream replay *or* an event appearing on both paths.
- **Ordering.** Per destination, claimed in `next_attempt_at` order; no cross-destination and
  no strict per-sandbox ordering (parallel, bounded-pool sends) — document it.
- **Source of truth** is the `webhook_deliveries` row.
- **State machine** (D9): `failed` is always retryable with a future `next_attempt_at`;
  `dead_letter` is terminal (permanent failure or exhausted attempts). `redeliver` is the
  escape hatch — works on any status, resets to `pending`, preserves `attempts`.
- **Destination mutations (P2-c).** Sends load the **live** destination, so a URL fix or
  secret rotation applies to already-pending deliveries (intended — lets a user repair a
  broken endpoint and replay). `enabled=false` **pauses**: pending rows are not claimed (the
  claim joins `dst.enabled`) and resume when re-enabled. Deleting a destination cascades its
  deliveries (`ON DELETE CASCADE`).

## 12. Implementation map (files)

| Area | New / changed |
|---|---|
| Migration | `internal/db/migrations/0NN_sandbox_webhooks.{up,down}.sql` |
| Store | `internal/db/store.go` — `CreateWebhookDestination`, `List/Get/Update/Delete`, delivery list/get, `ClaimDueDeliveries` (joins `dst.enabled`), `RecordDeliveryResult`, `ReclaimStaleDeliveries`, `projectDeliveries(tx, event)` (shared by both paths) |
| Types | `pkg/types/webhook.go` |
| API | `internal/api/webhooks.go` (handlers; secret returned once) + routes in `internal/api/router.go` — **no scopes** (D10) |
| Projector (Path B) | `internal/controlplane/webhook_projector.go` — new Redis consumer group; reclaim via **`XPENDING`+`XCLAIM`** copied from `event_forwarder.go:171` (not `XAUTOCLAIM`) |
| Projector (Path A) | call `projectDeliveries` in the same tx as the terminal write in `db/store.go:UpdateSandboxSessionStatus` and in the CP-side gap emitters |
| Dispatcher + reconciler | `internal/controlplane/webhook_dispatcher.go` (claim → bounded-pool concurrent send → classify; + stale-lock reclaim sweep) |
| Signing | `internal/webhook/sign.go` (Standard Webhooks) |
| SSRF | `internal/webhook/ssrf.go` (port of `ssrf.ts`) |
| Secret crypto | **reuse `internal/crypto/encrypt.go`** (`nonce‖ciphertext` bytea) + a `whsec_` generator; no bespoke columns (D11) |
| Deterministic-id helper | add `cellevents.PublishLifecycleWithID(id, …)` (or require a stable id) — `publish.go:30` uses `uuid.NewString()` today (P1-c) |
| Event emission gaps | emit `sandbox.checkpoint.created` / `sandbox.scaled` / `sandbox.preview_url.changed` / explicit `sandbox.forked` at their `api/sandbox.go` sites — prefer the **same-tx (Path A) insert** where a DB write exists; else `PublishLifecycleWithID` |
| Docs | `docs/sandboxes/webhooks.mdx` (mirror `docs/agent-sessions/webhooks.mdx`), incl. a verifier snippet |
| Wiring | start projector + dispatcher in `cmd/server/main.go`; ensure the worker metadata resolver (org/sandbox) is wired for webhook-eligible events (P2-d) |

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
- **O4 — RESOLVED into D3 (dual path).** CP-DB transitions project in-transaction (durable,
  v1); worker events via the Redis consumer. *Remaining* sub-question, deferred: hardening
  Path B with a worker-side durable outbox (vs. the documented best-effort source, §11).
- **O5 — secret key management.** Confirm `internal/crypto/encrypt.go` is key-configurable and
  reuse its master key; only add `WEBHOOK_SECRET_KEY` if it isn't.
- **O6 — crash signal.** Distinct `sandbox.crashed` type, or `sandbox.stopped` with
  `data.reason="crash"` (current internal shape)? Recommend the latter for fewer types.
- **O7 — prod DB rule.** Per `AGENTS.md`, prod DB mutations need approval and migrations are
  gated; the migration + any backfill must follow that process (this doc adds tables only,
  no backfill).
