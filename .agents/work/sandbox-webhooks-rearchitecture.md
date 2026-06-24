# Sandbox webhooks — re-architecture (reuse existing infra + managed delivery)

Status: **design / pre-build, 2026-06-24.** The shipped impl (PR #410, branch `feat/sandbox-webhooks`,
design doc `sandbox-lifecycle-webhooks.md`) works and is tested, but it's **over-built for OC's
architecture**. This doc proposes the leaner shape. We continue in the **same PR/branch** (major
changes, not a new PR); consolidate the two design docs later.

## 0. Thesis (Igor)

Rely on **managed services for periphery** (webhooks) so the OC control plane doesn't take on
delivery concerns. Webhooks naturally belong **at the edge**, where the event stream already
converges. Design the trigger behind a **clean seam** so a future edge-native delivery adapter can
replace the managed service **without building any fallback now**.

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

## 2. What already exists — reuse these

**Event stream → edge (the sourcing pipeline, all in `opencomputer/`).**
- Publishers → `events:{cell_id}`: worker per-sandbox SQLite (`redis_event_publisher.go`: created,
  stopped, hibernated, woke), CP `cellevents.PublishLifecycle` (fallback stopped/hibernated),
  `checkpoint_events.go` (checkpoint_ready/failed/deleted, image_cache_*), `capacity_reporter.go`
  (cell_capacity), `scaler.go` (migrated), worker usage_ticker (usage_tick), audit (command/pty_*).
- `EventForwarder` (consumer group `cf-forwarder`) batches → `events-ingest` Worker `/ingest`:
  verifies HMAC, **dedups (`events` table `ON CONFLICT(id) DO NOTHING`)**, projects to D1
  (`sandboxes_index`/`checkpoints_index`/`images_index`/`cells`/`usage_samples`), fans out to the
  `CreditAccount` DO (`/debit`), archives raw to R2 — each as a `waitUntil` sink.

**The edge worker is the convergence point + the place managed integrations already live.**
`api-edge/src/autumn_webhook.ts` **already verifies Svix-signed webhooks** (from Autumn billing) and
projects to D1 — so **Svix is already a trusted vendor in the stack** and the Standard-Webhooks
verify path exists here. The edge already has `org_id` on every event and an idempotent event log.

**Svix (managed delivery) — fits "thin CP".** (research: docs.svix.com; OSS `svix/svix-webhooks`.)
- Model: Application (per org, keyed by your `uid` = org_id → **stateless**, no id storage) →
  Endpoint (per destination) → Message (event). Server side you only **create-app + POST-message**;
  consumers self-serve endpoints/secrets/logs/replay via the **App Portal** (magic link minted from
  your backend) — so we delete our deliveries dashboard + most management surface.
- Svix owns: retries/backoff, dead-letter + replay, delivery logs, endpoint+secret management,
  **SSRF (private-IP blocked by default)**, throttling, and **signing = the exact Standard Webhooks
  scheme we already implemented** — only header prefix differs (`svix-id` vs `webhook-id`), so
  generic Standard-Webhooks verifiers keep working.
- Splittable: OSS self-hostable (Postgres + optional Redis), **same API** as Cloud → low lock-in;
  Standard Webhooks means a future non-Svix sender doesn't break consumers. Cost (Cloud): free to
  50k msg/mo, then $0.0001/msg; or self-host = infra only. Tradeoff: event payloads transit Svix
  (Cloud) — data-residency lever is self-host.

## 3. Target architecture

```
sandbox lifecycle (worker SQLite / CP PublishLifecycle)
   → events:{cell} Redis stream → EventForwarder → events-ingest Worker (edge)
        ├─ (existing) D1 projections + CreditAccount DO + R2 archive
        └─ (NEW) WebhookSink.send(orgId, lifecycleEvent)        ← one more waitUntil fan-out
                    └─ SvixSink: POST Svix /app/{orgId}/msg/  (eventType + camelCase payload)
                          → Svix delivers/retries/signs/SSRF → consumer endpoint

thin CP management API  /api/webhooks  →  Svix App (create) + App Portal link (endpoints/logs)
```

- **Trigger lives at the edge** (`events-ingest`), not the CP. For each webhook-eligible lifecycle
  event in a batch, map internal type → public `sandbox.*` type + render the camelCase payload, and
  `WebhookSink.send`. Idempotency: reuse the event's deterministic id as Svix `Idempotency-Key` /
  message `eventId` (dedup on retries; the edge already dedups in D1 first).
- **Delivery = Svix.** No CP dispatcher/SSRF/signing/ledger/reconciler.
- **Management API = thin proxy to Svix.** `POST /api/webhooks` (or inline on sandbox create) →
  create the org's Svix app if absent + create an Endpoint; `GET`/portal → mint an App Portal link.
  Sandbox-scoped destinations → Svix **channels** or endpoint `filterTypes`. We may keep a thin OC
  API shape over Svix, or expose the App Portal directly (decision D4).
- **The seam (splittable, build only SvixSink now):**
  `interface WebhookSink { send(orgId, event): Promise<void> }`. Today `SvixSink`. A future
  `EdgeSink` (self-built CF-Queues delivery, à la sessions-api) implements the same interface with
  zero change to the trigger. **Do not build EdgeSink now.**

## 4. What changes vs the shipped code

