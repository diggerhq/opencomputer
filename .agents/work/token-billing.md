# Token / model-usage billing — design

Status: **design, ready for review.** Architecture decided (OpenRouter-native +
Autumn shared credit pool). This doc is written so a reviewer can flag holes and
an implementer can build it without further questions. Decisions that could cause
debate are spec'd explicitly in §9.

---

## 1. Decision summary

Bill a customer org for the LLM tokens its agent sessions consume, **out of the
same Autumn `credits` pool we already use for compute** (one balance, one $5 free
grant, one top-up flow, one halt). We do **not** build a metering proxy, a rate
card, or a token counter. The split of responsibility:

- **Egress proxy** (existing, `internal/secretsproxy/proxy.go`) — **security
  only.** Keeps the real model key out of the sandbox; swaps the sealed
  placeholder for the real key in-flight on outbound HTTPS. Unchanged mechanism;
  we just allowlist `openrouter.ai` and seal an **OpenRouter** key instead of a
  raw provider key. It does **not** count or limit.
- **OpenRouter (OR)** — **counting + limiting + cost source of truth.** Each
  managed org gets its own OR API key, provisioned by us, whose **spend limit is
  the hard budget cap**. OR meters real spend per key; we read it. No rate card:
  OR returns actual provider cost.
- **Autumn** — the **single shared credit pool** (compute + tokens). Tokens debit
  the same `credits` ledger; the existing halt / top-up / "out of credits" banner
  cover tokens for free.
- **OC glue** — provision the per-org OR key, and run one **sync cron** that
  (pull) reads OR spend → debits Autumn, and (push) sets the OR key cap =
  remaining shared credits. That's the whole integration: a key lifecycle + a
  cron. No new billing pipeline, no second balance.

