# Billing & usage UX — visibility, one-off top-up, auto-top-up with a monthly cap

Status: active (draft)
Last updated: 2026-07-02
Owns: the user-facing billing/usage/top-up surface (compute + model credits)
Supersedes: —
Implementation: `web/src/pages/Billing.tsx` + `cloudflare-workers/api-edge` Autumn (`model_meter.ts` / `autumn_meter.ts`); backend design in [`token-billing.md`](./token-billing.md)
Public docs: —

## Why (the trigger)

Report: "users running out of tokens." Investigation 2026-07-02 (telemetry + session events):

- **Mechanism.** Managed model spend meters per-org to the Autumn `credits` pool (edge `model_meter.ts`: debit OpenRouter spend → Autumn; halt the org at ≤0 balance). At halt, OpenRouter 402s and the runtime posts *"⚠️ I've run out of model credits… Top up your credits and message me again"* and stops (`runtimes/v3-claude/src/adapter.ts`, classified `credits_exhausted`). This is the "out of tokens." It is **not** `limits.tokens` — that cap is a wired no-op (sessions-api `usage-not-wired`).
- **Incidence: low + internal so far.** Only 3 orgs in 3 weeks, all team workspaces (`utpal@`, `igor@`, `mo+9000@digger.dev`); no external customer in the data yet. Structural, not an outage — but it scales to real users as-is.
- **Dominant burn factor: the OPUS default.** ~88% of managed sessions (620/~690 in 14d) run `anthropic/claude-opus-4-8` — mostly because the agent didn't set a model and the config default is opus (`sessions-api runtime/config.ts` `defaultModel`). Opus is ~3–5× sonnet, ~15–20× haiku; a modest grant evaporates in a few opus turns.
- **Compounders.** The model-credit balance is hidden by design → a surprise wall, not a countdown; and the "top up" message can dead-end if there's no in-context purchase path.

## What already exists (do NOT rebuild)

**Billing IS wired end-to-end.** Do not confuse this with "usage-not-wired" (next). The edge `model_meter.ts` cron reads each managed OpenRouter key's cumulative spend, **debits the new spend WITH MARKUP to the org's Autumn `credits` pool** (exactly-once, persist-before-track), and **halts the org at ≤0** (pushing the markup-correct OR cap so total spend can't exceed the prepaid balance). Compute is metered the same way via `autumn_meter.ts`. So OpenRouter token spend **is** charged to the org's balance — verified live (`$0.226` debit on the token-billing rollout). We are not leaking free tokens (for `autumn` orgs; see the legacy caveat under Open Questions).

**The UI is largely built too** (`web/src/pages/Billing.tsx`): one-off top-up (`autumnTopup(credits)` + confirm dialog), **auto-top-up** (`AutoTopupCard`: enable + "when balance < threshold" + recharge quantity, incl. first-recharge card setup), compute usage (`getSandboxUsage`), invoices, promo codes, upgrade-to-pro. Schema `AutumnAutoTopup = {enabled, threshold, quantity}`.

So this is **narrow gap-fill, not a build.**

### "usage-not-wired" is a DIFFERENT layer (NOT a billing hole)

sessions-api `usage-not-wired`: the per-session `session.usage` (tokens / `active_seconds`) and per-turn cost are **not captured** — the runtime's `agent.result` (which carries input/output tokens + `total_cost_usd`) isn't rolled into `session_turns`/`sessions`. Consequences: `limits.tokens` is a no-op, and we can't show **per-session / per-agent** model spend. **The money is still metered correctly** at the org/OR-key level (edge `model_meter` → Autumn); what's missing is *attribution/visibility inside the sessions product.* This is exactly what blocks the "for what" breakdown in the target UI — capturing `agent.result` → `session_turns` is a **prerequisite** for per-agent usage (and re-enables `limits.tokens`).

## Gaps vs the target

1. **Model/token usage + remaining is not surfaced** — the model pool is effectively hidden; users can't see the countdown before the 402. (Org balance/remaining is available from Autumn today; it's just not shown.)
2. **No unified "what did I spend on" breakdown** — compute vs model, and within model per-model / per-agent. **Per-agent/per-session model attribution is blocked on the `usage-not-wired` fix** (capture `agent.result` → `session_turns`); org-level totals are available from Autumn now.
3. **Auto-top-up has no monthly cap** — the card is built (enable + threshold + recharge amount); the missing piece is the "never auto-charge more than $Z/month" ceiling (schema is `{enabled, threshold, quantity}` — no monthly limit) + notify on cap hit.
4. **Discoverability** — managed-sessions users live in the sessions product; the OC dashboard Billing page may be off their path.
5. **Dead-end exhaustion path** — the runtime "run out of model credits, top up" message has no in-context link to the (existing) top-up flow. **This is the highest-value user-facing fix** and needs no new UI, just wiring.