**Delete (or retire behind the seam):**
- CP: `webhook_dispatcher.go`, `webhook_materializer.go`, `lifecycle_ingress.go`,
  `internal/webhook/{sign,ssrf}.go`, `recordLifecycleEvent` + all in-tx CP-origin capture hooks
  (`UpdateSandboxSessionStatus`, `CompleteMigration`, reconcile/failure paths,
  `recordLifecycle`/`recordLifecycleID` in `api/sandbox.go`), the dormancy gate.
- DB: `sandbox_lifecycle_events`, `webhook_deliveries`, `webhook_idempotency_keys` (+ their migration
  049 parts). `webhook_destinations` likely also goes (Svix owns endpoints) — unless we keep a thin
  local index (decision D4).
- API: the deliveries endpoints (`/deliveries`, `/redeliver`) — Svix App Portal replaces them.

**Add:**
- Edge `WebhookSink` + `SvixSink` in `cloudflare-workers/` (Svix client + app-by-uid + msg send),
  wired into `events-ingest` fan-out. Svix API token as a Worker secret.
- A small type-mapping (internal worker type → public `sandbox.*` + payload) at the edge (mirrors the
  `lifecycle_ingress` normalization we just wrote — moves there).
- Thin management glue (create Svix app per org; App Portal link minting; endpoint create for
  inline-on-create).

**Keep (mostly as-is, valuable regardless):** the **public contract** (event taxonomy, camelCase
envelope, `verifyWebhook` SDK helper — already Standard Webhooks = Svix-compatible) and the docs,
adjusted for the `svix-*` header names + App-Portal endpoint management.

## 5. Event coverage on the stream (what's there vs missing)

Already on `events:{cell}` (→ edge): **created, stopped, hibernated, woke(resumed), migrated**,
checkpoint_ready/failed/deleted. **NOT on the stream** (we only added them as CP `recordLifecycle`):
**scaled, forked, preview_url.changed, ready**. To edge-source those, **publish them to the stream**
(`PublishLifecycle`) instead of recording CP-side — a small change at the same call sites. `ready`
stays a producer gap (no post-boot signal today). `checkpoint.created` maps from `checkpoint_ready`.
Limiting webhooks to the lifecycle subset of the stream loses only usage_tick/capacity/audit events —
**none are customer webhook events**, so nothing relevant is lost.

## 6. Open decisions / tradeoffs (resolve before build)

- **D1 — Svix Cloud vs self-host.** Cloud = zero-ops, payloads transit Svix. Self-host = Postgres+Redis
  + ops, data stays in-house. Recommend **Cloud to start** (matches the Autumn precedent), self-host
  later if residency demands. (Igor.)
- **D2 — metadata-in-envelope.** Shipped envelope embeds the sandbox's user `metadata` (capped) for
  routing-without-lookup. The **edge does not have CP `sandbox_sessions.metadata`**. Options: (a)
  put metadata on the event payload at the *publisher* (worker/CP) so it rides the stream; (b) drop
  verbatim metadata from the envelope (consumer looks it up); (c) only inline-create carries it.
  Leaning (a) for `created`, else (b).
- **D3 — where the trigger really lives.** Edge `events-ingest` (recommended — convergence + managed
  integration already there) vs a thin CP→Svix call from `EventForwarder`'s existing consumer. Edge
  keeps the CP thinnest.
- **D4 — management API shape.** (a) Expose Svix **App Portal** directly (least code, consumer
  self-serve) vs (b) keep OC's `/api/webhooks` as a thin proxy over Svix endpoints (our API shape +
  SDK, more glue). Affects whether `webhook_destinations` survives as a local index.
- **D5 — sessions-api convergence.** sessions-api has its own CF-Queues delivery. Out of scope here,
  but the same `WebhookSink`/Svix move would later unify both products on one delivery layer.
- **D6 — sandbox-scoping** via Svix channels vs endpoint `filterTypes`; inline-on-create maps to a
  Svix endpoint create.

## 7. Migration path (same PR/branch #410) + phasing

The shipped CP webhooks are **dormant until a destination exists** and **unpublished/undeployed**, so
ripping them out has no prod blast radius. Phasing:
- **P0** — land `SvixSink` + the edge fan-out + Svix app-per-org + the thin management glue
  (Cloud Svix). Publish `scaled/forked/preview_url` to the stream. Verify e2e on the dev box (Svix
  Cloud test app).
- **P1** — delete the CP dispatcher/materializer/ingress/signing/ssrf/ledger + the
  `sandbox_lifecycle_events`/`webhook_deliveries` tables; reduce migration 049 to whatever (if any)
  local index survives (D4); update docs to `svix-*` headers + App Portal.
- **Future (not now, behind the seam):** an `EdgeSink` self-built delivery adapter (only if we ever
  need to drop the managed dependency); sessions-api convergence (D5).

## 8. References

- Shipped design + decision log: `sandbox-lifecycle-webhooks.md` (same dir).
- Stream/edge code: `internal/{worker/redis_event_publisher,cellevents/publish,controlplane/event_forwarder,controlplane/cf_event_client}.go`; `cloudflare-workers/events-ingest/src/index.ts`; `cloudflare-workers/api-edge/src/autumn_webhook.ts` (Svix-verify precedent).
- Svix: docs.svix.com (overview/quickstart/retries/security/app-portal), `github.com/svix/svix-webhooks` (OSS), standardwebhooks.com (signing — identical to ours).
