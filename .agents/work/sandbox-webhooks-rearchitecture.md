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

**Decisions locked (Igor, 2026-06-24):**
- **D1 = Svix Cloud** to start (swappable to self-host later).
- **D2 = drop the metadata promise.** Remove `metadata` from the envelope/docs/SDK; consumers look
  it up via the sandbox API using the event's `sandboxId`. ⇒ publishers do NOT snapshot metadata
  (simplifies the publisher + keeps payloads small).
- **D4 = OC API proxy only.** Keep a first-class OC `/api/webhooks` (CRUD + `/deliveries` view +
  `/redeliver` + `/test`) and the SDK `Webhooks` client — but back it **entirely with live Svix
  calls** (create/list/delete endpoints, read attempt logs, resend). Svix is the engine; OC owns the
  API shape so the dev experience matches the rest of `/api/*`. **Not** the App Portal.
- Proceeding on recommendations (revisit only if they bite): D3 trigger at the edge, D6 sandbox-scope
  via Svix channels, D7 outbox handoff, D8 in-tx `lifecycle_outbox`.

**External dependency (Igor must provision — blocks the Svix path):** a **Svix Cloud account + API
token**, set as a Worker secret (`SVIX_API_TOKEN`) for the edge relay and available for dev-box
testing. The CP-side foundation (below) can be built + tested without it.

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

### 3.1 The handoff boundary — synchronous create before ack (P0; rev1 said `waitUntil`, which is wrong)

**Premise (Igor):** Svix is fire-and-forget — it owns *consumer* delivery state (retries, attempts,
dead-letter, replay, endpoint logs, signing, endpoint disablement). OC keeps **no** `webhook_deliveries`
and **no** dispatcher. The only thing OC must get right is the **handoff**: an event isn't "handed
off" until **Svix has accepted the message**. rev1's `waitUntil` was fire-and-forget *before* the
managed service accepted — that's the bug, not synchronicity.

**Primary path (decision D7 = option 1, synchronous-before-ack):** in `/ingest`, after the durable
D1 batch (`index.ts:481`), for each webhook-eligible event (gated by the edge dormancy flag, §3.3)
call `svix.message.create(...)` with **`Idempotency-Key` = the event's stable id** (so forwarder
retries don't duplicate). **Only return 202 once Svix has accepted**; on a *transient* Svix error
(5xx/network/429) **return 503**, so the EventForwarder leaves the batch in the PEL and retries
(the same already-correct path used for D1 failures, `event_forwarder.go:339`). A Svix **4xx for one
message** (malformed/permanent) is logged + dropped, never failing the batch. No OC delivery rows;
from acceptance on, we forget it.

**The one real caveat to do with eyes open:** webhook events share Redis batches with **billing
(`usage_tick`) and D1-projection** events, so 503-on-Svix-failure back-pressures *those too* — a
*sustained* Svix outage would grow the PEL and risk stream-trim (`MaxLen ~100k`) of billing/lifecycle
events. Mitigation kept minimal: only 503 on *transient* Svix errors (above); D1 writes already
committed before the Svix call, so state/billing data is in D1 regardless (only the *ack* waits).
If a sustained Svix outage ever proves to threaten billing, escalate to the outbox (below) — the
`WebhookSink` seam means that swap doesn't touch the trigger. Given Svix Cloud's SLA, option 1 is
the right launch shape.

**Escalation (not built now) = option 2, durable outbox:** write webhook-eligible events into a
`webhook_outbox` (its own D1 table, or a CF Queue) **inside the same atomic `batch([...])`**, return
202 immediately, and a separate sender drains → Svix. This fully isolates ingest/billing latency +
availability from Svix, at the cost of one table + a relay. Behind the seam; add only if option 1
bites.

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
`webhooks.go:59` — don't deliver for orgs with no live destination) and (b) local knowledge of
**sandbox-scoped** destinations and the OC↔Svix id mapping the proxy API (D4) needs. Keep a **small
local index** in **two places**:
- **CP Postgres** (backs the `/api/webhooks` proxy): OC destination id ↔ Svix endpoint id, name,
  event-type filter, optional `sandbox_id` scope. CRUD here writes through to Svix endpoints; reads
  of `/deliveries` proxy Svix attempt logs live (no local ledger).
- **D1 at the edge** (`orgs.has_webhooks` flag, or a `webhook_orgs` table): set when the org's first
  endpoint is created, cleared when the last is deleted. The edge **already** does a per-batch D1
  `orgs` lookup (`planFor`), so the gate is ~free — **skip the Svix call entirely for orgs with no
  webhooks** (the vast majority), saving cost + latency.

Scoping model in Svix (**D6**): org-level destinations = endpoint subscribed by `filterTypes`;
**sandbox-scoped** = endpoint subscribed to **channel = sandbox_id**, and the edge posts each sandbox
event on that channel.

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
- **Metadata removed (D2):** drop `metadata` from the envelope, `pkg/types/webhook.go`, the SDK
  types, and the docs. Consumers look it up via the sandbox API using `sandboxId`.