**Locked decisions** (rationale in §9): single shared pool; OR does
counting+limiting (we don't tally tokens / keep no rate card); egress proxy
retained for key protection; **managed-only** billing (BYO bypasses); applies to
`billing_provider='autumn'` orgs only. **Managed is surfaced as one entry in the
existing credential picker** (`credential: "managed"`, set per agent), org default
Managed, Credentials page unchanged, **no** managed-config page, "OpenRouter"
never user-visible (full contract §6.6, decision §9.8).

**Genuine open forks left to product** (§9/§12): at-cost vs markup; per-org vs
per-session OR keys; sync cadence; BYO-via-OR vs BYO-direct; the cross-service
seam for OR-key provisioning (§9.5, recommendation given).

---

## 2. Background: how compute billing works today (the thing we extend)

Verified against the **live** Autumn account (read 2026-06-29) and the edge code.

- **Unit: credits, 1 credit = $1.** (`top_up` product prices `credits` at
  `{amount:1, billing_method:"prepaid"}` → "$1 per credit".)
- **`credits` is an Autumn `credit_system`** = one shared prepaid balance per org.
  It carries a `credit_schema` mapping each metered feature → per-unit
  `credit_cost`. Compute is 6 metered features `compute_1gb…compute_64gb`, priced
  linearly in RAM: `compute_1gb` = `1.667e-5` credits per GB-second
  (= **$0.06/GB-hour**), scaling ×GB up to `compute_64gb` = `1.067e-3` (= $3.84/GB-hr).
- **Products (live):** `base` (auto-enabled, grants `credits: included 5` one_off
  = the **$5 free signup**); `top_up` ($1/credit prepaid, drives top-up +
  auto-recharge); `concurrency_pro` / `concurrency_plus` / `concurrency_plus_plus`
  = **$150 / $500 / $1,000 per-month** add-ons that only raise the concurrency
  ceiling (no metered items).
- **Compute meter** = an edge cron, `cloudflare-workers/api-edge/src/autumn_meter.ts`
  (`*/5`). Per Autumn org it aggregates sandbox-seconds per memory tier from D1
  `usage_samples`, `POST /track`s each `compute_Ngb` feature, and advances a D1
  watermark `orgs.autumn_usage_watermark` (idempotency = unique key per bucket).
  Autumn's `credit_schema` auto-debits `credits`.
- **Billing provider switch** = `orgs.billing_provider ∈ {legacy, autumn}`
  (migration 047; **D1 is authoritative**, cell-PG mirrors via cap-token).
  `legacy` = in-house Stripe pipeline; `autumn` = Autumn owns the ledger.
  `AUTUMN_NEW_ORGS` env flag routes new signups to Autumn (not yet set).
- **Halt:** Autumn credits ≤ 0 → edge `projectOrg` sets `orgs.is_halted` and
  dispatches `/admin/halt-org` to cells (hibernate boxes, 402 new work); top-up
  resumes. **Autumn integration is entirely edge-native** — the Go cell holds no
  Autumn client; only `api-edge` talks to Autumn (`autumn_webhook.ts`,
  `autumn_meter.ts`, `dashboard.ts`).
- **Dashboard:** `web/src/pages/Billing.tsx` already renders the Autumn view
  (`PrepaidPlan`): balance, $5/$25/$100 top-up, auto-top-up, concurrency tiers,
  per-sandbox usage table — gated on `billingProvider === 'autumn'`.

Token billing reuses all of this and adds exactly one new consumer of the pool.

---

## 3. Roles & invariants (the contract)

1. **One balance.** Token spend debits the same `credits` pool as compute.
   There is never a second customer-facing balance.
2. **OR is the meter and the limiter.** We never count tokens ourselves and keep
   no rate card. OR's per-key `usage` is the cost of record; OR's per-key `limit`
   is the enforced cap.
3. **The cap mirrors the shared pool.** A managed org's OR key `limit` is kept at
   `usage + remaining_credits`, so additional token spend can never exceed the
   org's current prepaid balance (which compute is also draining).
4. **Key never in the sandbox.** The OR key is sealed and swapped by the egress
   proxy, exactly like provider keys today.
5. **Managed-only.** Debits fire only for managed-key sessions. BYO sessions never
   debit (the provider/their-own-OR bills them); we may record usage for display.
6. **Autumn-only.** Token billing applies to `billing_provider='autumn'` orgs.
   `legacy` orgs are unaffected until migrated.
7. **Managed is a picker option, not a new concept.** Users pick Managed or a BYO
   credential in one place; "OpenRouter" is never named to users (§6.6).

---

## 4. Entities & new state

**Org (D1 `orgs`, mirrored to cell-PG only if a cell needs it — it doesn't here):**
- `model_billing_mode TEXT NOT NULL DEFAULT 'off' CHECK (model_billing_mode IN ('off','managed','byo'))`
  — `off` until enabled / non-autumn; `managed` = OC OR key + Autumn debit; `byo` = no debit.
- `or_key_hash TEXT` — the OpenRouter key **hash** (non-secret id) for the org's
  managed inference key. NULL when not managed.
- `or_spend_watermark_micro BIGINT NOT NULL DEFAULT 0` — last-synced OR cumulative
  `usage` for this key, in **micro-USD** (integer; see §7).
- `model_markup_bps INT NOT NULL DEFAULT 0` — markup in basis points applied to OR
  cost before debiting Autumn (0 = at-cost; e.g. 2000 = +20%). Per-org override of
  an env default (§9.2).

**The OpenRouter inference key** (one per managed org): created via the
provisioning API; the **plaintext** is sealed into the org's managed model
credential (existing Infisical-backed credential pipeline); only the `hash` lives
in D1. `limit_reset = null` (lifetime cumulative cap we manage dynamically).

**Autumn — new feature `model_spend`:** a metered feature added to the `credits`
credit_system's `credit_schema` with `credit_cost = 1e-6` (1 unit = 1 micro-credit
= $1e-6). One generic feature, dollar-denominated; **per-model breakdown is NOT in
Autumn** (it goes to ClickHouse, §6.5). Created once via Autumn dashboard/API as a
setup step.

**ClickHouse — new table `model_usage`** (per-model/session detail for the
dashboard; not authoritative for billing): see §6.5.

**Secrets:** new **OpenRouter management key** = a Cloudflare Wrangler secret
`OPENROUTER_PROVISIONING_KEY` on `opencomputer-edge-prod` (and dev), used by the
edge for all OR API calls (provision, read, cap, analytics). Stored the same
write-only way as `AUTUMN_SECRET_KEY`.

---

## 5. Time-axis journeys (what happens at each stage)

### 5.1 Managed enablement (per org, once)
Trigger: org is on `billing_provider='autumn'` and model billing is turned on
(default-on for new autumn orgs, or an explicit toggle).
1. Edge `POST https://openrouter.ai/api/v1/keys` with
   `{ name: "oc-org-<org_id>", limit: <remaining_credits_usd>, limit_reset: null }`
   (auth: `OPENROUTER_PROVISIONING_KEY`). Response → `key` (plaintext, once) +
   `data.hash`.
2. Edge hands the plaintext key to sessions-api over an HMAC internal call
   (§6.3) → sessions-api stores it via the existing **secret-ledger / Infisical**
   pipeline and binds it as the org's **managed model credential**
   (`provider = openrouter`). (Seam decision + alternative in §9.5.)
3. Edge writes `orgs.or_key_hash = data.hash`, `model_billing_mode='managed'`,
   `or_spend_watermark_micro=0`.
Idempotent: if `or_key_hash` already set, skip create (or rotate per §5.8).

### 5.2 Session create
- Agent `model` is an OR-namespaced id (`anthropic/claude-opus-4-8`,
  `openai/gpt-5-codex`) — already our format. Credential resolves to the org's
  managed OR credential (resolution + source taxonomy in §6.6; BYO overrides).
- The credential is **sealed for the session** (existing flow) with
  `base_url = https://openrouter.ai/api/v1`. The runtime gets a placeholder.
- (Per-session-key variant, §9.1: mint a session-scoped OR key here with
  `limit = min(session token budget, remaining_credits)` and store its hash on the
  session instead of using the org key.)

### 5.3 Turn execution (runtime → proxy → OR)
- Runtime calls `openrouter.ai` via the egress proxy, which swaps in the real OR
  key (allowlist `openrouter.ai`). Optionally include `usage: { include: true }`
  in the request for richer inline detail (not required — analytics poll covers
  detail).
- **OR enforces the cap in real time.** If a call would exceed `limit`, OR returns
  `402` / key-disabled; the turn surfaces a credits-exhausted error. This is the
  overshoot guard — provider-enforced, no mid-turn soft-stop to build.
- Spend accrues on the OR key. **We do nothing in-path.**

### 5.4 Sync cron (the glue) — `model_meter` on the edge, every N min (§9.3)
Sibling to `autumn_meter.ts`. For each org with `model_billing_mode='managed'`:
1. **Read OR spend:** `GET /api/v1/keys/{or_key_hash}` → `data.usage` (cumulative
   USD), `data.limit`. Convert `usage` → `usage_micro` (round to micro-USD).
2. **Debit delta → Autumn:**
   `delta_micro = usage_micro − or_spend_watermark_micro`. If `> 0`:
   `value = round(delta_micro × (1 + markup_bps/10000))`;
   `trackAutumnUsage(org, feature_id="model_spend", value, idempotencyKey="model_spend:<org>:<watermark_micro>")`.
   On success, set `or_spend_watermark_micro = usage_micro`. (Advance **only**
   after a successful/`409`-dup track → at-least-once with idempotent dedup =
   exactly-once effect; never lose or double-count, §7.)
3. **Push cap:** read Autumn balance
   (`getAutumnCustomer(org)` → `balances.credits.remaining` USD →
   `remaining_micro`). `new_limit_usd = (usage_micro + remaining_micro)/1e6`. If it
   differs from `data.limit` beyond an epsilon, `PATCH /api/v1/keys/{hash}
   { limit: new_limit_usd }`.
4. **Detail (optional, same cron or its own):** `POST /api/v1/analytics/query`
   with `dimensions:["api_key_id","model"]`, `granularity:"day"`, metrics
   `total_usage,tokens_prompt,tokens_completion` → upsert ClickHouse `model_usage`.

### 5.5 Top-up
Existing Autumn top-up raises `credits.remaining`. Next `model_meter` tick raises
the OR key `limit` (step 3) → calls resume. (Compute resume already handled by the
existing halt/resume path.) Optionally hook top-up to fire an immediate cap-push
so resume isn't gated on the cron interval.

### 5.6 Halt / resume
- Combined compute+token spend drives `credits.remaining` to ≤ 0 → existing
  Autumn halt fires (`projectOrg` → `is_halted` → `/admin/halt-org`). Independently,
  the cron will have pushed the OR `limit` down toward `usage` (remaining≈0), so OR
  **also** refuses further model calls — belt-and-suspenders.
- Resume on top-up (§5.5).

### 5.7 Reconciliation (slow cron, daily)
- Compare OR account spend (`GET /api/v1/credits` → `total_usage`, and
  `analytics/query` summed per key) against the sum of Autumn `model_spend`
  debits. Emit drift metric; alert if `|drift| > threshold`. Catches missed deltas,
  disabled/rotated keys, partial-turn accounting.
- Reconcile our **OR account float**: ensure our OR balance is funded
  (auto-recharge on the OR account; alert on low balance).

### 5.8 Offboard / rotate / disable
- Disable managed: `DELETE /api/v1/keys/{hash}` (final spend sync first), clear
  `or_key_hash`, set `model_billing_mode` to `off`/`byo`, revoke the managed
  credential.
- Rotate (compromise): create new OR key → re-seal credential (the existing
  credential-rotation flow flows to running sessions) → delete old key after the
  watermark is reconciled onto the new key (reset watermark to new key's usage=0).

### 5.9 BYO path
- `model_billing_mode='byo'`: customer supplies their own key (raw provider key,
  or — §9.4 — their own OR key). No OC OR key, no cap management, **no Autumn
  debit**; provider/their-OR bills them. Optionally still poll OR analytics (if
  their key is OR) or capture inline usage → ClickHouse for display only.

---

## 6. Surfaces & change spec (API · UI · docs)

### 6.1 OpenRouter — what we call (auth: `OPENROUTER_PROVISIONING_KEY`, a management key)
Base `https://openrouter.ai/api/v1`.
- `POST /keys` — create. Body: `name` (req), `limit` (USD cap, nullable),
  `limit_reset` (`daily|weekly|monthly|null`; we use `null`),
  `include_byok_in_limit` (bool), `expires_at?`. Response: `key` (plaintext,
  returned **once**) + `data { hash, name, label, disabled, limit,
  limit_remaining, limit_reset, usage, usage_daily/weekly/monthly, byok_usage*,
  created_at, updated_at }`.
- `GET /keys/{hash}` — read `usage` (cumulative USD), `limit`, `limit_remaining`,
  `disabled`. **Our spend read + cap state.**
- `PATCH /keys/{hash}` — update `limit` and/or `disabled` (and `name`). **Our cap
  push + emergency disable.**
- `DELETE /keys/{hash}` — offboard.
- `GET /keys` — list (audit/reconcile).
- `POST /analytics/query` — **per-model/per-key spend** for the dashboard.
  `dimensions: ["api_key_id","model"]`, `granularity`, metrics incl.
  `total_usage` (USD), `tokens_total/prompt/completion`. (Management-key auth;
  inference keys get 403.) `GET /analytics/meta` lists available
  metrics/dimensions.
- `GET /credits` — our OR **account** balance/usage (float monitoring, §5.7).
- Per-request inline (optional): include `usage:{include:true}` → `response.usage`
  carries cost; `GET /generation?id=<id>` returns a single generation's cost.

### 6.2 Autumn — what the edge calls (auth: `AUTUMN_SECRET_KEY`; existing helpers in `autumn_webhook.ts`)
- `POST /track` `{ customer_id: org_id, feature_id: "model_spend", value, idempotency_key }`
  (via `trackAutumnUsage`). `value` in micro-credits (§7).
- `GET /customers/{org_id}` `→ balances.credits.remaining` (via `getAutumnCustomer`)
  — for the cap push.
- **Setup (once):** define feature `model_spend` and add
  `{ metered_feature_id:"model_spend", credit_cost: 1e-6 }` to the `credits`
  credit_schema (dashboard or API).

### 6.3 New internal/edge endpoints & hooks
- Hook in the org-provisioning flow (where `createAutumnCustomer` runs / on the
  managed toggle) to do §5.1.
- `POST /internal/managed-credential` on **sessions-api** (HMAC, `V3_INTERNAL_AUTH_SECRET`
  or the shared event secret): `{ org_id, provider:"openrouter", key }` →
  store via secret-ledger/Infisical + bind managed credential. (Seam §9.5.)
- New edge cron `model_meter` (wrangler `[triggers] crons`) for §5.4; the daily
  reconcile (§5.7) can be a second cron entry.

### 6.4 Dashboard (web)
- **Agent create/edit dialog:** the credential picker gains the pinned
  `Managed · billed to credits` entry (full taxonomy §6.6); filter the model
  dropdown by the selected source. The Credentials page itself is **unchanged**.
- Extend `getAutumnBilling` (`/billing/autumn`) response to include a model-spend
  summary (period total, % of pool), OR add `getModelUsage('/usage/models?days=')`
  reading ClickHouse. New `ModelUsageSchema` next to `SandboxUsageSchema`
  (`web/src/api/schemas.ts`), `getModelUsage` next to `getSandboxUsage`
  (`client.ts`).
- New panel `ModelUsageBreakdown` as a sibling of `UsageBreakdown` in
  `PrepaidPlan` (`Billing.tsx`, the grid is already 2-col). Reuse `Panel`,
  `ResourceTable`, `formatCost` (already handles sub-cent → good for $/token),
  query-hook pattern (`['model-usage']`, 30s). Columns: Model · Tokens (in/out) ·
  Cost · Total footer. Mock in `web/src/api/mock.ts`.

### 6.5 Data stores
- **D1 `orgs`** new columns: §4.
- **ClickHouse `model_usage`** (detail only):
  `org_id String, day Date, session_id String, model String, tokens_prompt UInt64,
  tokens_completion UInt64, cost_usd Float64, source Enum('analytics','inline')`,
  ordered by `(org_id, day, model)`; upserted from the analytics poll
  (`source='analytics'`) and/or inline capture. Authoritative billing stays in
  Autumn; this is for display + drift cross-checks.

### 6.6 User-facing taxonomy & surface (the contract)

**Principle: "OpenRouter" is never user-visible.** Per agent, the user makes one
choice — run a model **via OpenComputer (Managed, billed to credits)** or with
**their own key (BYO)** — surfaced as a single selection, not a new dimension.
`model` (which model) is unchanged and orthogonal: same `provider/model` ids
either way.

**Surface = one entry in the existing credential picker.** On the agent
create/edit dialog the credential picker gains a pinned top entry
`Managed · billed to credits` (always present, not deletable) → saved keys →
`+ New credential` (same inline create as today). Pick Managed → done, no key;
pick/create a credential → BYO, exactly today's flow. There is **no separate
managed-config page** — Managed is configured purely by selecting it per agent.
The **Credentials page stays credentials-only**; it does not manage Managed. A
**token-spend / model-usage page is deferred**; per-agent/per-org budget UI is out
of scope now.

**API contract.** The agent's source is the existing `credential` field, which now
accepts a reserved value `"managed"`:
- `credential: "managed"` → Managed (no key; runs on the org's OC-managed OR key,
  billed to credits).
- `credential: "cred_…"` → BYO; inline `key:` → BYO shortcut (unchanged).
- omitted → inherit the org default.
`cred_…` ids can't collide with `"managed"`, so the field stays unambiguous; we do
**not** add a separate `model_access` field. SDK types `credential?` as the union
`"managed" | string`.

**Resolution (unchanged shape): agent `credential` → org default → error.**
- **Org default = `"managed"` unless a BYO credential is marked default** (existing
  `is_default`), which then wins. New orgs have no default credential ⇒ **default
  Managed** (removes the first-run `422 no_credential` wall). Existing orgs keep
  their default credential (backward-compatible).
- Resolves to Managed but the org can't run Managed (gating) → a clear
  `422 managed_unavailable`.

**Gating & availability.**
- Managed requires `billing_provider='autumn'` + model billing enabled (it debits
  Autumn credits). `legacy` orgs: the picker hides/disables Managed (BYO only)
  until migrated.
- **Model list depends on source:** Managed → all OC-supported models; a BYO key →
  that provider's models only. The dialog filters the model dropdown by source.
- **§9.7 caveat:** a runtime whose OR path is unresolved (e.g. `claude` via OR) is
  simply omitted from the Managed model list until resolved — BYO still offers it.

**Behavior.**
- Out of credits (Managed) → same halt as compute (one pool); "top up to resume."
- Switching an agent's source affects **future sessions only** (session-pinned
  config), as today.
- Persisted as the agent's `credential` value; the runtime resolves the sealed key
  at session create (Managed → the org's managed OR credential, §5).

Wire-level deltas (exact endpoints / schemas / components / files): **API §6.7,
UI §6.8, docs §6.9**.

### 6.7 API deltas (exact)

Repo: `sessions-api/src/v3`; SDK `opencomputer/sdks/typescript`. **No zod** — request
bodies are TS interfaces + hand-written guards; responses via `serialize*`.
**No org/billing table exists in v3** — `owner_id` is a derived opaque string
(`auth/org.ts:18`); `billing_provider`/`autumn` live only in the edge D1 + Go cell,
**not** in sessions-api. That shapes the gating design:

> **Managed availability = "a managed credential is bound for the owner"** (the
> recommended gate — avoids a cross-service `billing_provider` read). The edge
> provisions the org's OR key (§5.1) **only for autumn + model-billing-enabled
> orgs** and hands it to sessions-api, which stores it via the existing credential
> pipeline as a **managed credential** (a `credential_metadata` row, internal
> provider `"openrouter"`, never shown to users). So eligibility is enforced
> *upstream at provisioning*; sessions-api only checks "does this owner have a
> managed credential?". No new org table, no synchronous edge call.

1. **`credential: "managed"` sentinel.**
   - HTTP bodies stay `string`: `CreateAgentBody.credential` (`api/agents.ts:20`),
     `PatchBody.credential` (`api/agents.ts:77`) — accept the literal. SDK widens
     `CreateAgentParams.credential`/`UpdateAgentParams.credential` to
     `"managed" | (string & {})` (`sdks/typescript/src/agents/agents.ts:11,19`) —
     cosmetic (already `string`).
   - Core branch: in `createAgent` (`core/agents.ts:157-163`) and `patchAgent`
     (`core/agents.ts:252-265`) add a `credential === "managed"` arm **before**
     `assertCredentialProvider` — skip provider-match (managed serves any runtime),
     mint no BYO credential.
   - **Storage of the sentinel (sub-decision):** store the literal `"managed"` in
     `agent_core.agents.credential_id` (TEXT, no FK enforced, `db/schema.ts:29-43`)
     — minimal, and request/storage/response all use one field; `serializeAgent`
     passes it through (`core/agents.ts:78-92`). *Alt:* a dedicated
     `agents.model_source` column with `credential_id` NULL — more explicit,
     +migration +serialize/SDK plumbing. **Rec: sentinel-in-`credential_id`** (the
     contract is already "the `credential` field carries the source").

2. **Resolution** (`resolveCredentialForSession`, `core/credentials.ts:214-245`):
   add an arm — if `agent.credentialId === "managed"` (or org default is managed,
   see 3) → resolve the **owner's managed credential** (lookup by owner + internal
   managed provider) → return its id (`source:"managed"`); **not found → throw
   managed-unavailable**. Existing pin / org-default / null arms unchanged.

3. **Org default = managed.** Today org default = the `is_default` credential per
   `(owner, provider)` (`core/credentials.ts:198-206`). Add: when no `is_default`
   BYO credential resolves AND the owner has a managed credential → default to
   managed. New orgs (no BYO default) thus default Managed; existing orgs with an
   `is_default` credential are unaffected. *(No `PUT /credentials/default` change
   for v1; "managed is default" = simply having no default BYO credential.)*

4. **`422 managed_unavailable`.** New error class beside `NoCredentialError`
   (`core/session-service.ts:27-33`), thrown from `startSession`
   (`session-service.ts:100-103`) when managed is selected/defaulted but no managed
   credential exists for the owner; wire-mapped beside the `no_credential` arm
   (`api/sessions.ts:173-175`) → `422 { error: { type:"managed_unavailable", … } }`.
   The seal path re-resolves (`runtime/credential.ts:96`) — make it resolve the
   managed credential too.

5. **Provisioning hand-off (the §9.5 seam).** New sessions-api internal route
   `POST /internal/managed-credential` (HMAC via `V3_INTERNAL_AUTH_SECRET`):
   `{ owner_id, provider:"openrouter", key }` → store via
   `reserveAndWrite`/secret-ledger + insert a managed `credential_metadata` row
   (provider `"openrouter"`, fixed `name`). Idempotent per owner (re-create =
   rotate, `rotateCredentialKey` `core/credentials.ts:165`). This is where the
   edge's provisioned OR key becomes a sessions-api managed credential.

6. **Unchanged / minor:** BYO validation (`assertModelMatchesRuntime` still applies
   to the chosen `model`); credentials CRUD endpoints. `GET /v3/credentials`
   (`listCredentials`, `core/credentials.ts:103-110`) **should hide** internal
   `"openrouter"` managed rows so they don't render as user BYO keys (filter in
   the query or serializer).

