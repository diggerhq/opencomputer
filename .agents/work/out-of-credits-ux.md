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

Two facts that shape the design (verified against the deployed topology):

- **The public `/v3` API does NOT go through the CF edge.** `api.opencomputer.dev` is
  sessions-api direct (Fly); only dashboard traffic and the sandbox API ride the edge.
  So the existing edge halt-gates (`index.ts:443/859`) can never be the authoritative
  check — an SDK/API user bypasses them entirely. Authority has to live in sessions-api.
- **sessions-api has no local halt state, and shouldn't buy one with a per-turn
  cross-service read.** The halt lives in the edge D1 / Autumn. A synchronous preflight
  against either adds a network hop to EVERY turn to save one doomed provision attempt
  on the rare halted org — wrong trade.

The resolution: **the provision 402 IS the preflight — remember it.**

1. **Classify 402-credits at provision as TERMINAL — kill the fallback loop.** The
   last-known-good-runtime fallback exists for missing/corrupt snapshots (infra);
   `402 credits exhausted` is org-level — no build in the ladder can succeed. One
   attempt → typed terminal `insufficient_credits` + ONE clean user-facing message
   (reuse the runtime's existing `insufficient_credits` event shape so the dashboard
   already knows how to render it). De-noises telemetry too (today these log ~6× as
   generic `provision` errors).
2. **Halt memo (fail-fast without new coupling).** When any credit-gated op hits a
   402-credits, sessions-api memoizes `halted_until` for the org (in-process or a
   session-row-adjacent note, TTL ~60s, cleared by any successful provision). While the
   memo is live: session-create and message-append return a **synchronous typed 402**
   (`{error:{type:"insufficient_credits", message, top_up_url}}`) and turn-accept
   parks instead of provisioning. First doomed op pays one provision round-trip;
   everything after fails instantly; top-up self-heals via TTL — zero new cross-service
   reads, no config, no sync job.
3. **Gate the UI controls.** When `isHalted`, disable/replace the credit-gated
   affordances — "New session", the composer's send, "Run" — with an inline "Out of
   credits — top up to resume →" (reusing the halted state + Slice 1a's CTA). If a
   request fires anyway (race / API user), B2's memo returns the same typed error and
   the client renders the same CTA.
4. **Decide the input's fate: park-and-resume (recommended) over consume-and-fail.**
   When a turn dies on provision-402, the user's message never ran. If the turn
   consumes the input (the model-402 path's anti-spam behavior), the user must RESEND
   after topping up. Better: leave the input window unconsumed, suppress re-fires with
   the halt memo, and on un-halt (Slice 1c's hook) re-kick sessions with pending
   input — "top up and your agent picks up where you left off" is exactly the durable-
   sessions promise, and it falls out of machinery that already exists (wakeups +
   input cursor). The model-call-402 mid-turn keeps today's consume behavior (the turn
   DID run and answered with the credit notice).

**Credit-gated = anything that provisions compute or spends managed model credits:**
create session, send message / start a turn (including watch-delivery wakeups — a
watched PR event on a halted org must park, not loop), create/wake a sandbox. Read-only
views (history, billing, settings) stay open.

## Which changes where

| Area | File | Change |
|---|---|---|
| Dashboard shell | `web/src/components/app-shell.tsx` (`HaltBanner`) | stronger + sticky treatment; keep CTA (A1) |
| Dashboard sessions | `web/src/pages/Sessions*.tsx` / `SessionDetail*` + composer | inline halted state at the action; disable send/new/run when `isHalted` (A2 + B3) |
| Dashboard client | `web/src/api/client.ts` | no data change (`getAutumnBilling` suffices); render the typed `insufficient_credits` error inline (ties to Slice 1a) |
| Edge | `cloudflare-workers/api-edge/src/index.ts` | keep the existing `:443`/`:859` gates as the dashboard-path fast refusal; nothing new — the edge is NOT the authority (public /v3 bypasses it) |
| sessions-api | provision fallback classifier + accept + create/messages routes | 402-credits terminal (no `runtime.fallback` retry, one clean user event); halt memo → sync typed 402 on create/messages + park at accept; un-halt re-kick of parked input |

## How it works (flow)

1. Balance ≤ 0 → edge `model_meter` halts the org (`is_halted=1`) — existing.
2. Dashboard reads `isHalted` → **sticky halted banner** + **credit-gated controls disabled with an inline top-up CTA** (Parts A + B3).
3. If a credit-gated request still arrives (API/SDK user, or a UI race), the FIRST one pays a single provision attempt and dies typed + terminal (B1); the halt memo then makes every subsequent create/message fail **synchronously** with the same typed 402 (B2). Pending input parks — no retry loop, nothing lost (B4).
4. Top-up → Autumn credits land → fast un-halt (Slice 1c) → `is_halted` flips → banner clears + controls re-enable within the poll window → parked sessions re-kick and resume the turn the user already asked for.

## Relationship to billing-usage-and-topup.md

Refines **Slice 1** ("clear path when credits run out"): adds (A) the *unmissable/sticky* halted state + control-gating and (B) *preflight* early-fail + terminal-402 classification — the "fail before it starts" half that Slice 1a (reactive CTA after a failure) doesn't cover. Deferred to the billing doc: usage/remaining breakdown (S2), monthly auto-top-up cap (S3), per-agent attribution (needs `usage-not-wired`).

## Open questions (1–3 resolved in Part B, kept for the record)

1. **Preflight choke point — RESOLVED: sessions-api, via the 402 memo.** The edge can't
   be the authority (public `/v3` is direct-to-Fly and bypasses it); a synchronous
   cross-service halt check on every turn is the wrong trade. The memo gives fail-fast
   authority to sessions-api with zero new coupling; the existing edge gates stay as a
   dashboard-path nicety.
2. **Credit-gated route list — RESOLVED:** `POST /v3/sessions`,
   `POST /v3/sessions/:id/messages` (and anything else that kicks a turn — watch
   deliveries included, at accept), sandbox create/wake (edge-owned). Read-only routes
   untouched.
3. **SDK/API users — RESOLVED:** the sync 402 body is
   `{error:{type:"insufficient_credits", message:"Out of prepaid credits — top up to
   resume.", top_up_url}}`; same shape from the memo path and the terminal turn event,
   so one client rendering covers both.
4. **Prominence bar** — sticky banner + control-gating (recommended) vs a full blocking
   interstitial when fully halted. Lean: no interstitial — read-only use (reviewing
   past sessions, billing) must stay frictionless; the gated controls ARE the block
   where it matters.
5. **NEW — memo storage:** in-process Map (dies on deploy — fine, TTL 60s) vs a column.
   Lean: in-process; the cost of a miss is one extra doomed provision attempt.
