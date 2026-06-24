# Sandbox lifecycle webhooks — implementation plan

Status: **design draft, rev 3 (second review folded in 2026-06-24), implementation not
started** (off `main` @ `6ed835c`). Branch: `feat/sandbox-webhooks`. This is a **complete
reference** — a future implementer should be able to work from this doc + the cited code
without the conversation that produced it.

- **Rev 2** resolved the plumbing blockers — signing-secret behavior, source durability (dual
  projection), Redis reclaim (XPENDING+XCLAIM), deterministic event IDs, the delivery state
  machine — plus scopes, mutation semantics, missing tenancy, schema cleanup.
- **Rev 3** settles the **shared webhook contract** the second review asked for (§2a): envelope
  casing, `webhook-id` meaning, generated secrets, metadata in the body, a creation watermark,
  idempotent destination creation, soft-delete; plus per-path event-id ownership (no
  cross-path double-delivery), a split retry budget, and taxonomy naming.

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

## 2a. Shared webhook contract (both products)

These are the choices a user bakes into a webhook handler, so they must be **the same across
sandbox webhooks (this doc) and session webhooks (sessions-api)** and not change later. Core
adopts the stronger form; where sessions-api differs today, a follow-up brings it in line.

| Aspect | The contract (core, the new standard) | sessions-api today | Action |
|---|---|---|---|
| **Envelope casing** | body is **camelCase** (`type`, `sandboxId`/`sessionId`, `eventId`, `metadata`, `event{…}`); the REST *management* API stays snake_case | camelCase already (`sessionId`, `eventId`) | core match; consistent |
| **`webhook-id` meaning** | = **`delivery.id`** (the message; stable across retries *and* manual redelivery of that delivery); `eventId` lives in the body | uses `event_id` | **sessions-api follow-up**: switch to delivery id |
| **Signing** | every delivery signed; secret **auto-generated** (`whsec_…`) if none supplied, returned **once**; no unsigned path | unsigned allowed when no secret | **sessions-api follow-up** |
| **Secret echo** | return the secret **only when we generated it**; never echo a caller-supplied one | n/a | core decides |
| **Metadata** | sandbox/session `metadata` included **top-level in the body** (capped) so receivers route without a lookup | included | core match |
| **Creation watermark** | a destination only receives events **after** it was created (no historical backfill) | `created_after_seq` | core uses `created_after` timestamp |
| **Idempotent creation** | `POST` is get-or-create by optional unique `name` per org, and honors an `Idempotency-Key` header | idempotency-key on session create | core adds both |
| **Deletion** | **soft-delete** (tombstone); delivery history retained; `enabled=false` = pause | hard delete | core improves; sessions-api follow-up optional |

The sessions-api follow-ups (delivery-id `webhook-id`, mandatory generated secrets, soft-delete)
are **out of scope for this branch** but should be filed so the two products converge.

## 3. Event taxonomy (the public surface)

Each delivered event is one sandbox lifecycle moment. **Several already emit on the Redis
stream; several do not yet and must be added — the largest non-plumbing line item.**

**Each type is owned by exactly one projection path (P1-a).** A Path-A type is projected
in-transaction (§5) and the Redis projector **ignores** it even though it may also appear on
the stream (e.g. `stopped` still streams for billing); a Path-B type is projected only from
the stream. This — not the unique index alone — is what prevents cross-path double-delivery.
Names are chosen so semantics are crisp (P2-g): `created` = resource accepted; `ready` = VM
booted and usable for exec; `resumed` (not "woke") pairs with `hibernated`.

| Public type | Owner | Emits today? | Source site | Notes |
|---|---|---|---|---|
| `sandbox.created` | B | ✅ (`"created"`) | worker create → `redis_event_publisher.go` | resource accepted; memory/cpu/template |
| `sandbox.ready` | B | ✅ (`"running"`) | worker, post-boot | VM usable for exec (renamed from `running`) |
| `sandbox.hibernated` | B | ✅ (`"hibernated"`) | worker + `OnSandboxHibernate` | |
| `sandbox.resumed` | B | ✅ (`"woke"`) | worker + `OnSandboxWake` | renamed from `woke` |
| `sandbox.migrated` | B | ✅ (`"migrated"`) | worker migrate | |
| `sandbox.stopped` | A | ✅ (`"stopped"`) | `db/store.go:UpdateSandboxSessionStatus` (project in-tx) | `data.reason` incl. `user_requested`, `expired`, `crash` (P2-g/O6: no separate `crashed` type) |
| `sandbox.checkpoint.created` | A | ❌ **gap** | `api/sandbox.go:createCheckpoint` | net-new emit |
| `sandbox.forked` | A | ⚠️ partial | `api/sandbox.go:forkSandbox` | child also emits `created`; this carries `data.parent_id` |
| `sandbox.scaled` | A | ❌ **gap** | `api/sandbox.go:setSandboxResourceLimits` + `OnSandboxScale` | net-new emit |
| `sandbox.preview_url.changed` | A | ❌ **gap** | `api/sandbox.go:updateSandboxPort` | net-new emit |