7. **Tighten the `credential` ref type — don't leave it `string`** (decision §9.9).
   Shared closed union: `CredentialId = ` `` `cred_${string}` `` (ids are
   `newId("cred")` → `cred_…`, `core/credentials.ts:69`); `CredentialRef =
   "managed" | CredentialId` (omitted = org default). Backend (no zod): type
   `CreateAgentBody.credential` / `PatchBody.credential` (`api/agents.ts:20,77`) as
   `CredentialRef`, and add a runtime `parseCredentialRef(v)` →
   `{kind:"managed"} | {kind:"id",id}` that throws `AgentValidationError`
   (→ `400 invalid_credential`) for anything that is neither `"managed"` nor
   `^cred_`. Call it in `createAgent`/`patchAgent` **before** the source branch so a
   malformed ref fails fast and distinctly (today an unknown string only fails later
   as "credential not found"). Also tighten credential **create** `provider`
   (`api/credentials.ts`) to the closed `"anthropic" | "openai"` — the internal
   `"openrouter"` managed provider is system-only, never user-supplied. SDK
   (`sdks/typescript/src/agents`): `Credential.id: CredentialId`,
   `CreateAgentParams.credential?: CredentialRef`,
   `UpdateAgentParams.credential?: CredentialRef | null` so `credential: cred.id`
   and `credential: "managed"` typecheck while arbitrary strings don't.

