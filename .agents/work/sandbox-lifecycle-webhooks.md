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
- **Rev 4** closes the third review's user-facing gaps: **subscribe-at-create** (inline webhooks
  on `POST /api/sandboxes`, so a per-sandbox integrator catches `created`/`ready`); **exact
  idempotency** (`name` conflict→409 + an `Idempotency-Key` table); **verifier compatibility**
  (base64 secret, SDK/docs convergence); **deletion cancels** non-terminal deliveries (new
  `canceled` terminal status); a **skew-free watermark** (Redis stream id, not producer ts);
  `hibernated`/`resumed` moved to the durable path; `/test` + redelivery semantics; P3 leftovers.
- **Rev 5** makes **one canonical public JSON contract** (new §2b) and forces the design doc,
  docs, API reference, and SDK to use it verbatim — the whole wire is **camelCase** (matching
  core: `templateID`/`sandboxID`), DB columns stay snake_case. Plus: idempotent replay returns
  the original response incl. the one-time secret; `sandboxId` scope is **immutable**; secret
  rotation is `rotateSecret: true`; redeliver returns the delivery; event `data` is camelCase;
  at-least-once is scoped to "once accepted."

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
| **Wire casing** | the **whole** wire JSON is **camelCase** — envelope *and* management request/response (`eventTypes`, `sandboxId`, `hasSecret`, `retryCount`, …), matching core (`templateID`/`sandboxID`). DB columns stay snake_case; the API maps. See §2b. | camelCase already (`sessionId`, `eventId`) | core match; consistent |
| **`webhook-id` meaning** | = **`delivery.id`** (the message; stable across retries *and* manual redelivery); `eventId` lives in the body | uses `event_id` | **sessions-api follow-up** + **SDK/docs**: switch to delivery id and update the `WebhookDelivery` type + verifier comment (until then the two products differ — "one verifier" is true only *after* this lands, P2-c) |
| **Signing** | every delivery signed; secret **auto-generated** (`whsec_…`) if none supplied, returned **once**; no unsigned path | unsigned allowed when no secret | **sessions-api follow-up** |
| **Secret echo** | return the secret **only when we generated it**; never echo a caller-supplied one | n/a | core decides |
| **Metadata** | sandbox/session `metadata` included **top-level in the body** (capped) so receivers route without a lookup | included | core match |
| **Creation watermark** | a destination only receives events **after** it was created (no historical backfill) | `created_after_seq` | core uses a **Redis stream-id** watermark (skew-free, P2-a), not a producer timestamp |
| **Idempotent creation** | get-or-create by optional unique `name` (same config → existing; **different config → 409**) **and** an `Idempotency-Key` header (stored + fingerprinted) | idempotency-key on session create | core adds both, with explicit conflict semantics (P1-b) |
| **Subscribe at create** | inline `webhooks` on `POST /api/sandboxes` so a per-sandbox integrator catches `created`/`ready` (which fire before they'd know the id) | `webhook` on session create | core adds it (P1-a) |
| **Deletion** | **soft-delete** (tombstone); delivery history retained; `enabled=false` = pause | hard delete | core improves; sessions-api follow-up optional |

The sessions-api follow-ups (delivery-id `webhook-id`, mandatory generated secrets, soft-delete)
are **out of scope for this branch** but should be filed so the two products converge.

## 2b. The canonical public JSON contract

**This is the single source of truth for the wire JSON** — request bodies, responses, and the
delivered envelope. It is **camelCase**, matching the rest of the OpenComputer API. **DB
columns are snake_case (§4); the API layer maps between them.** The design doc, user docs, API
reference, SDK types, and every example MUST use these field names verbatim. (sessions-api is
snake_case on its wire — a separate, pre-existing product; the SDKs present camelCase for both.)

```
Destination (response)
  { id, name, url, eventTypes, sandboxId, enabled, hasSecret, createdAt, updatedAt }
  + secret   ← present ONCE, only on create or a generated rotation

Create request   { url, name?, secret?, eventTypes?, sandboxId?, enabled? }   + Idempotency-Key header
Update request   { url?, eventTypes? (null = clear), enabled?, secret?, rotateSecret? }
                 — sandboxId (scope) is IMMUTABLE; not accepted here

Delivery (record)
  { id, destination, eventId, eventType, status, attempts, retryCount,
    lastAttemptAt, responseCode?, error?, createdAt, updatedAt, deliveredAt? }
Delivery list    { data, nextCursor, hasMore }
Test result      { delivered, responseCode?, error? }

Envelope (delivered body; webhook-id header == deliveryId)
  { type, sandboxId, eventId, deliveryId, metadata,
    event: { id, ts, orgId, sandboxId, type, data } }

Event `data` is camelCase too:
  sandbox.stopped → { reason }   sandbox.forked → { parentId }
  sandbox.scaled  → { cpuCount, memoryMB }   sandbox.preview_url.changed → { port, url }
```

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
| `sandbox.hibernated` | A | ✅ (`"hibernated"`) | `api/sandbox.go:hibernateSandbox` (DB status write) + `OnSandboxHibernate` | core lifecycle signal → durable path (P2-b) |
| `sandbox.resumed` | A | ✅ (`"woke"`) | `api/sandbox.go:wakeSandbox` (DB status write) + `OnSandboxWake` | renamed from `woke`; durable path (P2-b) |
| `sandbox.migrated` | B | ✅ (`"migrated"`) | worker migrate | |
| `sandbox.stopped` | A | ✅ (`"stopped"`) | `db/store.go:UpdateSandboxSessionStatus` (project in-tx) | `data.reason` incl. `user_requested`, `expired`, `crash` (P2-g/O6: no separate `crashed` type) |
| `sandbox.checkpoint.created` | A | ❌ **gap** | `api/sandbox.go:createCheckpoint` | net-new emit |
| `sandbox.forked` | A | ⚠️ partial | `api/sandbox.go:forkSandbox` | child also emits `created`; this carries `data.parentId` |
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
  created_after_stream_id text,                    -- Path-B watermark = Redis stream id at creation
                                                   -- (skew-free, P2-a). NULL = no floor (inline-on-create / pinned sandbox)
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
  -- canceled: TERMINAL — destination soft-deleted while non-terminal (error='destination_deleted'); never due (P1-d)
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

-- Idempotency-Key storage for POST /api/webhooks (P1-b). Same (org,key) + same request → replay
-- the stored ORIGINAL RESPONSE (incl. the one-time generated secret) so a client that lost the
-- first response still gets the secret it needs to verify; same key + different request → 409.
-- response_enc holds the rendered create response, encrypted (it carries the plaintext secret);
-- it (and the replayability of the secret) expires with the row at the TTL (~24h). Prune past TTL.
CREATE TABLE webhook_idempotency_keys (
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  key           text NOT NULL,                    -- caller's Idempotency-Key header
  request_hash  text NOT NULL,                    -- fingerprint of the create body (url+eventTypes+sandboxId+name)
  destination_id text NOT NULL REFERENCES webhook_destinations(id) ON DELETE CASCADE,
  response_enc  bytea NOT NULL,                    -- the original create response (incl. secret), encrypted
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, key)
);
```

**Secret storage.** Encrypt with the existing core helper `internal/crypto/encrypt.go:43`
(it stores `nonce‖ciphertext` in one bytea — match it; do not reinvent iv/tag columns, D11).
The secret is **mandatory and auto-generated**: on create, if the caller supplies none, mint
`whsec_` + **standard base64**(32 random bytes) — **not base64url** (P1-c): the shipped TS
verifier decodes with `atob`, which doesn't reliably accept base64url, and Standard Webhooks
secrets are base64. Return it **once** in the create response and never again (reads return
only `has_secret: true`). Rotation (`PATCH`) mints/accepts a new secret and likewise returns
it once. For HMAC, strip the `whsec_` prefix and base64-decode to key bytes. Master key: reuse whatever key `internal/crypto`
already uses; only add a dedicated `WEBHOOK_SECRET_KEY` if that helper isn't key-configurable
(confirm at implementation — O5).

## 5. Projection: lifecycle event → delivery rows

Projection has **two paths** (D3), because the two classes of event have different
durability and id properties. Both run the same core step — *map type → select matching
destinations → idempotent insert* — factored into one `projectDeliveries(tx, event)` helper:

```
1. Map the bare worker type ("stopped") → the public type ("sandbox.stopped").
2. SELECT live destinations for event.org_id WHERE enabled AND deleted_at IS NULL
   AND event_types-filter matches (empty = all; exact or 'prefix.*')
   AND (sandbox_id IS NULL OR sandbox_id = event.sandbox_id)
   -- watermark (P1-d/P2-a), Path B ONLY: compare Redis STREAM IDs (skew-free), not timestamps:
   AND (created_after_stream_id IS NULL OR event.stream_id > created_after_stream_id).
   -- Path A events are written in the same tx as the state change, so they are inherently
   -- "after" any already-created destination — no watermark term needed.