## Target UX (industry-standard, one surface)

- **Balance** — remaining credits with a **low-balance banner** (e.g. < ~20% or < N turns).
- **Usage this cycle** — total spend + breakdown: **compute** (GB-s / sandbox-hours) and **model** ($/tokens **by model** and **by agent**), as a small chart + table.
- **One-off top-up** — pick/enter amount → Autumn checkout → credits land (exists; surface it clearly).
- **Auto-top-up** — "when balance < $X, add $Y", **plus a monthly cap** ("don't auto-charge more than $Z/mo") + notify when the cap is hit (net-new: the monthly ceiling).
- **Payment method + invoices** — exists.

## Quick wins to pair (ship first — cheap, high-leverage)

- **Flip the default model off opus** → sonnet or haiku; keep opus opt-in per agent. Biggest lever on burn (kills most of the 88%). *Product call: is opus the intended flagship default (cost) or a cheaper model (reach)?*
- **Set a sane default model-credit grant** for new/personal orgs.
- **Make the runtime "out of credits" message link to top-up** (actionable, not a dead-end).

## Data sources

- **Model spend** — `api-edge/model_meter.ts` (OpenRouter → Autumn `credits`); per-model / per-agent attribution needs the debit tagged with model + agent/session (feasibility TBD — does the meter carry it today?).
- **Compute** — `autumn_meter.ts` (GB-s) / `getSandboxUsage`.
- **Balance / ledger / top-up / auto-recharge** — Autumn (`getAutumnCustomer().balances.credits.remaining`, `autumnTopup`, `setAutumnAutoTopup`).

## Open questions / decisions

1. **One balance or two?** Compute + model share one Autumn `credits` pool today. Keep one balance but show a spend **breakdown** (recommended), or split into two visible pools?
2. **Model attribution granularity** — per-agent + per-model requires tagging `model_meter` debits with agent/session. What's feasible without heavy rework?
3. **Hidden vs visible** — reverse the "hidden by design" stance to always-visible usage + low-balance warning (industry standard), or "invisible until low"? Recommend visible.
4. **Monthly-cap semantics** — hard stop (halt at cap) vs soft (notify, keep running)? How it composes with auto-top-up's own cap.
5. **Default model** — the product cost/quality call above.
6. **Grant + provider policy** — `model_meter` only meters/caps **autumn** orgs; non-autumn orgs run on a FIXED OpenRouter key (not capped). So managed billing applies to autumn orgs; personal/free orgs' managed-model access + grant policy needs defining ("top-up = move the org to autumn + grant credits", per `model_meter.ts`).
7. **Where it lives** — the OC dashboard Billing page (exists) + a compact usage/top-up widget inside the sessions product?

## Sequencing (slices)

- **S0 (today, cheap):** default model off opus + sane grant + link the exhaustion message to top-up. Removes most of the pain immediately.
- **S1 (FIRST BUILD):** clear path when credits run out — exhaustion CTA + low-balance banner + fast un-halt on top-up. **Full implementer-ready spec below.**
- **S2:** surface model usage + remaining on the Billing page; usage breakdown (compute vs model; by model; by agent — needs `usage-not-wired`).
- **S3:** auto-top-up **monthly cap** UX.
- **S4:** in-context (sessions product) usage widget + top-up CTA.

## Slice 1 (FIRST — implementer-ready): a clear path when model credits run out

**Highest value, no new billing UI** — wire the *existing* top-up flow into the two moments a user
needs it: when a turn dies on credits, and just before it does. Spans two repos.

### Scope
- **1a — Actionable exhaustion CTA** (turn already failed on credits).
- **1b — Low-balance banner** (proactive, before the wall).
- **1c — Fast un-halt on top-up** (so recovery is immediate, not next-cron). ← the real UX risk; do not skip.