### 6.8 UI deltas (exact)

Repo `opencomputer/web` (`web/src/...`; byte-identical on `main`). **Two** credential
pickers since PR #444 — both change.

**A. Create dialog — `web/src/pages/Agents.tsx`.**
- Add sentinel near `:40`: `const MANAGED = 'managed'` (sent verbatim to the API).
- Prepend to `credOptions` (`:91-99`): `{ value: MANAGED, label: 'Managed · billed to credits' }`.
- `createMutation.mutationFn` (`:101-125`): branch so `credChoice === MANAGED`
  sets the `createAgent` body `credential` (`:123`) to `"managed"` (not `undefined`).
  `canCreate` (`:184-187`) already passes (no key required).
- `initialCredChoice()` (`:71-74`): default to `MANAGED` when the org is managed.
- **Model filter:** replace `options={MODELS}` (`:280`) with a list derived from
  `credChoice` — Managed → full `MODELS` (`:30-34`); a BYO cred id →
  `MODELS.filter(m => m.value.startsWith(provider + '/'))` (provider from the
  selected cred in `anthropicCreds` `:54-56`). `Select` has no groups
  (`components/form.tsx:14-28`) → plain `.filter`.

**B. Live picker — `web/src/pages/AgentDetail.tsx`.**
- Sentinel near `:43`; prepend to `credOptions` (`:184-188`).
- `credSelectValue` (`:181-183`): map `agent.credential_id === 'managed'` → `MANAGED`.
- `onCredChange` (`:189-196`): `if (v === MANAGED) switchCredMutation.mutate('managed')`
  (`switchCredMutation` `:136-145` already calls `updateAgent(id,{credential})`,
  accepts `string` `client.ts:394`).