3. Render the camelCase envelope (incl. top-level metadata from sandbox_sessions.metadata),
   then for each destination: INSERT INTO webhook_deliveries (..., payload, status='pending',
   next_attempt_at=now()) ON CONFLICT (destination_id, event_id) DO NOTHING.  -- replay-safe
4. pg_notify('webhook_due', '') after commit to wake the dispatcher.
```

**Path A — CP-DB transitions (durable, v1).** For transitions that happen inside a DB
transaction — the terminal-status write in `UpdateSandboxSessionStatus` (`stopped`), the
hibernate/wake status writes (`hibernated`/`resumed`, P2-b), and the CP-side gap emitters in
§3 — call `projectDeliveries` **in that same transaction**. The delivery row is then as durable
as the state change itself, with a deterministic `event_id` from the source row — no Redis in
the path. This covers the events users care most about (the core lifecycle transitions plus
the gap events we add CP-side). Confirm at implementation that hibernate/wake have a single
DB-write site to hook; if not, move them to Path B with `PublishLifecycleWithID`.

**Path B — worker-published transitions (best-effort source).** `created`/`ready`/`migrated`
originate on the worker and reach the CP only via the
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

**Backoff** (`backoff(retry_count)`, mirror sessions-api): 10s, 30s, 60s, 5m, 15m (capped).
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
- **Alert only:** count rows `status IN ('pending','failed','delivering')` with `updated_at <
  now()-1h` → emit an alert metric (no write). Terminal rows (`delivered`/`dead_letter`/
  `canceled`) are excluded, so a soft-deleted destination's canceled rows never read as stuck
  (P1-d).

## 10. Public API

Echo handlers in `internal/api/webhooks.go`, wired in `router.go`, store methods in
`store.go`, types in `pkg/types/webhook.go`. Auth: `PGAPIKeyMiddleware`, **org-scoped via
`auth.GetOrgID` — a valid org key, no granular scopes** (scope enforcement doesn't exist in
`middleware.go`/`ValidateAPIKey` yet — D10, P2-b; revisit if/when it lands).

| Method · Path | Purpose |
|---|---|
| `POST /api/webhooks` | Register a standalone destination: `{ url, name?, secret?, eventTypes?, sandboxId?, enabled? }` → SSRF-validate. Idempotency + secret-echo below. |
| `GET /api/webhooks` | List org destinations (excludes soft-deleted) |
| `GET /api/webhooks/:id` | One destination (no secret; `has_secret: true`) |
| `PATCH /api/webhooks/:id` | Update `url`/`eventTypes`/`enabled`; set a caller-supplied `secret`, or `rotateSecret: true` to mint a new one (returned once). **`sandboxId` (scope) is immutable** — not accepted here. A generated rotation returns the new value once; a caller-supplied one is not echoed. |
| `DELETE /api/webhooks/:id` | **Soft-delete** (P2-f): set `deleted_at`, disable, and **cancel non-terminal deliveries** for it (`status='canceled'`, `error='destination_deleted'` — P1-d). History is retained; the destination drops out of `GET`. |
| `GET /api/webhooks/:id/deliveries?status=&cursor=&limit=` | Delivery history (paginated, see below) |
| `GET /api/webhooks/:id/deliveries/:deliveryId` | One delivery, detail |
| `POST /api/webhooks/:id/deliveries/:deliveryId/redeliver` | Re-enqueue **any** delivery: `status='pending'`, `next_attempt_at=now()`, clear lock, **reset `retry_count=0`** (fresh budget), **preserve lifetime `attempts`** (P1-c). **Same `webhook-id` (= delivery id)** — so a receiver that dedupes will treat it as the *same* message; redelivery means "send this delivery again," for when the original never landed, not "emit a new logical event" (P2-e). **Returns the re-enqueued delivery record.** |
| `POST /api/webhooks/:id/test` | **Synchronous** connectivity check: signs + POSTs a synthetic `sandbox.test` event to the URL and returns the HTTP status inline. It **bypasses `event_types`**, does **not** create a delivery row, does **not** appear in history, and is **not** retried/dead-lettered (P2-d). |

**Subscribe at create (P1-a).** A per-sandbox integrator usually doesn't know `sandbox_id`
until `POST /api/sandboxes` returns — by then `sandbox.created`/`sandbox.ready` have already
fired. So **`POST /api/sandboxes` accepts inline `webhooks: [{ url, secret?, event_types? }]`**
(mirrors sessions-api's `webhook` on session create): each is registered atomically with the
sandbox, pinned to its `sandbox_id`, with `created_after_stream_id = NULL` (no floor → it
receives that sandbox's full lifecycle from `created` on). Alternative for fleet-wide use:
an **org-wide** destination (no `sandbox_id`) + route on the body's `sandboxId`/`metadata`.
(Public sandbox-ID preallocation was considered and rejected — more surface, no extra benefit.)

**Idempotent create (P1-b).** Two mechanisms, explicit conflict semantics:
- **`name`** (unique per org): `POST` with an existing `name` whose incoming config (url +
  eventTypes + sandboxId) **matches** → `200` with the existing destination; config
  **differs** → **`409 Conflict`** (never silently reuse or overwrite). NB: a `name`-only
  match returns the destination *without* the secret (it's write-only) — so a client that
  needs guaranteed secret recovery should use an `Idempotency-Key` (below) or supply its own.
- **`Idempotency-Key` header**: the **original create response is stored encrypted**
  (`webhook_idempotency_keys.response_enc`, §4) with a request fingerprint. Same key + same
  fingerprint → **replay that exact response, including the one-time generated `secret`** (so a
  client that lost the first response still gets it); same key + **different** fingerprint →
  **`409`**. Both the stored response and the secret-replay expire with the row at a ~24h TTL.

**Secret echo (P2-d).** Return `secret` **only when we generated it** (caller supplied none),
on create or a generated rotation; never echo a caller-supplied secret (`has_secret: true`).

**Pagination (P3).** List endpoints return `{ data, next_cursor, has_more }`; `cursor` is an
**opaque stable cursor** (encodes `(created_at, id)`), not a bare timestamp. `next_cursor` is
`null` when `has_more` is false.

Destination response: `{ id, name, url, eventTypes, sandboxId, enabled, hasSecret, createdAt,
updatedAt }` — plus `secret` **only** when freshly generated (create, or a generated rotation).
Delivery response: `{ id, destination, eventId, eventType, status, attempts, retryCount,
lastAttemptAt, responseCode, error, createdAt, updatedAt, deliveredAt }`. List responses:
`{ data, nextCursor, hasMore }`. (camelCase wire per §2b; backed by snake_case columns in §4.)

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
  `dead_letter` (permanent failure or exhausted `retry_count`) and `canceled` (destination
  deleted) are terminal. `redeliver` resets `retry_count` (fresh budget) and re-enqueues,
  preserving lifetime `attempts` (P1-c); it re-sends the **same** delivery (same `webhook-id`),
  so a deduping receiver treats it as a duplicate (P2-e, §10).
- **Creation watermark (P1-d/P2-a).** A destination only receives events produced **after** it
  was created — enforced on Path B by **Redis stream id** (`event.stream_id >
  created_after_stream_id`), which is skew-free, *not* a producer/DB timestamp. Path A events
  are inherently after (same-tx). No historical backfill. An inline-on-create destination
  (`created_after_stream_id = NULL`) gets its sandbox's full lifecycle from `created`.
- **Destination mutations (P2-c).** Sends load the **live** destination, so a URL fix or
  secret rotation applies to already-pending deliveries (intended — lets a user repair a
  broken endpoint and replay). `enabled=false` **pauses** (pending rows not claimed; resume on
  re-enable). **Delete is soft (P2-f):** `deleted_at` tombstones the destination, hides it from
  `GET`, retains history, and **transitions its non-terminal deliveries to `canceled`** (P1-d)
  so nothing lingers as "stuck"; the claim also joins `deleted_at IS NULL`.

## 12. Implementation map (files)

| Area | New / changed |
|---|---|
| Migration | `internal/db/migrations/0NN_sandbox_webhooks.{up,down}.sql` (destinations, deliveries, `webhook_idempotency_keys`) |
| Store | `internal/db/store.go` — `CreateWebhookDestination` (get-or-create by `name`→409 on config mismatch; `Idempotency-Key` via `webhook_idempotency_keys`), `List`(excl. soft-deleted)`/Get/Update/SoftDelete` (cancels non-terminal deliveries), delivery list (cursor-paginated)/get, `ClaimDueDeliveries` (joins `dst.enabled AND deleted_at IS NULL`), `RecordDeliveryResult`, `RedeliverDelivery` (reset `retry_count`), `ReclaimStaleDeliveries`, `projectDeliveries(tx, event)` (stream-id watermark + metadata; Path-A in-tx, Path-B from stream) |
| Inline-on-create | `internal/api/sandbox.go:createSandbox` accepts `webhooks: [...]` and registers them atomically (pinned `sandbox_id`, `created_after_stream_id=NULL`) — P1-a |
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
| Docs | `docs/sandboxes/webhooks.mdx` (mirror `docs/agent-sessions/webhooks.mdx`), incl. a base64 verifier snippet |
| SDK/docs convergence (P2-c) | `sdks/typescript/src/agents/webhooks.ts` — add `deliveryId` to `WebhookDelivery`, update the verifier comment (`webhook-id` = delivery id); update session webhook docs. Until sessions-api also moves (O8), the products differ on `webhook-id` — version it, don't claim "one verifier" yet |
| Wiring | start projector + dispatcher in `cmd/server/main.go`; ensure the worker metadata resolver (org/sandbox) is wired for webhook-eligible events (P2-d) |

## 13. Phasing

- **P1 — subscribe + send (happy path).** Migrations (destinations, deliveries, idempotency),
  CRUD API + **inline `webhooks` on sandbox create** (P1-a), encrypted secret, dual-path
  projection for the events that emit today, dispatcher with signing + SSRF + classify.
  Delivers value for `created/ready/hibernated/resumed/stopped/migrated`.
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
- **O8 — sessions-api + SDK/docs convergence (file as follow-ups, §2a / P2-c).** Bring
  sessions-api in line with the shared contract: `webhook-id` = delivery id, mandatory
  generated secrets (no unsigned path), optionally soft-delete; **and** update the TS SDK
  (`webhooks.ts`: add `deliveryId` to `WebhookDelivery`, fix the verifier comment) + session
  webhook docs. Until this lands the two products differ on `webhook-id`, so the "one verifier"
  claim is versioned, not yet true. Out of scope for this branch; track so they don't drift.
- **★O9 — confirm the Path-B lifecycle-event transport per environment (blocks Path B).** §5
  Path B consumes the **Redis** lifecycle stream (`event_forwarder.go` XPENDING/XCLAIM), but the
  local stack (`deploy/docker-compose.yml`) ships **NATS, not Redis**. Verify what carries
  worker-published lifecycle events to the CP in each env (prod = Redis?), then either (a) add
  Redis to the local compose so Path B is testable locally, or (b) point the projector at the
  transport the CP already consumes. Path A (CP-DB, in-tx) is unaffected and testable now.

---

## 15. Implementation readiness, testing, deployment & rollback

**Readiness: design-complete (rev 5) — ready to implement.** One canonical contract (§2b);
schema, dual-path projection, dispatcher, signing, SSRF, API, and reliability are all specified
with code sites (§12); build order = §13. The doc is current as of rev 5 (no known stale
sections). Pre-build verifications still open: **O5** (secret key) and **★O9** (Path-B transport).

### What's net-new at runtime
The **projector** (Redis consumer group) and **dispatcher** (Postgres poll loop) are new
**background goroutines in the control plane** (`cmd/server/main.go`), beside the existing
`billable_events_sender` / `event_forwarder`. New tables only (additive migration); no worker/
agent change except the event-emission gaps (§3).

### Testing
**Local (the fast loop, default):** `make infra-up` (Postgres :5432 + NATS) → `make run-pg`
(combined mode; **migrations run on server start**) → `make seed` (org `test-org`, key
`test-key`). Hit `/api/webhooks` CRUD + `/test` + deliveries on `localhost` with `X-API-Key:
test-key`; point a destination at a local sink and assert signing / retry / dead-letter /
redeliver / soft-delete-cancel.
- **Covers fully:** the API, the dispatcher (claim → SSRF → sign → classify → backoff →
  dead-letter), and **Path-A** projection (stopped/hibernated/resumed + CP-side gap events,
  projected in-tx).
- **Pure unit tests (no infra):** SSRF allow/deny vectors, Standard Webhooks signing (golden
  vectors checked against the shipped TS `verifyWebhook`), `classify()`, `backoff()`, the
  state machine, idempotency (name-409 + key-replay).
- **Path B** needs Redis — see ★O9.

**Single-host dev (end-to-end, real sandboxes):** `make deploy-dev` rsyncs the branch to a
Terraform-provisioned EC2 host (`deploy/ec2/setup-single-host.sh`) and builds on-box → real
sandbox create/hibernate/stop → real lifecycle events → real deliveries. **Needs AWS creds +
Terraform state + the SSH key set up locally** — confirm before relying on it. (The GitHub
**preview-env** workflow is currently **disabled** — "TODO: rewrite for Azure/QEMU" — so it
isn't an option today.)

### Deployment
Control plane deploys on **push to `main`** (`.github/workflows/deploy-server.yml`, AWS via
OIDC); **migrations apply on server boot**. Sequence:
1. Implement Go (§12) behind the additive migration.
2. Merge → CP deploys + migration runs on boot (follow the prod-DB **gated-migration** rule,
   `AGENTS.md`).
3. Land the event-emission gaps (§3).
4. **Publish the SDK (`@opencomputer/sdk` 0.8.0, via `publish-ts-sdk.yml`) and flip the Preview
   docs live only AFTER the backend is live** — until then the SDK 404s and the docs describe an
   unbuilt API. The 0.8.0 bump is staged; do **not** publish early.

### Rollback — feasible and clean
The feature is **dormant until a destination exists** (no destinations → projector matches
nothing, dispatcher finds no due rows → no-op), the same safety property as the runtime
pointer. So:
- **Code rollback** = redeploy the prior server binary (revert the commit / deploy an older SHA).
  The background workers stop; no existing endpoint or sandbox behavior is touched.
- **Migration** is additive (new tables; no changes to existing columns) → no down-migration on
  rollback; the tables sit inert.
- No data to unwind. Existing destinations simply stop delivering until redeployed.

### Risks
- **SSRF (highest).** User-controlled URLs — the resolve-pin-block module (§8) must be solid and
  vector-tested before prod.
- **New CP background workers.** A bug could hot-loop or lag; bound batches, add metrics, lean on
  dormant-until-used to cap blast radius.
- **Redis / Path B (★O9).** Reclaim on Azure Redis 6.0 (XPENDING/XCLAIM, chosen) + the transport
  question above.
- **Secret key management (O5).** Reuse `internal/crypto/encrypt.go`; confirm key config.
- **Ahead of backend.** Docs + SDK exist; the Go impl doesn't yet — hold publish until it lands.