Path-B types are exactly the set the projector handles; everything else is Path A. Confirm at
implementation that each Path-A type genuinely has a DB-write site to hook (else move it to B
with a deterministic id via `PublishLifecycleWithID`).

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

**Envelope** (the JSON body POSTed — **camelCase**, §2a). Top-level `metadata` is the
sandbox's user-set metadata so a receiver can route without a second lookup (P2-b). The wire
`webhook-id` header is the **`deliveryId`** (the message), while **`eventId`** identifies the
underlying lifecycle event for app correlation (§7):
```json
{
  "type": "sandbox.stopped",
  "sandboxId": "sb-xxxxxxxx",
  "eventId": "sb-xxxxxxxx:3:142",
  "deliveryId": "whd_…",
  "metadata": { "...": "the sandbox's metadata (capped)" },
  "event": {
    "id": "sb-xxxxxxxx:3:142",
    "ts": "2026-06-24T12:00:00Z",
    "orgId": "<uuid>",
    "sandboxId": "sb-xxxxxxxx",
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
  name          text,                             -- optional; get-or-create idempotency key (P2-c)
  url           text NOT NULL,                    -- https only; SSRF-validated at write + send
  event_types   text[] NOT NULL DEFAULT '{}',     -- empty = all; exact ('sandbox.stopped') or prefix ('sandbox.*')
  sandbox_id    text,                             -- optional: scope to one sandbox (NULL = all org sandboxes)
  -- signing secret, ALWAYS present (auto-generated 'whsec_…' if not supplied), returned ONCE
  -- on create/rotate, then write-only. Encrypted via internal/crypto/encrypt.go, which stores
  -- nonce‖ciphertext in a single bytea (do NOT model iv/tag as separate columns — D11).
  secret_enc    bytea NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,    -- false = paused (pending rows not claimed)
  created_after timestamptz NOT NULL DEFAULT now(),  -- watermark: only events with ts > this (P1-d; no backfill)
  deleted_at    timestamptz,                      -- soft-delete tombstone (P2-f); history retained
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX  webhook_dest_org_idx  ON webhook_destinations(org_id) WHERE enabled AND deleted_at IS NULL;
CREATE UNIQUE INDEX webhook_dest_name_uq ON webhook_destinations(org_id, name) WHERE name IS NOT NULL AND deleted_at IS NULL;

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
  attempts      int  NOT NULL DEFAULT 0,           -- lifetime total (audit; never reset)
  retry_count   int  NOT NULL DEFAULT 0,           -- retry BUDGET vs MAX_ATTEMPTS; reset to 0 on manual redeliver
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
2. SELECT live destinations for event.org_id WHERE enabled AND deleted_at IS NULL
   AND event.ts > created_after                              -- creation watermark (P1-d)
   AND event_types-filter matches (empty = all; exact or 'prefix.*')
   AND (sandbox_id IS NULL OR sandbox_id = event.sandbox_id).
3. Render the camelCase envelope (incl. top-level metadata from sandbox_sessions.metadata),
   then for each destination: INSERT INTO webhook_deliveries (..., payload, status='pending',
   next_attempt_at=now()) ON CONFLICT (destination_id, event_id) DO NOTHING.  -- replay-safe
4. pg_notify('webhook_due', '') after commit to wake the dispatcher.
```

**Path A — CP-DB transitions (durable, v1).** For transitions that already happen inside a
DB transaction (the terminal-status write in `UpdateSandboxSessionStatus`, and the CP-side
gap emitters in §3), call `projectDeliveries` **in that same transaction**. The delivery row
is then as durable as the state change itself, with a deterministic `event_id` from the
source row — no Redis in the path. This covers the events users care most about
(`stopped`/`crash`, and the gap events we add CP-side).