- Model filter: same change at `modelOptions` (`:175-177`).

**C. Gating (both dialogs).** Neither imports billing today. Add
`useQuery({ queryKey:['billing'], queryFn: getBilling })` (Agents `~:45-53`,
AgentDetail `~:68-71`; `getBilling` already exported `client.ts:303`, schema
`schemas.ts:194`) and include the Managed option only when
`billing?.billingProvider === 'autumn'` — the same field `Billing.tsx:107` gates on.
UX-only; the backend still enforces via §6.7.4.

**D. API layer (`web/src/api/`).** **No schema/type change** — `createAgent.credential?: string`
(`client.ts:374`) and `updateAgent.credential: string|null` (`:394`) already accept
`"managed"`. Hide internal managed rows from the list if the backend returns them
(§6.7.6). Mocks (`mock.ts`): add an agent with `credential_id:'managed'`;
`billing.billingProvider:'autumn'` already set (`:252`).

**E. Credentials page — `web/src/pages/Credentials.tsx`: UNCHANGED** (self-contained
CRUD; no dependency on the dialogs).

**F. Billing model-spend panel (from §6.4).** `PrepaidPlan` (`Billing.tsx:249`),
grid `:291`; add a `ModelUsageBreakdown` `<Panel>` beside `<UsageBreakdown/>`
(`:408`, component `:589`); reuse `Panel`/`ResourceTable`/`formatCost`.

**G. Tighten the picker selection type + DRY the two dialogs** (decision §9.9).
Today both pickers cram cred-ids + sentinels (`'__new__'`, `'__default__'`,
`'managed'`) into one `string` state, and they've **diverged** (AgentDetail has
`ORG_DEFAULT`, Agents doesn't — research-confirmed). Extract a shared
`web/src/lib/credential-source.ts`: the union
`Source = {kind:'managed'} | {kind:'orgDefault'} | {kind:'credential'; id: CredentialId} | {kind:'new'}`,
the `Select`-value ↔ `Source` map, and `toWire(source): CredentialRef | null | undefined`
(managed→`"managed"`, credential→id, orgDefault→`null` on patch / omit on create,
new→post-create id). Both `Agents.tsx` and `AgentDetail.tsx` import it → one source
of truth, no drift. Type the web client `createAgent`/`updateAgent` `credential` as
`CredentialRef` (`client.ts:374,394`) and runtime-validate via zod (web has zod):
`CredentialSchema.id` (`schemas.ts:296`) as `z.string().startsWith('cred_')`, and the
field as `z.union([z.literal('managed'), credentialIdSchema])`.

