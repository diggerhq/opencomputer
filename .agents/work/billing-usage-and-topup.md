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

`web/src/pages/Billing.tsx` already wires: `autumnTopup` (one-off top-up), `setAutumnAutoTopup` (auto-recharge), `getSandboxUsage` (compute), `getAutumnBilling` (plan/credits), an invoices tab, promo codes, and upgrade-to-pro. Autumn is the credit ledger; `model_meter`/`autumn_meter` debit model/compute spend into it and halt at ≤0.

So **top-up, auto-top-up, compute usage, and invoices already exist.** The work is *consolidation + gap-fill*, not greenfield. (Verify the exact capabilities/signatures of `autumnTopup`/`setAutumnAutoTopup` during build.)

## Gaps vs the target

1. **Model/token usage + remaining is not surfaced** — the hidden pool; users can't see the countdown before the 402.
2. **No unified "what did I spend on" breakdown** — compute vs model, and within model per-model / per-agent.
3. **Auto-top-up lacks a monthly spend cap** — the industry-standard "auto-recharge, but never more than $Z/month" guardrail (verify current `setAutumnAutoTopup` shape; likely no monthly ceiling).
4. **Discoverability** — managed-sessions users live in the sessions product; the OC dashboard Billing page may be off their path.
5. **Dead-end exhaustion message** — the runtime "top up" text has no in-context CTA.

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
- **S1:** surface model usage + remaining balance on the Billing page + low-balance banner.
- **S2:** usage breakdown (compute vs model; by model; by agent if attribution feasible).
- **S3:** auto-top-up **monthly cap** UX.
- **S4:** in-context (sessions product) usage widget + top-up CTA.

## Appendix — evidence (2026-07-02)

- `error_class='credits_exhausted'` classifier: `credits exhausted | insufficient credit | top up | 402` (sessions-api `core/turns.ts`).
- Managed default model `anthropic/claude-opus-4-8`; 620/~690 sessions (14d) on opus.
- Credit-exhausted sessions (mo `aaf3bf60`, 07-02) ran opus.
- Halt at ≤0 balance: `model_meter.ts` (`remaining <= 0` → `projectOrg` halt), mirrors `autumn_meter`.
