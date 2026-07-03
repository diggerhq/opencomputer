# Out-of-credits UX — unmissable state + fail-early on credit-gated ops

Status: active (draft)
Last updated: 2026-07-03
Owns: the out-of-credits FAILURE experience — proactive clarity + preflight early-fail. Refines Slice 1 of [`billing-usage-and-topup.md`](./billing-usage-and-topup.md) (which owns the broader billing/usage/top-up surface).
Supersedes: —
Implementation: `web/src/components/app-shell.tsx` (+ session views) · `cloudflare-workers/api-edge/src/index.ts` · sessions-api runtime provision/accept + fallback classifier
Public docs: —

## Trigger

2026-07-03: a halted autumn org (free plan, balance ≤ 0, `is_halted=1`). Every turn failed at sandbox provision with a deep `402 {"error":"credits exhausted — top up to resume"}`, retried ~6× via `runtime.fallback`, and surfaced as a generic runtime error. Two problems flagged:

- **Not unmissable.** The halted state isn't unavoidably in the user's face at the moment they act.
- **Fails late + opaque.** An op we KNOW can't succeed (org halted / balance ≤ 0) still runs deep into provisioning before dying — and then loops on a terminal 402.

## What already exists (do NOT rebuild)

- **`HaltBanner`** (`web/src/components/app-shell.tsx:247`): polls `getAutumnBilling` (`isHalted`), renders a top-of-content "you're out of prepaid credits — top up" banner on every page except `/billing`. Autumn orgs only (legacy 404s → no banner).
- **Edge halt-gates** on some paths: session create (`index.ts:~443`, with a self-heal re-check) and wake (`~859`) return early when `is_halted`.
- **Runtime credit signal:** on a 402 the runtime posts `error.runtime {code:"insufficient_credits"}` + a user message, classified `credits_exhausted`.
- **Billing top-up UI** (`web/src/pages/Billing.tsx`) + billing doc **Slice 1** (reactive exhaustion CTA, low-balance banner, fast un-halt).

This is **gap-fill on top of those**, in two parts.

## Part A — Make "out of credits" unmissable, where the user acts

The banner exists but is a thin top strip and is passive (it doesn't touch the control the user is about to click).

1. **Raise prominence** of the *halted* state (distinct from Slice 1b's low-balance banner): stronger treatment (icon + emphasis/destructive color, not the muted `pending` style) and **sticky** at the top of the content area so it stays visible while scrolling. Keep the top-up CTA.
2. **Cover the moment of action** (see Part B3): show the halted state inline at the composer / "New session" / "Run", not only as a page-top strip — a user who never scrolls up still can't miss it.
3. **Verify it's live:** the banner polls every 30s; after Part B's fast un-halt (Slice 1c) confirm `isHalted` flips within the poll window post-top-up.

No new data needed — `getAutumnBilling.isHalted` / `creditsRemainingCents` already exist.

## Part B — Fail credit-gated ops EARLY and CLEARLY

Principle: **if we know an operation can't succeed, refuse it at the boundary with a specific message — never let it run deep and die generic.**

1. **Preflight the halt on the v3 turn/session path.** The failing trace shows the turn reaching `sandbox.ensure` → deep `402` with no halt check first (unlike the edge create/wake gates). Add a preflight halt check on session-create / turn-accept / provision so a halted org yields an immediate typed terminal `insufficient_credits` — no sandbox attempt. Mirror the existing edge gates (`index.ts:443/859`).
2. **Classify 402-credits as terminal — kill the fallback loop.** `runtime.fallback` retried the 402 ~6×; that last-known-good-runtime fallback is for **missing snapshots** (infra), not billing. A `402 credits exhausted` must be terminal-non-retriable → stop after one and emit the clean `insufficient_credits` signal. Cheap, and it de-noises telemetry (these log as `provision` errors today).
3. **Gate the UI controls.** When `isHalted`, disable/replace the credit-gated affordances — "New session", the composer's send, "Run" — with an inline "Out of credits — top up to resume →" (reusing the halted state + Slice 1a's CTA). The user shouldn't be able to fire an op we know will fail; if they do (race / API user), the B1 preflight returns the same typed error and the client renders the same CTA.

**Credit-gated = anything that provisions compute or spends managed model credits:** create session, send message / start a turn, create/wake a sandbox. Read-only views (history, billing, settings) stay open.

## Which changes where

| Area | File | Change |
|---|---|---|
| Dashboard shell | `web/src/components/app-shell.tsx` (`HaltBanner`) | stronger + sticky treatment; keep CTA (A1) |
| Dashboard sessions | `web/src/pages/Sessions*.tsx` / `SessionDetail*` + composer | inline halted state at the action; disable send/new/run when `isHalted` (A2 + B3) |
| Dashboard client | `web/src/api/client.ts` | no data change (`getAutumnBilling` suffices); render the preflight `insufficient_credits` error inline (ties to Slice 1a) |
| Edge | `cloudflare-workers/api-edge/src/index.ts` | preflight `is_halted` on the v3 turn/session-create path — extend the `:443`/`:859` pattern to every credit-gated route it fronts |
| Runtime / sessions-api | provision/accept path + fallback classifier | preflight halt → terminal `insufficient_credits`; classify `402 credits` as terminal (no `runtime.fallback` retry) |

## How it works (flow)

1. Balance ≤ 0 → edge `model_meter` halts the org (`is_halted=1`) — existing.
2. Dashboard reads `isHalted` → **sticky halted banner** + **credit-gated controls disabled with an inline top-up CTA** (Parts A + B3).
3. If a credit-gated request still arrives (API/SDK user, or a UI race), the **preflight** returns a typed terminal `insufficient_credits` immediately — no sandbox spin-up, no fallback loop (B1/B2).
4. Top-up → Autumn credits land → fast un-halt (Slice 1c) → `is_halted` flips → banner clears + controls re-enable within the poll window.

## Relationship to billing-usage-and-topup.md

Refines **Slice 1** ("clear path when credits run out"): adds (A) the *unmissable/sticky* halted state + control-gating and (B) *preflight* early-fail + terminal-402 classification — the "fail before it starts" half that Slice 1a (reactive CTA after a failure) doesn't cover. Deferred to the billing doc: usage/remaining breakdown (S2), monthly auto-top-up cap (S3), per-agent attribution (needs `usage-not-wired`).

## Open questions

1. **Preflight choke point** — edge (earliest; fronts the API) vs sessions-api turn-accept (authoritative for the turn) vs both.
2. **Exact credit-gated route list** — confirm every provisioning entry (create session, message/steer→turn, sandbox create/wake) is covered; don't gate read-only routes.
3. **SDK/API users** (no dashboard) — the typed `insufficient_credits` 402 is their only signal; make its body actionable (message + a "top up" link/remediation hint).
4. **Prominence bar** — sticky banner + control-gating (recommended) vs a full blocking interstitial when fully halted.
