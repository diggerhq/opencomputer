# Managed keys for everyone — decouple Managed from billing

Status: **Slice 1 implemented (2026-06-29); Slice 2 pending.** Builds on the shipped
Managed work (`token-billing.md`, PRs #445 + sessions-api #34). Governing principle:
`oc-bg-agents/.agents/conventions/shift-left-over-feature-flags.md`.

## 1. Objective

**Enable Managed model keys for every org and delete the conditional enablement.**
Today Managed is forked along the billing axis and gated per org; we make Managed and
billing **orthogonal**. The OpenRouter key's native spend `limit` becomes the hard
ceiling; billing (metering) becomes a best-effort accounting layer *on top*, not a
precondition for the feature to work. When an org's budget runs out the key simply
stops working — they tell us, and we **move them to Autumn billing + grant new
credits**. That conversation *is* the upgrade funnel, not a code fork.

## 2. Why (principle)

This is the shift-left / de-fork move applied one level up from the snapshot fix. A
per-provider refusal + a per-org `model_billing_status` gate = two runtime behaviors
that drift and a standing "for whom is it on?" question (today: **1 org on, 480 off**).
Ship **one** Managed path for everyone; make billing independent and best-effort. No
gradual rollout, no flag — one cutover.

## 3. Current coupling (what we remove)

Managed is welded to the Autumn billing provider in four places:

1. **Provisioning refuses non-autumn** — `model_billing.ts:288`
   (`if (org.billing_provider !== "autumn") throw … "refusing"`).
2. **Budget is sourced from credits** — at mint, `limitUsd = initialCapUsd(remainingCreditsUsd, markup)` (`model_billing.ts:318–320`).
3. **Cap is re-synced to credits every tick** — `pushCaps` PATCHes the key limit to `remaining/(1+markup)` (`model_meter.ts:158–196`).
4. **Org is halted on model spend** — at `remaining <= 0`, `projectOrg` hibernates the org's boxes (`model_meter.ts:102–105`).

Plus visibility gate: `managedAvailable = (model_billing_status === 'active')`
(`dashboard.ts`). Net effect: the metering loop keys off `managed_model_keys` rows,
which only exist for autumn orgs, so non-autumn orgs can't be metered, halted, or even
provisioned.

**Data (prod, 2026-06-29):** `billing_provider` = legacy **454** / autumn **28**. Real
customers (pro + active Stripe sub): **33 on legacy** (all `model_billing_status=off`),
**2 on autumn**. So Managed structurally cannot serve the paying base today.

## 4. Target design

- **Provision Managed for ANY org.** Drop the `billing_provider` refusal. The OR key is
  minted with a **fixed default budget** (config) for non-autumn orgs; credits-derived
  for autumn (unchanged). The bind-to-sessions-api step is already provider-agnostic.
- **OR key `limit` is the hard ceiling.** OpenRouter enforces it. Exhaustion → 402 on
  model calls → Managed stops; the **sandbox and BYO keep running**. No org halt on
  model spend.
- **Metering = best-effort accounting.** Debit Autumn credits only where there's an
  Autumn customer (autumn orgs, as today). For non-autumn: skip — optionally record
  per-key OR usage for manual reconcile. Exposure is bounded by the fixed budget.
- **Visibility decoupled from provider.** `managedAvailable` no longer depends on
  `billing_provider`; Managed is offered to all (provisioned for all, or on first use).
- **Upgrade funnel = the runout path.** Budget exhausted → customer pings us → we move
  them to Autumn (`autumnSetProviderInternal`) + grant credits; their key budget then
  tracks credits as today. Sales motion, not a fork.

## 5. What fails when decoupled — deliberately, "not much"

- We don't **auto-bill** non-autumn Managed usage. Exposure = the fixed budget per org
  (a number we choose); reconcile manually / "they tell us." Acceptable, bounded.
- No **auto-halt**; the key limit is the ceiling. A billing gap can no longer break
  Managed, and Managed runout can no longer hibernate an org's compute. **No
  cross-aspect leakage** — the whole point.
- Everything else (provision → bind → use → cap-enforce) is unchanged and already
  provider-agnostic.

## 6. Implementation plan (contained to the edge)

- **`model_billing.ts`**
  - Remove the `billing_provider !== "autumn"` refusal (`:288`).
  - Mint with `budgetFor(org)`: autumn → `initialCapUsd(remaining, markup)` (today);
    non-autumn → fixed `MANAGED_DEFAULT_BUDGET_USD` / per-org override.
    *(Required — `remainingCreditsUsd` is 0 for non-autumn → would mint a dead $0 key.)*
- **`model_meter.ts`**
  - `meterOrg`/`debitKey`: skip the Autumn track for orgs with no Autumn customer
    (else it errors); accounting runs only where there's something to debit.
  - Halt (`:102–105`): stop calling `projectOrg` on model spend (decide whether to drop
    it for autumn too — see §8).
  - `pushCaps`: run the credit-headroom shrink only for autumn; non-autumn keeps its
    static fixed budget (don't collapse the cap to their zero credits).
- **Config / schema**: `MANAGED_DEFAULT_BUDGET_USD`; optional `managed_budget_micro`
  per-org column for overrides + top-ups. Top-up is already `patchOrKey({limitUsd})`.
- **`dashboard.ts`**: `managedAvailable` independent of `billing_provider`.
- **sessions-api**: verify managed-credential resolution has no provider check
  (expected: none — it binds/resolves a credential by id).
- **Tests**: extend `model_billing.test.ts` / `model_meter.test.ts` — non-autumn
  provisions, isn't debited/halted, budget caps spend; `managedAvailable` for non-autumn.

## 7. Decisions

- **Default budget = `$10`** per org (`MANAGED_DEFAULT_BUDGET_USD`). Our prepaid exposure
  per non-autumn org; deliberately small.
- **KEEP the org-halt-on-credit-runout for Autumn orgs.** (Corrected — earlier draft
  said remove it.) For autumn, model + compute share one credit pool; hitting 0 → halt
  → top-up is the *intended billing nudge*, unrelated to decoupling. What the decoupling
  does instead: **fence the meter so it never touches non-autumn orgs** — no debit, no
  halt, no credit-derived cap. This is a *required correctness fix*, not optional: as
  written, a provisioned non-autumn org would hit `model_meter.ts:99–105` with no Autumn
  customer → `remaining` defaults to `0` → it would **wrongly halt** the org. Gate the
  whole debit/halt/cap block on `billing_provider === 'autumn'` (mirrors
  `autumn_meter.ts:61`).
- **Global config first** for the budget; add a per-org `managed_budget` column only when
  top-ups need to differ.
- **Enablement = provision-on-first-use** (lazy), Managed offered to all in the UI — that's
  what actually removes the per-org conditional enablement (vs pre-minting 482 keys).
  Slice 2 below.

## 7b. Slices

- **Slice 1 (decouple + make safe) — DONE:** dropped the `billing_provider` refusal
  (`model_billing.ts`); `budgetFor` mints non-autumn keys at the fixed `$10` budget
  (`MANAGED_DEFAULT_BUDGET_USD`); fenced the meter (debit/halt/cap) to autumn-only
  (`model_meter.ts` early-return). Tests updated + non-autumn cases added (21/21 green,
  tsc clean). After this, *any* org can be enabled with bounded exposure and zero
  wrongful halts. *Still requires the per-org enable step — that's Slice 2.*
- **Slice 2 (remove per-org enablement):** provision-on-first-use so Managed "just works"
  for any org with no operator action, and surface it to all in the UI. One UX seam to
  settle: provision when the user selects Managed, or silently on the first Managed turn.

## 8. Non-goals

- **Not** building a Managed-on-Stripe metering path (a second billing backend = the
  sprawl we're removing).
- **Not** gating Managed per provider or behind a flag.
- **Not** blocking on a full legacy→autumn *compute*-billing migration — Managed no
  longer needs it. (That migration may still happen for compute, separately.)

## 9. Rollout

One cutover: ship the decoupled path, provision for all, remove the
`model_billing_status` conditional. No gradual ramp (see §2).