### 6.9 Docs deltas (exact)

Recurring edit: (a) "credential/key **required**" → "required **unless** Managed";
(b) `422 no_credential` → "…unless Managed selected/default"; (c) add a third option
`credential:"managed"` (run via OpenComputer, billed to credits) beside inline `key`
/ `credential:"cred_…"`; (d) "billed by your provider key" → "…or to your
OpenComputer credits under Managed". **Never name OpenRouter.**

Published nav = `docs/agent-sessions/*` only. Per file:
- **`credentials.mdx`** (highest impact): frontmatter L3-4 (broaden; consider
  retitling the page **"Model access"** — keep slug `agent-sessions/credentials`, so
  no `docs.json`/link churn); L7 (lead Managed zero-key default; credential not
  strictly required); L20-22; L49 (add `credential:"managed"` example); L74
  (fallback to Managed); L76-83 Resolution (insert Managed into the order;
  "neither resolves" ≠ always 422); L105 (N/A for managed); L109-135 inline-key
  section (Managed = the true no-key path).
- **`agents.mdx`**: L43 (add `credential:"managed"`); L53 ("(required)" →
  "(required unless Managed)").
- **`authentication.mdx`**: L4 desc; L7; L67 Warning (credits under Managed);
  L78-82 (lead Managed; soften required; mention `"managed"`).
- **`sessions.mdx`**: L13; L84 (credits under Managed); L88.
- **`quickstart.mdx`**: L15-20 prereqs (Managed removes the provider-key prereq);
  L22 Tip; L26; L35-42 + L50-57 examples (add a Managed no-key variant); L68 Note;
  L72 Tip; L196 checklist.
- **`overview.mdx`**: L22 card; L40 step ("choose Managed"); L53/L56 architecture.
- **`runtimes.mdx`**: L7; L9-12 table (Credential column); L23/L41; L57; L76; L102.
- **`api-reference.mdx`**: L58 (not required when Managed); L252 (document
  `credential:"managed"`, bypasses key provider-match, billed to credits); L256
  (third path); L337 (soften required); L339-341 (decide how/whether managed shows
  in the `Credential` shape).
- **`docs.json`**: **no change** (no new page; keep the slug even if the title
  becomes "Model access").

**SDK docs:** `sdks/typescript/README.md` L47 (Managed no-`key` variant), L68-79
Credentials section (open with Managed zero-key; soften "required"; show
`oc.agents.create({ …, credential:"managed" })`). `sdks/python/README.md`: **no
change** (sandbox-only).

**FLAG — `docs/background-agents/*` (unpublished, not in `docs.json`) names
OpenRouter.** It carries the prior "platform billing / model gateway" concept
(≈ Managed) **and** explicit OpenRouter mentions: `overview.mdx:62`,
`models.mdx:27,54,57,58`, `api.mdx:128` (connection enum includes `openrouter`),
plus gateway/"platform billing" passages (`overview.mdx:34`,
`how-it-works.mdx:19,29,65-78`, `runtimes.mdx:38`, `triggers.mdx:20`,
`observability.mdx:79,87`, `sessions.mdx:22,33`). **Decision (see §12):** treat
`background-agents/*` as dead (delete) or adopt it as the Managed-terminology
source — either way **scrub every OpenRouter mention** before any of it publishes.

---

## 7. Units & math (exact — implement verbatim)

- **1 credit = $1.** Track token cost as **micro-credits** to stay integer:
  feature `model_spend.credit_cost = 1e-6`, so `value` units are micro-credits and
  credits debited = `value × 1e-6`.
- **Watermark** `or_spend_watermark_micro` = last-synced OR `usage` in micro-USD
  (`round(usage_usd × 1e6)`).
- **Debit per tick:** `delta_micro = usage_micro − watermark_micro` (≥0; OR
  `usage` is monotonic). `value = round(delta_micro × (1 + markup_bps/10000))`.
  `trackAutumnUsage(..., value, idempotency="model_spend:<org>:<watermark_micro>")`.
  Advance watermark **only after** track returns success or `409` (dup). ⇒
  at-least-once delivery + idempotent dedup = **exactly-once** economic effect;
  a crash between track and watermark-advance re-sends the same idempotent event
  (no double charge), never drops a delta.
- **Cap push:** `new_limit_usd = (usage_micro + remaining_micro)/1e6` where
  `remaining_micro = round(balances.credits.remaining × 1e6)`. `PATCH` only if
  `|new_limit_usd − data.limit| > epsilon` (avoid churn).
- **No negatives:** OR `usage` never decreases; refunds/credits are handled on the
  Autumn side (grant credits), not by reversing OR.

---

## 8. Instrumentation (don't ship without these)

Emitted from the edge crons + provisioning hook; surfaced in the existing metrics
stack (and ClickHouse where noted).

- **Counters:** `model_or_key_provision_total{result}`,
  `model_or_key_delete_total{result}`, `model_cap_update_total{result}`,
  `model_spend_debit_micro_credits_total{org}` (sum of `value`),
  `model_meter_track_total{result=ok|dup|err}`,
  `model_or_api_errors_total{op,http_code}`,
  `model_halt_resume_total{action}`.
- **Gauges:** `model_meter_sync_lag_seconds` (now − last successful tick),
  `model_or_account_balance_usd` (our float; **alert** low),
  `model_managed_orgs_active`, `model_cap_remaining_usd{org}` (sampled).
- **Reconcile:** `model_reconcile_drift_usd{org}` (OR spend − Σ Autumn debits);
  **alert** if `|drift|` or its rate exceeds threshold.
- **Structured logs / audit (immutable):** every key create/delete/rotate (org,
  hash, limit), every cap change (org, old→new, reason top-up|drain|halt), every
  debit tick (org, delta_micro, value, watermark before→after), every
  provisioning hand-off to sessions-api. Never log the plaintext OR key.