**Path B — worker-published transitions (best-effort source).** `created`/`ready`/
`hibernated`/`resumed`/`migrated` originate on the worker and reach the CP only via the
lifecycle **Redis stream**. A new control-plane consumer, **`webhook-projector`**, joins that
stream as its **own consumer group** (independent of the existing `cf-forwarder` consumer) and
runs `projectDeliveries` **only for Path-B-owned types** — it **ignores Path-A types it sees on
the stream** (e.g. `stopped` still streams for billing but is webhook-projected in-tx by Path
A), so the two paths never both create a row for the same logical event (P1-a). **Reclaim of
pending entries from crashed consumers uses
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
   JOIN webhook_destinations dst ON dst.id = d.destination_id AND dst.enabled AND dst.deleted_at IS NULL
   WHERE d.status IN ('pending','failed') AND d.next_attempt_at <= now()
   ORDER BY d.next_attempt_at
   FOR UPDATE OF d SKIP LOCKED LIMIT 20;
   ```
   For each claimed row: `UPDATE … SET status='delivering', attempts=attempts+1,
   retry_count=retry_count+1, last_attempt_at=now(), locked_by=$me,
   locked_until=now()+interval '2 minutes'`.
2. Load the **live** destination + decrypt secret in-process (so a URL fix / secret rotation
   applies to in-flight retries — P2-c). **SSRF-validate + pin the URL** (§8).
3. **Sign** (§7) and POST: 10s connect / 15s read, **no redirects**, response body bounded
   (capture ≤64KB, store a ≤400-char snippet in `error`).
4. **Classify → record** (mirror `egress.ts:classifyStatus`), then clear `locked_by/until`:
   - `2xx` → `status='delivered'`, `delivered_at=now()` (terminal).
   - `429` → `status='failed'`, `next_attempt_at = now() + max(Retry-After, backoff(retry_count))` (retryable).
   - `5xx` / timeout / network error → `status='failed'`, `next_attempt_at = now() + backoff(retry_count)` (retryable).
   - `4xx` (non-429) / `3xx` / SSRF-block → `status='dead_letter'` **immediately** (permanent;
     **NOT `failed`**, so the due index never re-claims it — D9, P2-a).
   - On a *retryable* outcome where `retry_count >= MAX_ATTEMPTS` → `status='dead_letter'` instead.
     (Budget is `retry_count`, which a manual redeliver resets — so a redelivered exhausted row
     gets a fresh budget; lifetime `attempts` keeps counting for audit — P1-c.)

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

Same Standard Webhooks scheme as sessions-api (`egress.ts:signStandardWebhook`), with **one
deliberate improvement (P1-b): `webhook-id` is the `deliveryId`, not the event id.** A webhook
*message* is a (destination, event) delivery, not an event — two destinations matching one
event, or the same endpoint registered twice, are distinct messages and must not collapse at
the receiver. `deliveryId` is stable across automatic retries *and* manual redelivery (the row
id never changes), exactly what Standard Webhooks wants `webhook-id` to mean; the underlying
event is `eventId` in the body for app correlation. (sessions-api uses the event id today —
the §2a follow-up.)

Headers on every POST:
- `webhook-id`: the **`deliveryId`** (recipients dedupe on this; constant across retries/redeliver).
- `webhook-timestamp`: unix seconds (replay guard, ±5 min).
- `webhook-signature`: `v1,<base64(HMAC-SHA256(secretBytes, "{deliveryId}.{ts}.{rawBody}"))>`.
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
| `POST /api/webhooks` | Register: `{ url, name?, secret?, event_types?, sandbox_id?, enabled? }` → SSRF-validate. **Idempotent (P2-c):** get-or-create by `name` (unique per org) and honors an `Idempotency-Key` header, so a timed-out retry returns the same destination instead of a duplicate. **Secret echo (P2-d):** return `secret` **only when we generated it** (caller supplied none); if the caller supplied one, don't echo it (`has_secret: true`). |
| `GET /api/webhooks` | List org destinations (excludes soft-deleted) |
| `GET /api/webhooks/:id` | One destination (no secret; `has_secret: true`) |
| `PATCH /api/webhooks/:id` | Update url/event_types/sandbox_id/enabled; rotate secret. A **generated** rotation returns the new value once; a caller-supplied one is not echoed. |
| `DELETE /api/webhooks/:id` | **Soft-delete** (P2-f): set `deleted_at`, disable; the destination drops out of `GET`, but its delivery history is retained. |
| `GET /api/webhooks/:id/deliveries?status=&cursor=&limit=` | Delivery history (paginated, see below) |
| `GET /api/webhooks/:id/deliveries/:deliveryId` | One delivery, detail |
| `POST /api/webhooks/:id/deliveries/:deliveryId/redeliver` | Re-enqueue **any** delivery: `status='pending'`, `next_attempt_at=now()`, clear lock, **reset `retry_count=0`** (fresh budget) while **preserving lifetime `attempts`** (P1-c). |
| `POST /api/webhooks/:id/test` | Send a synthetic `sandbox.test` event to validate the endpoint+secret |

**Pagination (P3).** List endpoints return `{ data, next_cursor, has_more }`; `cursor` is an
**opaque stable cursor** (encodes `(created_at, id)`), not a bare timestamp. `next_cursor` is
`null` when `has_more` is false.

Destination response: `{ id, name, url, event_types, sandbox_id, enabled, has_secret,
created_at, updated_at }` — plus `secret` **only** when freshly generated (create, or a
generated rotation). Delivery response: `{ id, destination, event_id, event_type, status,
attempts, retry_count, last_attempt_at, response_code, error, created_at, updated_at,
delivered_at }` (all backed by columns — §4; `updated_at` included per P3).

## 11. Reliability semantics (the contract we're promising)

- **At-least-once — *from the delivery row onward*.** Once a `webhook_deliveries` row exists
  it is durable and will be delivered or dead-lettered; retries can duplicate, so recipients
  dedupe on `webhook-id` (= `deliveryId`, §7) — **per-delivery**, so distinct destinations
  matching one event are correctly distinct messages (P1-b). **Before** the row exists the
  guarantee depends on the projection
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
  `dead_letter` is terminal (permanent failure or exhausted **`retry_count`**). `redeliver`
  resets `retry_count` (fresh budget) and re-enqueues, preserving lifetime `attempts` (P1-c).
- **Creation watermark (P1-d).** A destination only receives events with `ts > created_after`;
  there is **no historical backfill** (a stream replay/backlog cannot fire old events at a
  newly created destination).
- **Destination mutations (P2-c).** Sends load the **live** destination, so a URL fix or
  secret rotation applies to already-pending deliveries (intended — lets a user repair a
  broken endpoint and replay). `enabled=false` **pauses** (pending rows not claimed; resume on
  re-enable). **Delete is soft (P2-f):** `deleted_at` tombstones the destination and hides it
  from `GET`, but delivery history is **retained** for audit/support; deliveries for a deleted
  destination are no longer claimed (the claim joins `deleted_at IS NULL`).

## 12. Implementation map (files)

| Area | New / changed |
|---|---|
| Migration | `internal/db/migrations/0NN_sandbox_webhooks.{up,down}.sql` |
| Store | `internal/db/store.go` — `CreateWebhookDestination` (get-or-create by `name`/`Idempotency-Key`), `List`(excl. soft-deleted)`/Get/Update/SoftDelete`, delivery list (cursor-paginated)/get, `ClaimDueDeliveries` (joins `dst.enabled AND deleted_at IS NULL`), `RecordDeliveryResult`, `RedeliverDelivery` (reset `retry_count`), `ReclaimStaleDeliveries`, `projectDeliveries(tx, event)` (watermark + metadata; Path-A in-tx, Path-B from stream) |
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
- **O3 — RESOLVED (rev 3, P2-g).** `created` (resource accepted) and `ready` (VM usable for
  exec) are distinct with crisp semantics; `running` is renamed `ready`, `woke`→`resumed`.
- **O4 — RESOLVED into D3 (dual path).** CP-DB transitions project in-transaction (durable,
  v1); worker events via the Redis consumer. *Remaining* sub-question, deferred: hardening
  Path B with a worker-side durable outbox (vs. the documented best-effort source, §11).
- **O5 — secret key management.** Confirm `internal/crypto/encrypt.go` is key-configurable and
  reuse its master key; only add `WEBHOOK_SECRET_KEY` if it isn't.
- **O6 — RESOLVED (rev 3, P2-g).** No separate `crashed` type; `sandbox.stopped` carries
  `data.reason` (`user_requested` | `expired` | `crash`).
- **O7 — prod DB rule.** Per `AGENTS.md`, prod DB mutations need approval and migrations are
  gated; the migration + any backfill must follow that process (this doc adds tables only,
  no backfill).
- **O8 — sessions-api convergence (file as follow-ups, §2a).** Bring sessions-api in line with
  the shared contract: `webhook-id` = delivery id, mandatory generated secrets (no unsigned
  path), and optionally soft-delete. Out of scope for this branch; track so the two products
  don't drift.