- **Retry schedule + delivery semantics:** Svix's schedule (not our 10s/30s/60s/5m/15m), Svix
  dead-letter/replay, Svix `svix-id` as the stable delivery id. Docs must be rewritten to Svix's
  model, including ordering-not-guaranteed.
- **`/deliveries` + `/redeliver` + `/test` KEPT but re-backed by Svix (D4):** the OC API shape and
  SDK stay; under the hood, list/get **proxy Svix attempt logs**, `/redeliver` calls **Svix resend**,
  `/test` sends a Svix test/example message. **No OC delivery ledger.** Delivery ids surfaced are
  Svix's (`svix-id`).
- **`verifyWebhook` stays** as the one helper consumers use — re-pointed at `svix-*` headers.

## 5. Event coverage on the stream (what's there vs missing)

Already on `events:{cell}` (→ edge): **created, stopped, hibernated, woke(resumed), migrated**,
checkpoint_ready/failed/deleted. **NOT on the stream** (only added as CP `recordLifecycle`):
**scaled, forked, preview_url.changed, ready**. To edge-source those, publish them to the stream via
the typed publish (§3.4) from the CP outbox (§3.2). `ready` stays a producer gap (no post-boot
signal today — same gap as shipped). `checkpoint.created` maps from `checkpoint_ready`. Limiting
webhooks to the lifecycle subset loses only usage_tick/capacity/audit — **none are customer webhook
events**, so nothing relevant is lost.

## 6. Decisions

**Resolved (Igor, 2026-06-24):**
- **D1 = Svix Cloud** to start; swappable to self-host later if residency demands.
- **D2 = drop the metadata promise** (remove from envelope/types/SDK/docs; consumers look it up). §4.
- **D4 = OC API proxy only** — keep `/api/webhooks` CRUD + `/deliveries` + `/redeliver` + `/test` and
  the SDK, all backed by live Svix calls; no App Portal, no local delivery ledger. §3.3, §4.
- **D7 = option 1, synchronous Svix create before ack** (escalate to the outbox only if a sustained
  Svix outage threatens billing — behind the `WebhookSink` seam). §3.1.

**Proceeding on recommendation (revisit only if it bites):**
- **D3 = trigger at the edge** (`events-ingest`) — convergence + managed integration already there.
- **D6 = sandbox-scoping via Svix channels** (channel = sandbox_id); org-level via `filterTypes`.
- **D8 = in-tx `lifecycle_outbox`** for CP-origin durability (the remaining durability question now
  the edge→Svix handoff is settled) vs explicitly downgrading the contract. §3.2.

**Out of scope now:**
- **D5 — sessions-api convergence:** the same `WebhookSink`/Svix move would later unify both products'
  delivery; not part of this launch.

## 7. Migration path (same PR/branch #410) + phasing

The shipped CP webhooks are **dormant until a destination exists** and **unpublished/undeployed**, so
ripping them out has no prod blast radius. Phasing:

**Build order — CP-side first (no Svix creds needed), then the edge (needs `SVIX_API_TOKEN`):**
- **P0a (no Svix dependency):** the local index in CP Postgres + the D1 `has_webhooks` flag (§3.3);
  the in-tx `lifecycle_outbox` + typed `PublishWebhookLifecycle` (§3.2/3.4) so `scaled`/`forked`/
  `preview_url.changed` reach the stream; drop `metadata` from types/SDK/docs (§4, D2). Builds +
  unit-testable without Svix.
- **P0b (needs Svix Cloud token):** the `SvixSink` + synchronous create-before-ack in `events-ingest`
  (§3.1, D7 option 1) gated by `has_webhooks`; rework `/api/webhooks` CRUD + `/deliveries`/`/redeliver`/
  `/test` into a **Svix proxy** (D4) with the inline-create ordering (§3.5). Verify e2e on the dev box
  (Svix Cloud test app) — adapt the existing smoke (`/tmp/webhooks_smoke.sh`) to assert Svix delivery.
- **P1 (cleanup):** delete the shipped CP dispatcher/materializer/ingress/signing/ssrf/ledger + the
  `sandbox_lifecycle_events`/`webhook_deliveries`/`webhook_idempotency_keys` tables; reduce migration
  049 to the local index; finish the docs + SDK `verifyWebhook` Svix-contract rewrite (§4).
- **Future (not now, behind the seam):** the durable-outbox escalation (§3.1 option 2); an `EdgeSink`
  self-built delivery adapter; sessions-api convergence (D5).

## 8. References

- Shipped design + decision log: `sandbox-lifecycle-webhooks.md` (same dir). PR body: `/tmp/pr410_body.md`.
- Durable boundary: `internal/controlplane/event_forwarder.go:331-340` (XACK-on-2xx),
  `cloudflare-workers/events-ingest/src/index.ts:481-522` (atomic batch = durable record; 202).
- Stream/edge code: `internal/{worker/redis_event_publisher,cellevents/publish,controlplane/cf_event_client}.go`; `cloudflare-workers/api-edge/src/autumn_webhook.ts` (Svix-verify precedent).
- Svix: docs.svix.com (overview/quickstart/retries/security/app-portal/channels/idempotency), `github.com/svix/svix-webhooks` (OSS), standardwebhooks.com (signing — identical to ours).