- **Traces:** wrap each cron tick (per-org span: read→debit→cap) and the
  provisioning hook so OR/Autumn latency + failures are attributable.
- **Dashboards/alerts:** sync-lag SLO; OR error-rate; drift; float low; spike in
  `cap_update` failures (means orgs may overshoot or get wrongly blocked).

---

## 9. Consequential decisions (review these)

**9.1 Per-org vs per-session OR keys.**
*Options:* (a) one long-lived key per org, cap updated by cron; (b) ephemeral key
per session, `limit=min(session budget, remaining)`, deleted at end.
*Choice:* **(a) per-org default.** *Why:* durable, long-running sessions make
per-session churn awkward; one key per org matches the billing entity (the pool
owner) and minimizes OR API calls. *Risk:* a leaked key exposes the org's whole
remaining budget (bounded by the cap, and the key is never in the sandbox thanks
to the proxy). *Upgrade path:* (b) for tighter per-session blast radius if needed
— same cron, iterate session keys.

**9.2 At-cost vs markup.** *Options:* `markup_bps=0` (pass-through) vs >0.
*Choice:* **mechanism shipped (per-org `model_markup_bps`, env default), value is a
business call.** *Why it matters / must not be missed:* managed usage runs on
**our** OR credits, and OR charges a **~5% credit-purchase fee**, so `markup_bps=0`
**loses ~5%** (we pay list+5%, bill list). Break-even needs `~500 bps`; any margin
is on top. Compute already runs at margin ($0.06/GB-hr bundled), so a markup is
consistent.

**9.3 Sync cadence.** *Choice:* `model_meter` every **1–2 min** (debit + cap),
reconcile **daily**. *Why:* the OR cap is the real-time guard, so the cron only
needs to keep the cap roughly aligned as compute drains the shared pool and to
move spend into the visible balance. *Risk/trade:* between ticks, compute draining
the pool while tokens still have OR headroom allows a **bounded overshoot**
(≤ max burn × interval); trued-up next reconcile (can push balance slightly
negative → halt). Same eventual-consistency class as today's 5-min compute bucket.
Tighter = less overshoot, more OR calls. Add a top-up→cap-push hook (§5.5) so
resume isn't cron-gated.

**9.4 BYO via OR vs BYO direct.** *Choice:* **BYO-direct unchanged for v1**
(raw provider key, existing credentials flow, no debit). BYO-via-OR (customer
attaches their own OR key; `include_byok_in_limit`/`byok_usage` exist) is a later
add for unified observability. *Why:* smallest surface; BYO is explicitly not
billed.

**9.5 Cross-service seam: who provisions + stores the OR key?** *Options:*
(A) edge holds the OR mgmt key and does everything, storing the inference key in
D1 `secret_store_entries` (edge's envelope-encrypted store); (B) sessions-api
holds the mgmt key and provisions/stores via its Infisical credential pipeline,
publishing only the hash to D1; (C) **edge provisions (mgmt key on edge only) and
hands the freshly-created inference key to sessions-api via one HMAC internal call,
which seals it through the existing Infisical credential pipeline; edge keeps the
hash in D1 and owns all metering.** *Choice:* **(C).** *Why:* keeps the
"Autumn/OR are edge-native" invariant (mgmt key in one place, all OR+Autumn calls
on the edge), **and** reuses the post-migration Infisical-backed model-credential
machinery for the runtime-facing secret (sealing, rotation-to-running-sessions).
The plaintext key transits edge→sessions-api once over HMAC — the same trust path
secrets already use. *Risk:* that one hand-off must be exactly-once / idempotent
(key by org_id; re-create is a rotate).

**9.6 Token feature representation in Autumn.** *Choice:* a **single
dollar-denominated `model_spend`** credit-system feature (`credit_cost=1e-6`),
**not** per-model Autumn features. *Why:* OR is the cost source; per-model prices
would duplicate OR's pricing into Autumn's static schema. Per-model breakdown lives
in ClickHouse (§6.5). *Trade:* Autumn itself won't show per-model — acceptable,
the dashboard reads ClickHouse.

**9.7 Runtime ↔ OpenRouter protocol compatibility (MUST verify before build).**
The `codex`/OpenAI runtime maps to OR's OpenAI-compatible `/chat/completions`
cleanly. The **`claude` runtime uses the Anthropic API shape** — confirm it can be
pointed at an OR endpoint that speaks Anthropic's protocol (OR's
Anthropic-compatible `/v1/messages`) or that the runtime can use OR's
OpenAI-compatible endpoint. If neither holds for a runtime, that runtime can't go
through OR and must stay on a direct provider key (BYO-style) until resolved.

