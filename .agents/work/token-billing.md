# Token / model-usage billing — problem framing

Status: **problem capture only.** No solution chosen, nothing scheduled.
This doc exists so a future agent (or us) can pick the problem up with full
context instead of re-deriving it. It frames the problem and lays out viable
routes; it deliberately does **not** pick one.

## Why this exists

We want **pass-through billing for model usage**: bill a customer org for the
LLM tokens its agent sessions consume, drawn from the same **credits** balance
we already use for compute. Today we meter and bill **compute** (sandbox
GB-seconds); we do **not** meter or bill **model tokens** at all.

This is the natural next step after act-as-org ownership (see
`agent-sandbox-ownership.md`): sandboxes are already owned by + billed to the
customer org. Model usage is the other big cost an agent session incurs, and
right now it's either invisible (managed key) or paid out-of-band by the
customer (BYO key).

## The two-track credential model (decided elsewhere — context for this doc)

Credential handling is splitting into two modes. They map cleanly onto two
**billing** modes, and keeping them distinct keeps this problem tractable:

- **BYO key** — the user stores their own provider key (the Credentials UX, a
  separate workstream). They pay the provider directly on their own invoice.
  We may still want to **surface** their usage for observability, but we do
  **not** bill them for model tokens.
- **Managed key** — OC supplies the provider key. The org consumes OC credits
  for model usage and we bill them (pass-through, possibly with a markup).
  **This doc is about the managed path.**

A session must record which mode it ran under (and which credential / `last4`),
so billing only ever fires for managed-key sessions. That metadata already
exists (credential metadata + the sealed per-session secret store).

## What exists today — legacy compute billing (context, NOT a foundation)

> ⚠️ **Direction:** the existing **prepaid / 15-minute-bucket compute-billing
> pipeline is a deprecation candidate** — not somewhere we want to invest
> further. Treat the bullets below as *what's there today*, not as the substrate
> to extend. Model billing should **not** assume it inherits this pipeline; the
> credits **unit** stays (we bill model usage "as part of credits"), but the
> metering/ledger **mechanism** is an open decision (see Open questions). There's
> also a natural-fit argument here: model usage is inherently **per-call /
> per-event** (token counts per request), which maps poorly onto the
> GB-second, 15-minute-bucket compute model regardless of the deprecation call.

- **Compute billing pipeline (legacy)** — `internal/db/billable_events.go`: an
  outbox of metered events (`reserved_usage`, `overage_usage`,
  `disk_overage_usage`), keyed by `(org_id, event_type, memory_mb,
  bucket_start)`, GB-seconds over 15-minute buckets, delivered to Stripe /
  Autumn (`stripe_event_id`). No model-usage event type — and per the direction
  above, bolting one on here is **not** the assumed path.
- **Two billing providers, per org** — `orgs.billing_provider` (migration 047):
  `legacy` (in-house CreditAccount DO on the edge + UsageReporter on the cell)
  vs `autumn` (Autumn owns the credit ledger, metering, top-ups, auto-recharge,
  concurrency plans; the cell just measures usage → `track()`). A credit ledger
  + auto-recharge exists, but whether model billing rides Autumn, something new,
  or a successor to all of this is open — don't assume.
- **Credit halt (legacy)** — `is_halted` / `halted_at` on `orgs`
  (migration 043), mirrored from the CreditAccount DO via `/admin/halt-org`; the
  wake handler refuses halted orgs; `halt_reason` on `sandbox_sessions`
  distinguishes credit-exhaustion from user hibernation. Part of the same legacy
  pipeline; it also only gates **sandbox wake**, not **mid-session model spend**
  — a long turn can keep burning model tokens after credits are gone.
- **Model-call paths (the candidate metering chokepoints):**
  - **V3 (durable sessions — the live dashboard path):** model calls egress
    **directly** from the sandbox through the host-side **secrets/egress proxy**
    (`internal/secretsproxy/proxy.go`). The proxy already MITMs TLS (it swaps
    the sealed token for the real key) and sits on *every* VM's outbound HTTPS
    via a link-local address. It does **not** count tokens today.
  - **V2 (background agents):** an optional model **gateway**
    (`sessions-api/src/gateway/index.ts`) that injects the provider key and
    emits telemetry marks (`model.call.start/forwarded`) but does **not** count
    tokens. V3 bypasses it entirely.

## The problem, decomposed

1. **Metering** — count tokens (input / output / cache / tool-use) and/or cost
   per org, ideally per session and per agent, **trustworthy** enough to bill
   and **timely** enough to enforce limits.
2. **Rating / pricing** — convert metered usage → credits. A rate card per
   provider + model, with input/output/cache-token pricing, and a policy
   (at-cost vs markup).
3. **Billing integration** — debit credits, enforce quota, halt on exhaustion
   (including **mid-session**), and reconcile our metered numbers against the
   provider's own invoice (we eat any delta).
4. **Surfacing** — usage + cost visibility and receipts in the dashboard, with
   a per-session / per-agent breakdown.
5. **Multi-provider / multi-model** — Anthropic today; OpenAI/codex later;
   per-model pricing, prompt caching, and batch all change the math.

## What makes it hard (constraints to respect)

