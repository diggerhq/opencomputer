# Sandbox webhooks — re-architecture (reuse existing infra + managed delivery)

Status: **design / pre-build, 2026-06-24 (rev2 — incorporates review findings).** The shipped impl
(PR #410, branch `feat/sandbox-webhooks`, design doc `sandbox-lifecycle-webhooks.md`) works and is
tested, but it's **over-built for OC's architecture**. This doc proposes the leaner shape and is
intended to be **build-ready**: the durability boundary, the public-contract delta, and the state
model are specified, not hand-waved. We continue in the **same PR/branch** (major changes, not a new
PR); consolidate the two design docs later.

## 0. Thesis (Igor)

Rely on **managed services for periphery** (webhooks) so the OC control plane doesn't take on
delivery concerns. Webhooks naturally belong **at the edge**, where the event stream already
converges. Design the trigger behind a **clean seam** so a future edge-native delivery adapter can
replace the managed service **without building any fallback now**.

**Non-negotiable (review):** "thin CP + managed delivery" must NOT cost us the durability we already
shipped. OC still owns one durable boundary — **"this event is accepted for webhook delivery"** —
and a precise compatibility story for headers, SDK, metadata, filtering, and inline ordering. Svix
owns everything *after* that boundary (fan-out, retries, signing, SSRF, logs, portal).

## 1. What we shipped, and the two redundancies

The shipped P1 is a **full, self-contained webhook stack inside the regional CP** (Go):
`recordLifecycleEvent` (in-tx CP capture + a Redis-stream `lifecycle_ingress`) → canonical
`sandbox_lifecycle_events` → `webhook_materializer` → `webhook_deliveries` → `webhook_dispatcher`
(Postgres-poll send + `internal/webhook/sign.go` Standard-Webhooks signing + `ssrf.go` + retry
ledger + reconciler) + management API + a deliveries dashboard surface.

Two things it duplicates:

1. **Sourcing.** There is already a `events:{cell_id}` Redis stream → `EventForwarder`
   (`cf_event_client.go`, HMAC) → **`cloudflare-workers/events-ingest/` Worker** → D1. **Every
   sandbox lifecycle state change already flows to the edge** (created/running/stopped/hibernated/
   woke/migrated update D1 `sandboxes_index`; checkpoint_* update `checkpoints_index`). Our
   `lifecycle_ingress` is a **second consumer group on the same stream**, re-deriving events the
   edge already has.
2. **Delivery.** We took fan-out delivery full-stack (dispatcher + signing + SSRF + ledger +
   reconciler) instead of a managed service. sessions-api *also* hand-rolled delivery (CF Queues +
   `dispatch_outbox` + regional egress) — so we now have **two** bespoke webhook delivery systems.

**What survives the cut (and why it's still far thinner).** The lean design keeps three *small*
durable artifacts — a per-org local index, a CP transactional outbox for CP-origin events, and an
edge delivery outbox — and deletes the rest. Gone vs shipped: the canonical event table, the
per-destination materializer + deliveries ledger + dispatcher state machine, signing, SSRF, the
12-attempt backoff, the reconciler, the redelivery API, the idempotency-keys table. Svix owns all of
that. So "thin CP" is honest — we are not rebuilding the dispatcher, only preserving durability.

## 2. What already exists — reuse these

**Event stream → edge (the sourcing pipeline, all in `opencomputer/`).**
- Publishers → `events:{cell_id}`: worker per-sandbox SQLite (`redis_event_publisher.go`: created,
  stopped, hibernated, woke), CP `cellevents.PublishLifecycle` (fallback stopped/hibernated +
  migrated), `checkpoint_events.go` (checkpoint_ready/failed/deleted, image_cache_*),
  `capacity_reporter.go` (cell_capacity), worker usage_ticker (usage_tick), audit (command/pty_*).
- `EventForwarder` (consumer group `cf-forwarder`) batches → `events-ingest` Worker `/ingest`:
  verifies HMAC, **dedups + durably stores via `env.OPENCOMPUTER_DB.batch([...])`** (the `events`
  table + projections, atomic — `events-ingest/src/index.ts:481`), then returns **202**. The
  forwarder **XACKs only on 2xx** (`event_forwarder.go:334`); a 5xx leaves the batch in the PEL for
  retry. Work done *after* the batch (R2 archive, the DO `/debit` `waitUntil`) is **best-effort** —
  the code itself notes "events are already in D1, which is the durable record" (`index.ts:490`).
  **⇒ The D1 batch is the only durable boundary; a `waitUntil` Svix call would be silently lost.**

**The edge worker is the convergence point + the place managed integrations already live.**
`api-edge/src/autumn_webhook.ts` **already verifies Svix-signed webhooks** (from Autumn billing) and
projects to D1 — so **Svix is already a trusted vendor in the stack** and the Standard-Webhooks
verify path exists here. The edge already has `org_id` on every event and an idempotent event log.

**Svix (managed delivery) — fits "thin CP".** (research: docs.svix.com; OSS `svix/svix-webhooks`.)
- Model: Application (per org, keyed by your `uid` = org_id → **stateless**, no id storage) →
  Endpoint (per destination) → Message (event). Server side you only **create-app + POST-message**;
  consumers self-serve endpoints/secrets/logs/replay via the **App Portal** (magic link minted from
  your backend).
- Svix owns: retries/backoff (its own schedule, *not* ours), dead-letter + replay, delivery logs,
  endpoint+secret management, **SSRF (private-IP blocked by default)**, throttling, and **signing =
  the exact Standard Webhooks scheme** — only header prefix differs (`svix-id` vs `webhook-id`).
- Idempotency: Svix message create takes an `Idempotency-Key` (we pass the event's stable id) and
  the receiver sees a stable `svix-id` across retries.
- Splittable: OSS self-hostable (Postgres + optional Redis), **same API** as Cloud → low lock-in;
  Standard Webhooks means a future non-Svix sender doesn't break consumers. Cost (Cloud): free to
  50k msg/mo, then $0.0001/msg; or self-host = infra only. Tradeoff: event payloads transit Svix
  (Cloud) — data-residency lever is self-host.

## 3. Target architecture

```
CP-origin transition (scaled/forked/preview/migrated/ready/cp-fallback stop)
   └─ write lifecycle_outbox row IN THE SAME DB TX as the state change   [origin durability]
        └─ thin CP relay → PublishWebhookLifecycle(stableId, typed data) → events:{cell} stream
worker-origin (created/stopped/hibernated/woke)
   └─ already durable in worker SQLite → events:{cell} stream

events:{cell} → EventForwarder → events-ingest Worker (edge)
   ├─ (existing) atomic D1 batch: events + projections                    [edge durability]
   └─ (NEW) in the SAME atomic batch: INSERT webhook-eligible events into webhook_outbox (D1)
                                       ↑ gated by per-org "has webhooks" index (dormancy)
            then a relay (CF Queue consumer or cron) drains webhook_outbox:
                WebhookSink.send(orgId, event)  →  SvixSink: POST Svix /app/{orgId}/msg/
                   (Idempotency-Key = event.id)  →  Svix delivers/retries/signs → consumer

thin CP management API /api/webhooks → Svix App (create) + Endpoint/channel (inline) + App Portal link
local index (PG): org_id → has_webhooks / svix_app_uid + sandbox-scoped endpoint mappings
```

- **Trigger lives at the edge** (`events-ingest`), not the CP. For each webhook-eligible event, map
  internal type → public `sandbox.*` + render the camelCase payload, and **enqueue durably** (see
  §3.1). Dormancy: only enqueue if the per-org index says the org has webhooks (§3.3).
- **Delivery = Svix.** No CP dispatcher/SSRF/signing/ledger/reconciler.
- **The seam (splittable, build only SvixSink now):**
  `interface WebhookSink { send(orgId, event): Promise<void> }`. Today `SvixSink` (drains the
  outbox). A future `EdgeSink` (self-built CF-Queues delivery, à la sessions-api) implements the
  same interface with zero change to the trigger or the outbox. **Do not build EdgeSink now.**

### 3.1 The durable "accepted for delivery" boundary (P0 — was wrong in rev1)

rev1 said "one more `waitUntil` fan-out." **That is incorrect** — a Svix failure after the 202 is
lost (§2). The fix: make acceptance atomic with the existing durable write.

- At the edge, **write webhook-eligible events into a `webhook_outbox` D1 table inside the same
  `env.OPENCOMPUTER_DB.batch([...])`** that already persists `events` (`index.ts:481`). Now
  "durably recorded" and "accepted for webhook delivery" commit together, before the 202/XACK.
- A **separate relay drains `webhook_outbox` → Svix** (idempotent create), decoupled from Svix
  uptime. Two acceptable mechanisms (decision **D7**): (a) a CF **Queue** — enqueue is durable, the
  consumer gets native retry/DLQ (sessions-api precedent); or (b) keep the **D1 outbox** + a CF
  **cron** relay that claims rows (`status=pending`, dedup on event id) and marks them sent. Either
  is thin (no signing/SSRF/ledger — Svix owns those).
- **Reject** the tempting "synchronous Svix create inside /ingest, return 5xx on failure" option:
  it couples the *whole* event pipeline (billing/D1 projections) to Svix uptime — a Svix outage
  would stall the forwarder and back-pressure billing. The outbox decouples them.

### 3.2 CP-origin durability — keep the transactional capture (P0 — was a silent regression)

The shipped design's real strength is that **CP transitions are captured in the same DB tx** as the
state change (e.g. `CompleteMigration` records `sandbox.migrated` in-tx; `store.go`). Replacing that
with a post-commit `PublishLifecycle` (fire-and-forget after commit) **drops the event if the CP
crashes in the commit→publish window** — a regression for `migrated`, `scaled`, `forked`,
`preview_url.changed`, `ready`, and CP-fallback `stopped`/`hibernated`.

**Recommendation (decision D8):** keep a **minimal `lifecycle_outbox` table** that CP-origin
transitions write **in-tx** (transactional-outbox pattern — one table, far smaller than the shipped
materializer/ledger). A thin CP relay drains it via a **typed** publish to the stream (§3.4), then
marks sent. Worker-origin events need no outbox (worker SQLite is already their durable source).
Alternative if we accept weaker guarantees: **explicitly downgrade the public contract** to
"CP-origin lifecycle events are best-effort and may be dropped on CP crash" — but that must be a
*stated* decision, documented in the public docs, not an accident.

### 3.3 Filtering / scoping / dormancy — keep a tiny local index (P1)

Deleting `webhook_destinations` outright loses (a) the **dormancy gate** (today
`webhooks.go:59` — don't record/deliver for orgs with no live destination) and (b) local knowledge
of **sandbox-scoped** destinations. Keep a **small local index** instead:
- per-org row: `has_webhooks` (drives the edge dormancy gate — don't enqueue if false) and the Svix
  `app_uid` (= org_id, so effectively just an existence flag);
- inline **sandbox-scoped** endpoint mappings (sandbox_id → Svix endpoint/channel).

Scoping model in Svix (**D6**): org-level destinations = endpoint under the org app subscribed by
`filterTypes`; **sandbox-scoped** = endpoint subscribed to **channel = sandbox_id** and we publish
each sandbox event on that channel. The edge consults the index (cached) before enqueuing so an org
with zero endpoints sends nothing to Svix.

### 3.4 Typed publish, not the generic helper (P1)

`cellevents.PublishLifecycle` uses **random ids** and a `{reason}` payload (`publish.go:30`). Public
webhook events need **stable source ids** (so Svix idempotency + receiver dedup work) and **typed
public data** (`cpuCount`, `memoryMB`, `parentId`, `port`, `url`, `reason`, …). Add a typed
`PublishWebhookLifecycle(stableID, type, typedData)` (or `PublishLifecycleWithID`) used by the CP
outbox relay and the missing-event call sites — do **not** reuse the generic helper as-is.

### 3.5 Inline-on-create ordering (P1)

Docs promise inline `webhooks:[...]` on `POST /api/sandboxes` catch the lifecycle **from
`created`** (`docs/api-reference/sandboxes/create.mdx`). With edge+Svix, the **endpoint/channel must
exist before `created` is published**, or `sandbox.created` races past the subscription. Requirement:
in the create handler, **await Svix endpoint(+channel) creation before spawning/emitting `created`**.
This couples create latency to Svix for inline-webhook creates only (acceptable; lazy creation would
violate the "from created" promise).

## 4. Contract changes (public) — NOT "mostly as-is" (P0)

The envelope shape (camelCase, typed `data`) and event taxonomy stay, but **delivery is a different
contract** and must change deliberately. **Free to do now**: SDK 0.8.0 is unpublished and docs are
Preview/not-live, so there are **zero existing consumers** to break — but we must do it before GA.
- **Headers:** Svix emits `svix-id` / `svix-timestamp` / `svix-signature`. Update the SDK
  `verifyWebhook` to accept `svix-*` (the signature math is identical — Standard Webhooks). Decide
  whether to also accept legacy `webhook-*` (probably no — nothing shipped).
- **Retry schedule + delivery semantics:** Svix's schedule (not our 10s/30s/60s/5m/15m), Svix
  dead-letter/replay, Svix `svix-id` as the stable delivery id. Docs must be rewritten to Svix's
  model, including ordering-not-guaranteed.
- **Removed surface:** OC `/deliveries` list/get/**redeliver** endpoints and OC-issued delivery ids
  go away → replaced by the **Svix App Portal** (consumer self-serve logs + replay). Decision **D4**
  determines whether any thin `/api/webhooks` shape survives over Svix or we expose the Portal
  directly.
- **`verifyWebhook` stays** as the one helper consumers use — re-pointed at `svix-*` headers.

## 5. Event coverage on the stream (what's there vs missing)

Already on `events:{cell}` (→ edge): **created, stopped, hibernated, woke(resumed), migrated**,
checkpoint_ready/failed/deleted. **NOT on the stream** (only added as CP `recordLifecycle`):
**scaled, forked, preview_url.changed, ready**. To edge-source those, publish them to the stream via
the typed publish (§3.4) from the CP outbox (§3.2). `ready` stays a producer gap (no post-boot
signal today — same gap as shipped). `checkpoint.created` maps from `checkpoint_ready`. Limiting
webhooks to the lifecycle subset loses only usage_tick/capacity/audit — **none are customer webhook
events**, so nothing relevant is lost.

## 6. Open decisions / tradeoffs (resolve before build)

- **D1 — Svix Cloud vs self-host.** Cloud = zero-ops, payloads transit Svix. Self-host =
  Postgres+Redis + ops, data stays in-house. **Rec: Cloud to start** (matches the Autumn precedent),
  self-host later if residency demands.
- **D2 — metadata-in-envelope (BLOCKING contract decision, P1).** Public docs promise sandbox
  `metadata` verbatim on **every** delivery (`docs/sandboxes/webhooks.mdx`, `pkg/types/webhook.go`).
  The edge does **not** have CP `sandbox_sessions.metadata`. Either (a) **snapshot metadata onto
  every webhook-eligible event at publish time** (worker + CP outbox) so it rides the stream — keeps
  the promise, costs payload size (apply the existing cap); or (b) **drop the metadata promise**
  from docs/types/SDK. Pick one; "created only" is not a coherent contract. **Rec: (a)**.
- **D3 — where the trigger lives.** Edge `events-ingest` (**rec** — convergence + managed
  integration already there) vs a thin CP→Svix call. Edge keeps the CP thinnest.
- **D4 — management API shape.** Expose Svix **App Portal** directly (least code) vs keep a thin
  OC `/api/webhooks` proxy over Svix endpoints (our API shape + SDK, more glue). Drives how much of
  the local index (§3.3) is user-visible.
- **D5 — sessions-api convergence.** Out of scope now; the same `WebhookSink`/Svix move would later
  unify both products' delivery.
- **D6 — sandbox-scoping** via Svix **channels** (= sandbox_id) vs endpoint `filterTypes` (§3.3).
- **D7 — durable edge→Svix handoff:** CF **Queue** vs D1 **outbox + cron relay** (§3.1).
- **D8 — CP-origin durability:** in-tx **`lifecycle_outbox`** (**rec**) vs explicitly **downgraded**
  contract (§3.2).

## 7. Migration path (same PR/branch #410) + phasing

The shipped CP webhooks are **dormant until a destination exists** and **unpublished/undeployed**, so
ripping them out has no prod blast radius. Phasing:
- **P0** — land the local index (§3.3), the CP `lifecycle_outbox` + typed publish (§3.2/3.4) for the
  missing events, the edge `webhook_outbox`-in-batch + relay + `SvixSink` (§3.1), Svix app-per-org +
  inline endpoint create with correct ordering (§3.5). Cloud Svix. Verify e2e on the dev box (Svix
  Cloud test app) — adapt the existing smoke (`/tmp/webhooks_smoke.sh`) to assert Svix delivery.
- **P1** — delete the shipped CP dispatcher/materializer/ingress/signing/ssrf/ledger + the
  `sandbox_lifecycle_events`/`webhook_deliveries`/`webhook_idempotency_keys` tables; reduce migration
  049 to the local index + outbox; rewrite docs + SDK `verifyWebhook` to the Svix contract (§4).
- **Future (not now, behind the seam):** an `EdgeSink` self-built delivery adapter (only if we ever
  need to drop the managed dependency); sessions-api convergence (D5).

## 8. References

- Shipped design + decision log: `sandbox-lifecycle-webhooks.md` (same dir). PR body: `/tmp/pr410_body.md`.
- Durable boundary: `internal/controlplane/event_forwarder.go:331-340` (XACK-on-2xx),
  `cloudflare-workers/events-ingest/src/index.ts:481-522` (atomic batch = durable record; 202).
- Stream/edge code: `internal/{worker/redis_event_publisher,cellevents/publish,controlplane/cf_event_client}.go`; `cloudflare-workers/api-edge/src/autumn_webhook.ts` (Svix-verify precedent).
- Svix: docs.svix.com (overview/quickstart/retries/security/app-portal/channels/idempotency), `github.com/svix/svix-webhooks` (OSS), standardwebhooks.com (signing — identical to ours).