**9.8 User-facing taxonomy (resolved).** Surface Managed as a single pinned entry
in the existing credential picker, selected per agent, via the
`credential: "managed"` sentinel — **not** a new `model_access` field. Org default
is Managed unless a BYO credential is marked default; new orgs default to Managed;
the Credentials page is unchanged and there is **no** managed-config page (a
token-spend page is deferred); "OpenRouter" is never user-visible. Full contract
§6.6; wire deltas §6.7–§6.9. *Why:* smallest surface — reuses the existing
credential mental model + resolution, adds zero top-level concepts, removes the
first-run `422 no_credential` wall. *Risk:* the sentinel lightly overloads
`credential` (ids can't collide, so safe); Managed availability is gated on
`autumn` + runtime/OR support (§9.7).

**9.9 Type the credential ref (resolved).** `credential` carries a **closed union,
not a free `string`**: `CredentialId = ` `` `cred_${string}` ``;
`CredentialRef = "managed" | CredentialId` (omitted = org default). Enforced per
layer: **web** client + schemas via zod
(`z.union([z.literal("managed"), z.string().startsWith("cred_")])`); **SDK** via the
TS union + a typed `Credential.id`; **backend** (no zod) via a `parseCredentialRef`
guard → `400 invalid_credential`. The UI models the picker selection as a
discriminated `Source` union in a shared module used by **both** pickers (§6.8.G).
*Why:* the sentinel-in-a-string is the one looseness this taxonomy introduced; a
closed union removes it end-to-end and DRYs the two diverged pickers. *Risk:* none
material — the flat one-field wire contract is unchanged (non-breaking); only
malformed values that already would have failed now fail earlier and clearer.

---

## 10. Failure modes & fail-open/closed

- **OR inference path down** → model calls fail at the gateway (OR is in the hot
  path; mitigated by OR's own provider routing/fallback). Product accepts OR as a
  hot-path dependency (§9 trade); BYO-direct is the escape hatch.
- **`model_meter` stalls / edge down** → no debit + no cap push. Balance lags but
  the **last-set OR cap still enforces** the budget (fail-safe on overspend, modulo
  the §9.3 overshoot bound). `sync_lag` alert fires.
- **`PATCH limit` fails** → cap goes stale: after top-up the org may stay blocked
  (cap too low) → retry + top-up→cap-push hook; after drain the org may overshoot
  → bounded, trued by reconcile.
- **`POST /track` fails** → watermark not advanced → delta re-sent next tick
  (idempotent). No loss, no double charge.
- **OR account out of funds** (our float) → all managed orgs' calls fail → **P1**;
  guarded by float gauge + auto-recharge + alert (§5.7/§8).
- **Provisioning hand-off (edge→sessions-api) fails** → org has an OR key with no
  bound credential → sessions can't resolve a managed key (`422 no_credential`).
  Make the hook idempotent + retryable; reconcile orphaned OR keys (key exists,
  no credential) in the daily job.

---

## 11. Alternatives considered (why not)

- **Raw provider keys + our own metering** (parse `usage` in `secretsproxy`, keep a
  rate card, enforce a mid-turn soft-stop): more code on the hot path, SSE/stream
  parsing per provider, a rate card to maintain as prices move, and **still no
  provider-enforced cap**. OR gives counting+limiting turnkey. Anthropic/OpenAI
  expose key/project/workspace scoping but **no API-settable $ budget** (caps are
  dashboard-only) — so self-enforcement is the only DIY path, and it's strictly
  more work for less safety.
- **Per-turn push from sessions-api → edge → Autumn:** real-time-ish balance, but
  reintroduces "we count" (streaming capture, idempotent per-turn emit) for
  marginal benefit; the OR cap already gives real-time enforcement. Poll-based
  meter (mirrors the compute meter) is simpler and chosen. Revisit only if instant
  balance UX is required.
- **Separate token-credit balance:** breaks the single shared pool the product
  wants; rejected.

---

## 12. Open questions (genuine forks for product/owner)

1. **Markup value** (§9.2) — at-cost-minus-5%, break-even (~5%), or margin?
2. **Per-org vs per-session keys** (§9.1) — accept org-budget blast radius, or pay
   per-session churn for tighter isolation?
3. **Sync cadence** (§9.3) — overshoot tolerance vs OR API volume.
4. **Runtime/OR protocol** (§9.7) — confirm Claude-runtime path through OR before
   committing the `claude` runtime; otherwise scope v1 to `codex` or keep `claude`
   on direct keys.
5. **Rollout** — token billing only for `autumn` orgs; sequencing vs the
   legacy→autumn migration (`AUTUMN_NEW_ORGS`, the missing `cmd/migrate-to-autumn`).
6. **`background-agents/*` docs** — delete (dead) vs adopt as the Managed-terminology
   source; either way **scrub all OpenRouter mentions** before any publishes (§6.9).

---

## 13. Pointers (files)

- Autumn (edge): `cloudflare-workers/api-edge/src/autumn_webhook.ts` (client:
  `trackAutumnUsage`, `getAutumnCustomer`, `createAutumnCustomer`, `projectOrg`,
  `syncAutumnToD1`), `autumn_meter.ts` (compute meter cron — **model_meter mirrors
  it**), `dashboard.ts` (billing endpoints). Secret `AUTUMN_SECRET_KEY`; add
  `OPENROUTER_PROVISIONING_KEY` the same way (`wrangler.prod.toml` /
  `wrangler.toml`).
- Provider switch / halt: migration `047_orgs_billing_provider`, D1
  `schema_phase7.sql`, `index.ts` create/wake gates + `/internal/autumn-*`,
  `internal/controlplane/halt_reconciler.go`.
- Egress proxy (security, unchanged): `internal/secretsproxy/proxy.go` — allowlist
  `openrouter.ai`.
- Credentials / sealing (store the OR inference key here): `sessions-api/src/v3/core/credentials.ts`,
  `sessions-api/src/v3/runtime/credential.ts`, the secret-ledger/Infisical pipeline
  (`INFISICAL_*` in `sessions-api/.env.v3`).
- Dashboard: `web/src/pages/Billing.tsx` (`PrepaidPlan`/`UsageBreakdown`),
  `web/src/api/client.ts`, `web/src/api/schemas.ts`, `web/src/api/mock.ts`.
- ClickHouse: `CLICKHOUSE_*` in `sessions-api/.env.v3`.
- Compute-billing context: `internal/db/billable_events.go`, `internal/db/usage.go`.

---

## Appendix: research sources

OpenRouter — [keys API (create/list/get/patch/delete)](https://openrouter.ai/docs/api/api-reference/api-keys/create-keys),
[provisioning/management keys](https://openrouter.ai/docs/guides/overview/auth/provisioning-api-keys),
[analytics API](https://openrouter.ai/docs/cookbook/administration/analytics-cost-control)
(`POST /api/v1/analytics/query`, mgmt-key auth; dims `model`/`api_key_id`,
metric `total_usage`),
[BYOK + fees](https://openrouter.ai/docs/guides/overview/auth/byok),
[usage accounting](https://openrouter.ai/docs/guides/guides/usage-accounting),
[Infisical integration](https://openrouter.ai/docs/guides/community/infisical).
Anthropic [Admin API](https://docs.anthropic.com/en/api/administration-api)
(no API-settable spend cap),
OpenAI [project service accounts](https://developers.openai.com/api/reference/resources/organization/subresources/projects/subresources/service_accounts/methods/create)
(no API-settable budget). Autumn config read live from `api.useautumn.com/v1`
(`/products`, `/features`) 2026-06-29: `credits` credit_system (1 cr=$1),
`compute_1gb…64gb` schema, `base`/`top_up`/`concurrency_*` products.