Explicitly **out of scope**: per-agent/model attribution (needs `usage-not-wired`), the monthly
auto-top-up cap, and the full usage-breakdown UI. Those are S2–S4.

### 1a — Actionable exhaustion CTA
- **Signal already exists**, no runtime change needed: on a 402/credit error the runtime posts an
  `error.runtime` event with `body.code = "insufficient_credits"` (`sessions-api
  runtimes/v3-claude/src/adapter.ts`, the `isCreditError` branch) alongside the user-facing
  "run out of model credits, top up" `agent.message`.
- **Client change (opencomputer dashboard):** in the session/chat view
  (`web/src/pages/SessionDetail*` — *confirm exact component + event renderer*), when the event
  stream contains `error.runtime` with `code === "insufficient_credits"`, render an inline
  **"Top up credits →"** button that deep-links to the Billing top-up (route from `Billing.tsx`,
  *confirm route*; optionally pre-fill an amount). Client keys off the event `code` — the runtime
  stays provider-agnostic and knows nothing about dashboard routes.
- **Copy:** leave the runtime message as-is; the CTA is client chrome.

### 1b — Low-balance banner
- **Data:** org model-credit remaining from Autumn — `getAutumnCustomer().balances.credits.remaining`
  (edge) surfaced via `getAutumnBilling` (*confirm `AutumnBilling` exposes credits-remaining; if
  not, add the field to the billing response*).
- **Trigger:** `remaining < THRESHOLD`. Start simple — a fixed `$5` (env/config), refine later to
  "~N opus turns" once per-turn cost is known.
- **Surface:** a dismissible banner in the sessions view (and/or global dashboard) — *"Model credits
  low ($X left). Top up →"* — reusing the existing free-trial "credits exhausted — upgrade" banner
  pattern in `Billing.tsx` for visual consistency.
- **Scope guard:** managed (`billing_provider === "autumn"`) orgs only. BYO / legacy orgs have no
  credit pool — no banner.

### 1c — Fast un-halt on top-up (don't skip)
At ≤0 the edge `model_meter` **halts** the org (`projectOrg`) and pushes the OR key cap to ~0. After
a top-up the org must recover **promptly**, not on the next meter-cron tick. Wire the Autumn
credit-grant/top-up webhook (`api-edge/src/autumn_webhook`) to **re-project caps immediately** on a
balance increase (push the markup-correct OR cap off the new `remaining`, mirroring `pushCaps`).
*Confirm current behavior first* — if a top-up already re-projects synchronously, 1c is a no-op;
if it waits on the cron, that stale window is the top-up-then-still-stuck bug and must be fixed here.

### Acceptance criteria
1. A session that hits `insufficient_credits` renders a working "Top up →" CTA that lands on the
   Billing top-up.
2. When `remaining < THRESHOLD`, the low-balance banner shows in the sessions view (autumn orgs only).
3. After a successful top-up, the org un-halts and the same session accepts a new message **within
   seconds** (not on the cron), verified end-to-end (drive it: exhaust → top-up → re-message).
4. Non-autumn / BYO orgs see neither banner nor CTA.

### Touch points
- sessions-api: `runtimes/v3-claude/src/adapter.ts` (signal — already emits; no change unless we add
  `body.remediation:"topup"` for richer rendering — optional).
- opencomputer web: `SessionDetail*` (CTA), a low-balance banner component, `api/client.ts`
  `getAutumnBilling` (+ remaining field if missing), `Billing.tsx` top-up route.
- opencomputer edge: `api-edge/src/autumn_webhook` + `model_meter` `pushCaps` (immediate re-project
  on top-up).

## Appendix — evidence (2026-07-02)

- `error_class='credits_exhausted'` classifier: `credits exhausted | insufficient credit | top up | 402` (sessions-api `core/turns.ts`).
- Managed default model `anthropic/claude-opus-4-8`; 620/~690 sessions (14d) on opus.
- Credit-exhausted sessions (mo `aaf3bf60`, 07-02) ran opus.
- Halt at ≤0 balance: `model_meter.ts` (`remaining <= 0` → `projectOrg` halt), mirrors `autumn_meter`.