- **Integrity** — the agent runs *inside the customer's sandbox*, so
  self-reported token counts from the runtime are not billable on their own.
  The count must come from a host-trusted point (proxy / gateway) or the
  provider.
- **Reconciliation / margin risk** — our metered cost must match the provider
  invoice closely, or pass-through billing loses money. Streaming responses
  report usage only in a final SSE event; tool use and caching shift the totals.
- **Latency vs runaway spend** — a single turn can burn a lot before a daily
  provider-usage pull would notice. Real-time-enough metering is needed if we
  want to *halt* on model-spend rather than only bill after the fact.
- **Two runtimes, two chokepoints** — V3 (proxy) and V2 (gateway) differ; a
  unified billing pipeline has to cover whichever paths stay alive.

## Viable routes (capture, not decide)

### Metering — where to count

- **A. Egress-proxy meter (V3).** Have `secretsproxy` parse the Anthropic/OpenAI
  response `usage` block. *Pro:* already on the path, host-trusted, per-session
  attributable via the sealed-store↔session mapping, no new hop. *Con:* must
  parse provider response shapes incl. streaming SSE; couples metering to the
  proxy; multi-provider response handling.
- **B. Gateway chokepoint.** Route all model calls through an OC gateway and
  count there. *Pro:* clean app-layer seam; already injects the key; one place
  for metering + rate limiting. *Con:* V3 bypasses it today; adds a hop +
  availability dependency; still needs SSE parsing.
- **C. Provider usage / Admin API.** Pull from Anthropic's usage/cost Admin API
  per key. *Pro:* authoritative, matches the invoice. *Con:* needs per-org key
  segregation to attribute; coarse granularity + latency (not real-time, can't
  halt mid-session); no per-session detail.
- **D. Runtime-reported usage.** The agent reports usage events. *Pro:* trivial
  access to exact counts. *Con:* untrusted → not billable alone; useful only as
  observability or a cross-check against A/B/C.
- **E. Third-party LLM gateway / metering platform.** Helicone / Portkey /
  LiteLLM / OpenRouter / Cloudflare AI Gateway for metering at the model edge,
  or Metronome / Orb / OpenMeter for usage rating + billing. *Pro:* offloads
  metering and/or rating; some offer pass-through billing. *Con:* another
  dependency + customer data egress to them + their cost; we likely still own
  the credit ledger.

Plausible combination: **A (or B)** for real-time, trusted, per-session metering
+ **C** as a periodic reconciliation against the provider invoice.

### Rating / credit model

- At-cost pass-through (credits == provider cost) — simplest, zero margin.
- Cost + markup % — margin, but needs a maintained rate card as prices move.
- Unified credits (compute + model in one balance) vs separate "model credits".
- Open: who owns and updates the rate card when provider prices change.

### Billing integration

> Do **not** assume extending the legacy compute pipeline (see the direction
> note above). The credits **unit** stays; the metering/ledger **substrate** is
> an open decision and may well be built fresh for per-call model usage.

- **Substrate is open.** Whatever the credits ledger becomes (a successor to the
  legacy/Autumn split, a usage-rating provider, or something new), model usage
  is debited there. A model-usage record is naturally **per-call** (org +
  session + agent + model + token counts + computed cost), not a GB-second
  bucket — design the event for that shape, independent of the legacy outbox.
- Extend halt/quota semantics to model spend; consider a **mid-session**
  soft-stop or a **pre-flight budget reservation** for long turns (agents
  already carry limits like `maxTurnSeconds`; add a token/credit budget).

### BYO vs managed interaction

- **BYO** → no model billing (customer's own provider invoice); optional usage
  surfacing only.
- **Managed** → billed. Requires a reliable per-session record of mode + which
  key was used (already available via credential metadata + the sealed store).

## Open questions (deferred decisions)

- At-cost vs markup? Unified credits vs a separate model-credit balance?
- Real-time halt on model spend, or bill-after-the-fact + trust + reconcile?
- Per-session vs per-org granularity for v1?
- Build metering in-house (proxy/gateway) vs adopt an LLM-gateway/metering
  provider (route E)?
- **What replaces the prepaid / 15-min-bucket compute-billing pipeline (a
  deprecation candidate), and should model billing share a credits substrate
  with it or be built fresh?** This is the biggest upstream unknown — it gates
  the "Billing integration" choice.
- Reconciliation policy: metered vs provider invoice — who eats the delta, and
  at what cadence do we true-up?
- When do OpenAI/codex (multi-provider) land, and does that change the choice?

## Pointers

- Compute billing: `internal/db/billable_events.go`, `internal/db/usage.go`,
  migrations `023_free_credits_remaining_cents`, `043_credit_halt`,
  `047_orgs_billing_provider`, `048_orgs_usage_sync_watermark`;
  `internal/controlplane/halt_reconciler.go`.
- V3 model-call chokepoint: `internal/secretsproxy/proxy.go`.
- V2 model gateway: `sessions-api/src/gateway/index.ts`.
- Credential storage + per-session sealing: `sessions-api/src/v3/core/credentials.ts`,
  `sessions-api/src/v3/runtime/credential.ts`.
- Related design: `agent-sandbox-ownership.md` (act-as-org compute billing),
  `.agents/design/per-sandbox-usage-api.md` and `.agents/design/sandbox-tags-and-usage.md`
  (existing usage-metering precedent).
