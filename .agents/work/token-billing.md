# Token / model-usage billing — design

Status: **design reviewed (3 rounds) + reconciled against merged code.**
Architecture decided (OpenRouter-native + Autumn shared credit pool). The UI
runtime/model/credential foundation shipped in **PR #448**, so §6.8 is now the
small remaining Managed delta. **Implementation-ready for the `claude` path; the
`codex` path is gated on the §9.7 spike** (OR's `wire_api:"responses"` support is
unvalidated). One pre-build spike (§9.7) then build; decisions that could cause
debate are in §9, failure modes in §10.

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

**Scope / prior art (don't conflate, G6):** this is **v3-only**. The legacy **v2**
("OpenClaw") path already runs an OpenRouter platform gateway — `OPENROUTER_API_KEY`
(`sessions-api/.../routes/agents.ts`), `lib/openclaw-image.ts`, and a v2
credential-type enum that already includes `openrouter` (`v2/db/schema.ts`). This v3
design is separate and supersedes it; the **v3 internal managed `"openrouter"`
provider value is not the v2 enum value** — keep them namespaced apart.

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
3. **The cap mirrors the shared pool — in aggregate across all of an org's keys.**
   Headroom = `remaining_credits / (1+markup)` of provider spend, granted to the
   **active** key; any `superseded` key (rotation) is frozen near its own `usage`.
   So total spendable across keys can never exceed the prepaid balance (exact math
   §7; per-key mechanics §5.4/§5.8).
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

**Org (D1 `orgs`):**
- `model_billing_status TEXT NOT NULL DEFAULT 'off' CHECK (model_billing_status IN ('off','provisioning','active','error'))`
  — drives the provisioning state machine (§5.1, P2-e). `active` ⇒ Managed is
  offered + resolvable for the org.
- `model_markup_bps INT NOT NULL DEFAULT 0` — markup in basis points applied to OR
  cost before debiting Autumn (0 = at-cost; 2000 = +20%); per-org override of an env
  default (§9.2). **Both the debit and the cap math depend on this** (§7).

**`managed_model_keys` (D1, NEW) — one row per provisioned OR key** (normally one
`active`; ≥1 transiently during rotation). This per-key ledger replaces a single
`orgs.or_key_hash` so each key's spend is tracked independently until it quiesces
(P2-g) and so the in-flight debit interval is durable (P1-a):
```
id, org_id,
or_key_hash TEXT,                 -- OpenRouter key hash (non-secret)
managed_credential_id TEXT,       -- sessions-api credential row id (the sealed key)
status TEXT CHECK (status IN ('active','superseded','deleting')),
committed_micro BIGINT NOT NULL DEFAULT 0,  -- watermark: OR usage already debited to Autumn (micro-USD)
pending_from_micro BIGINT, pending_to_micro BIGINT, pending_idem TEXT,
                                  -- the single in-flight debit interval, immutable until committed; NULL when none
attempts INT NOT NULL DEFAULT 0, last_error TEXT,
created_at, superseded_at
```
Index `(org_id, status)`. The plaintext OR key never lands here — only the hash +
the sessions-api credential id; the secret lives in Infisical via the credential
pipeline. `limit_reset = null` on the OR key (we manage the cap dynamically).

**Autumn — new feature `model_spend`:** a metered feature in the `credits`
credit_system's `credit_schema` with `credit_cost = 1e-6` (1 unit = 1 micro-credit
= $1e-6). Dollar-denominated; **per-model breakdown is NOT in Autumn** (ClickHouse,
§6.5). Created once via Autumn dashboard/API.

**ClickHouse — `model_usage`:** org/model/day rollup for the dashboard (§6.5).
**No session dimension** — an org-level key isn't session-attributable from the OR
poll (P1/P2-d); session-level is deferred.

**Secrets:** new **OpenRouter management key** `OPENROUTER_PROVISIONING_KEY`
(Cloudflare Wrangler secret on `opencomputer-edge-prod`/dev), used by the edge for
all OR API calls. Stored write-only like `AUTUMN_SECRET_KEY`. A **dedicated** HMAC
secret (separate from the generic internal-auth) guards the plaintext-key hand-off
(§6.3, P2-f).

---

## 5. Time-axis journeys (what happens at each stage)

### 5.1 Managed enablement — a provisioning state machine (P2-e)
Trigger: org on `billing_provider='autumn'` + model billing toggled on. The edge
drives `orgs.model_billing_status` `off → provisioning → active` (or `error`),
idempotent + retryable. This is **cross-service and non-atomic**, so every step is
resumable from persisted state:
1. Set `model_billing_status='provisioning'`; insert a `managed_model_keys` row.
2. **Create OR key:** `POST /api/v1/keys { name:"oc-org-<org>", limit:<remaining/(1+markup)>, limit_reset:null }`
   (auth `OPENROUTER_PROVISIONING_KEY`) → `key` (plaintext, once) + `data.hash`.
   Persist `or_key_hash` on the row.
3. **Bind credential:** hand the plaintext to sessions-api via the hardened HMAC
   route (§6.3), passing `{ owner_id, or_key_hash, operation_id }` alongside the key
   → it stores via secret-ledger/Infisical, **records `or_key_hash`+`operation_id` in
   the credential metadata**, and returns `managed_credential_id`. Persist it; set the
   row `status='active'`. (Seam §9.5.)
4. Set `orgs.model_billing_status='active'`.

**Partial-failure repair** (reconcile, §5.7). Note the OR plaintext is **one-time**
— the edge does **not** retain it after step 2, so a bind can't be "re-sent." Repair
is driven off the row + a sessions-api **lookup** (`GET /internal/managed-credential?owner_id=&or_key_hash=`,
§6.3) + OR:
- OR key created, response to step 3 lost → **look up** by `or_key_hash`/`operation_id`:
  if bound (we just lost the response) → finish the flip; if **not** bound → the
  plaintext is unrecoverable, so **`DELETE` the OR key and recreate** from step 2
  (never attempt to re-send a key the edge no longer holds).
- Credential bound but row not `active` / status not flipped → finish the flip.
- `model_billing_status='active'` but no `active` key row / credential missing →
  re-provision + **alert**.
Bounded `attempts` with backoff; record `last_error`; after N attempts →
`status='error'` + alert, and Managed stays unavailable (clean `422`, §6.6).

### 5.2 Session create — resolve a model endpoint profile, not just a key (P1-c)
The runtime needs more than a secret. Today sealing maps **provider → env var**
(`PROVIDER_KEY_ENV`) and **provider → egress host** (`PROVIDER_EGRESS_HOST`) in
`runtime/credential.ts` — only `anthropic`/`openai` — which doesn't fit a managed OR
key that serves either runtime. Resolve a **model endpoint profile** from
`(runtime, source)` where env-var, base URL, egress host, and the billing credential
are **separate fields**:

| field | BYO anthropic | BYO openai | Managed · claude rt | Managed · codex rt |
|---|---|---|---|---|
| key env var | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` | `ANTHROPIC_AUTH_TOKEN` | `OPENAI_API_KEY` |
| base URL (env/cfg) | default | default | `ANTHROPIC_BASE_URL=https://openrouter.ai/api` | OpenAI client `baseURL=https://openrouter.ai/api/v1` |
| egress allowlist host | `api.anthropic.com` | `api.openai.com` | `openrouter.ai` | `openrouter.ai` |
| sealed secret | anthropic cred | openai cred | org managed OR key | org managed OR key |
| billing | BYO | BYO | Managed (Autumn) | Managed (Autumn) |

- **Exact per-runtime changes (P1-c)** — base-URL/auth-mode injection is new and
  load-bearing, and each runtime today *forces the official provider*:
  - `claude` (`v3-claude/src/server.ts`) **deletes both** `ANTHROPIC_AUTH_TOKEN`
    **and** `ANTHROPIC_BASE_URL` from the child env (`delete childEnv.ANTHROPIC_AUTH_TOKEN`
    / `…ANTHROPIC_BASE_URL`, ~:87–88) to force the api-key path. Managed must instead
    **set** `ANTHROPIC_BASE_URL=https://openrouter.ai/api` and pass the OR key as
    `ANTHROPIC_AUTH_TOKEN` (OR's Claude-Code path — base is `…/api`, **not** `/api/v1`;
    var is `AUTH_TOKEN`, not `API_KEY`).
  - `codex` (`v3-codex/src/server.ts`) hardcodes the provider in the
    `Codex({config:{model_providers:…}})` block: `base_url:"https://api.openai.com/v1"`
    (~:111), `env_key:"OPENAI_API_KEY"` (:112), **`wire_api:"responses"`** and
    **`requires_openai_auth:true`** (:113–114). Managed must override `base_url` →
    `https://openrouter.ai/api/v1` **and** reconcile `wire_api`/`requires_openai_auth`
    with OR — that pairing is **unvalidated** (the open risk, §9.7 / open-q #4).
- **Delivery seam (G1) — how the brain learns it's Managed.** Today the brain
  deletes/hardcodes the above; **no channel carries base-URL/auth-mode to it.**
  `TurnConfig` (both servers) has only `model/system_prompt/mcp_endpoint/…`. Add a
  **non-secret** `endpoint_profile` to `TurnConfig` — e.g. `{ mode:"byo"|"managed",
  base_url?, auth_env }` — (or a sandbox env var the brain reads) so the brain *sets*
  base-URL/auth-mode from it instead of deleting/hardcoding. The **secret** still
  arrives sealed via the egress proxy (§5.3); only the non-secret routing rides
  `TurnConfig`.
- Resolution picks the source (managed credential vs BYO cred, §6.6/§6.7), derives
  the profile, seals the secret **and** sets `endpoint_profile`; session-pinned.
  Per-session-key variant: §9.1.

### 5.3 Turn execution (runtime → proxy → OR)
- Runtime calls its profile's base URL (Managed → `openrouter.ai`) through the
  egress proxy, which swaps the sealed key in-flight; allowlist = the profile's
  host. (OR returns `response.usage` incl. cost **automatically**; the
  `usage:{include:true}` request flag is **deprecated** — don't depend on it.)
- **OR enforces the cap in real time:** exceeding `limit` → `402`/disabled → the
  turn surfaces credits-exhausted. Provider-enforced overshoot guard.
- Spend accrues on the OR key; we meter by polling (§5.4), **not in-path**.

### 5.4 Sync cron (`model_meter`, edge, every N min, §9.3)
Sibling to `autumn_meter.ts`. Iterate every `active` **and** `superseded`
`managed_model_keys` row (superseded keys keep being polled until quiesced, P2-g):
1. **Read OR spend:** `GET /api/v1/keys/{or_key_hash}` → `usage` (cumulative USD),
   `limit`. `usage_micro = round(usage × 1e6)`.
2. **Debit the immutable interval (P1-a — persist before track):**
   - If the row has a **pending** interval (prior crash), retry it **verbatim**
     (same `pending_from/to_micro`, same `pending_idem`) — do **not** recompute
     against the newer `usage`.
   - Else if `usage_micro > committed_micro`: set
     `pending = { from = committed_micro, to = usage_micro,
     idem = "model_spend:<org>:<from>:<to>" }` and **persist the row first**
     (durable before any Autumn call).
   - `trackAutumnUsage(org, "model_spend", value = round((to−from) × (1 + markup_bps/10000)), idempotency_key = pending_idem)`.
   - On success/`409` → `committed_micro = to`, clear pending. (The interval is
     immutable, so success-then-crash replays the exact same key+interval → true
     dup, never a widened key reused — see §7.)
3. **Halt + push cap (markup-correct, aggregate across keys — P1-b, P1-rotation, P2-halt):**
   `remaining_usd = getAutumnCustomer(org).balances.credits.remaining` (read once per
   org, not per key).
   - **If `remaining_usd ≤ 0` → call `projectOrg(org)` to halt immediately**
     (mirrors compute `autumn_meter.ts:112`; do **not** rely on the Autumn webhook
     alone).
   - Headroom is **shared across all of the org's usable keys**, so cap them together:
     clamp every `superseded` key to `limit = its_usage + ε` (small grace so an
     in-flight call can finish), then set the **active** key to
     `limit = active_usage + remaining_usd/(1+markup) − Σε(superseded)`. Total
     spendable across keys ≤ `remaining/(1+markup)` (a single active key reduces to
     §7's formula). `PATCH` each only if it moved past an epsilon. *(Capping only the
     active key — the previous wording — let a superseded key keep old headroom and
     double the budget.)*
4. **Detail → ClickHouse (org/model/day only, P1/P2-d):** `POST /api/v1/analytics/query`
   `dimensions:["api_key_id","model"], granularity:"day"`, metrics
   `total_usage,tokens_prompt,tokens_completion` → map `api_key_id`→org → upsert
   `model_usage`. **Per-session is not derivable** (analytics has no session dim on
   an org-level key); session-level needs per-session keys (§9.1) or runtime
   self-reported usage (display-only) — both deferred.

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

### 5.8 Offboard / rotate / disable — per-key, watermarked (P2-g)
Each key has its **own** `committed_micro`; nothing is reset or transferred between
keys (resetting/transferring is what dropped or double-counted spend before).
- **Disable managed:** mark the `active` row `deleting`; keep polling it (steps 2/4)
  until its `usage` stops advancing for N ticks (spend quiesced), do a final debit,
  then `DELETE /api/v1/keys/{hash}` + revoke the managed credential. If no `active`
  key remains, `orgs.model_billing_status='off'`.
- **Rotate (compromise):** create a **new** key (new `active` row), re-seal the
  managed credential (rotation flows to running sessions, `core/credentials.ts:165`),
  mark the old row `superseded`. **Both rows keep independent watermarks and keep
  being polled** until the old key (still sealed into in-flight sessions until they
  reseal) quiesces → `deleting` → delete.

### 5.9 BYO path
- An agent whose source is a **BYO credential** (not `"managed"`): the customer's own
  key (raw provider key, or — §9.4 — their own OR key). No OC-provisioned OR key, no
  cap management, **no Autumn debit**; the provider / their own OR account bills them.
  Optionally capture runtime self-reported usage → ClickHouse for display only.

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
- Per-request usage: OR returns `response.usage` (incl. cost) **automatically**; the
  legacy `usage:{include:true}` request flag is **deprecated** — don't depend on it.
  `GET /generation?id=<id>` returns one generation's cost. (Optional display capture
  only; billing truth is the per-key `usage` poll.)

### 6.2 Autumn — what the edge calls (auth: `AUTUMN_SECRET_KEY`; existing helpers in `autumn_webhook.ts`)
- `POST /track` `{ customer_id: org_id, feature_id: "model_spend", value, idempotency_key }`
  (via `trackAutumnUsage`). `value` in micro-credits (§7).
- `GET /customers/{org_id}` `→ balances.credits.remaining` (via `getAutumnCustomer`)
  — for the cap push.
- **Setup (once):** define feature `model_spend` and add
  `{ metered_feature_id:"model_spend", credit_cost: 1e-6 }` to the `credits`
  credit_schema (dashboard or API).

### 6.3 New internal/edge endpoints & hooks
- **Provisioning hook** (edge) driving the §5.1 state machine on managed-enable.
- **`POST /internal/managed-credential` (sessions-api) — carries a plaintext model
  key, so harden it (P2-f).** Do **not** reuse the generic static `X-Internal-Auth`
  header (`requireWorkerAuth`, `auth/worker.ts`). Dedicated secret + HMAC over
  `timestamp + method + path + body`, replay window, log redaction, network
  restriction. **Exact body, idempotency key, and the `GET` lookup variant live in
  §6.7.5 (single source of truth) — don't restate the body here** (that's how the two
  drifted).
- **`model_meter` cron** (§5.4) + **reconcile cron** (§5.7) as wrangler
  `[triggers] crons`.

### 6.4 Dashboard (web)
- **`/billing` gains `managedAvailable`** (the single gating authority, §6.6/P2):
  the edge derives it from `model_billing_status === 'active'`; add it to
  `BillingStateSchema` (`schemas.ts:188-195`). The UI gates the Managed picker entry
  on this field.
- **Agent create/edit dialog:** the credential picker gains the pinned
  `Managed · billed to credits` entry (full taxonomy §6.6); filter the model
  dropdown by the **runtime** (not the source). The Credentials page is **unchanged**.
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
- **ClickHouse `model_usage`** (display detail; not billing-authoritative):
  `org_id String, day Date, model String, tokens_prompt UInt64,
  tokens_completion UInt64, cost_usd Float64`, ordered `(org_id, day, model)`;
  upserted from the analytics poll (§5.4 step 4). **No `session_id`** — an org-level
  key isn't session-attributable from the analytics dims (P1/P2-d); session-level is
  deferred (per-session keys §9.1, or runtime self-reported usage as display-only).
  Authoritative billing stays in Autumn; this feeds the dashboard + drift checks.

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
- **One authority (P2):** the edge `/billing` response exposes `managedAvailable`
  (= `model_billing_status === 'active'`). The UI gates on **that** (not on
  `billingProvider`), and sessions-api enforces the *same* condition (a managed
  credential is bound — set only when status flips to `active`). UI, edge, and
  backend agree, so a user is never offered Managed only to hit `422
  managed_unavailable` (e.g. an autumn org mid-provisioning).
- **Model list depends on the RUNTIME, not the source (P1/P2):** the model must match
  the runtime's protocol either way (`claude`→`anthropic/…`, `codex`→`openai/…`).
  Managed changes *who pays*, not *which models* — both Managed and BYO show the
  runtime's models. (Managed's broader reach is **across agents/runtimes**, not within
  one agent.)
- **§9.7:** claude *likely* feasible, **codex unvalidated** (the `wire_api:"responses"`
  path — §5.2/§9.7); a runtime is offered under Managed only once its OR path is
  validated end-to-end.

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
(`ownerIdForKey`, `auth/org.ts`); `billing_provider`/`autumn` live only in the edge D1 + Go cell,
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
   - HTTP bodies stay `string`: `CreateAgentBody.credential` / `PatchBody.credential`
     (`api/agents.ts`) — accept the literal. SDK widens
     `CreateAgentParams.credential` (`agents.ts:13`) / `UpdateAgentParams.credential`
     (`:23`) to a `CredentialRef` union — mirror the **existing `Runtime` type**
     (`types.ts:15`, shipped in #448; same `"…" | (string & {})` shape).
   - Core branch: in `createAgent` (`core/agents.ts:157-163`) and `patchAgent`
     (`core/agents.ts:252-265`) add a `credential === "managed"` arm **before**
     `assertCredentialProvider` — skip the **credential**-provider check (no BYO cred
     to match) and mint nothing. **`assertModelMatchesRuntime` still runs (P1/P2):**
     Managed does *not* loosen the model↔runtime rule, so `model` must remain the
     runtime's provider (`claude`→`anthropic/…`, `codex`→`openai/…`); a mismatch is a
     `400` for Managed too. (Hence "models supported by the selected runtime," never
     "all models.")
   - **Storage of the sentinel (sub-decision):** store the literal `"managed"` in
     `agent_core.agents.credential_id` (TEXT, no FK enforced, `db/schema.ts:29-43`)
     — minimal, and request/storage/response all use one field; `serializeAgent`
     passes it through (`core/agents.ts:78-92`). *Alt:* a dedicated
     `agents.model_source` column with `credential_id` NULL — more explicit,
     +migration +serialize/SDK plumbing. **Rec: sentinel-in-`credential_id`** (the
     contract is already "the `credential` field carries the source").

2. **Resolution** (`resolveCredentialForSession`, `core/credentials.ts:214-245`):
   add an arm — if `agent.credentialId === "managed"` (or org default is managed,
   see 3) → resolve via a **separate `getManagedCredential(owner)` helper that
   ignores the `provider` arg** (G7). The resolver is called with the *runtime's*
   provider (`session-service.ts:102`, `runtime/credential.ts:96`), but the managed
   cred's provider is `"openrouter"`, so a provider-keyed lookup would miss it.
   Found → return its id (`source:"managed"`); **not found → throw
   managed-unavailable**. **Both call sites (resolve + seal) route through this one
   helper.** Existing pin/org-default/null arms unchanged.

3. **Org default = managed.** Today org default = the `is_default` credential per
   `(owner, provider)` (`core/credentials.ts:198-206`). Add: when no `is_default`
   BYO credential resolves AND the owner has a managed credential → default to
   managed. New orgs (no BYO default) thus default Managed; existing orgs with an
   `is_default` credential are unaffected. *(No `PUT /credentials/default` change
   for v1; "managed is default" = simply having no default BYO credential.)*

4. **`422 managed_unavailable` + seal keyed on (runtime, source), not provider (G3).**
   New error class beside `NoCredentialError` (`core/session-service.ts:27-33`),
   thrown from `startSession` (`session-service.ts:100-103`) when managed is
   selected/defaulted but no managed credential exists; wire-mapped beside the
   `no_credential` arm (`api/sessions.ts:173-175`) → `422 {type:"managed_unavailable"}`.
   **Bigger than one line:** `sealCredentialForSession` (`runtime/credential.ts`)
   derives the env-var name + egress host from the cred's `provider` via
   `PROVIDER_KEY_ENV` / `PROVIDER_EGRESS_HOST` (only `anthropic`/`openai`). For Managed
   the cred provider is `"openrouter"`, but the env var must be `ANTHROPIC_AUTH_TOKEN`
   (claude) / `OPENAI_API_KEY` (codex) and the egress host `openrouter.ai` — so seal
   needs a **(runtime, source)** input that overrides env-name + egress host **and**
   supplies the base URL via `endpoint_profile` (§5.2 / G1). Also add `openrouter.ai`
   to the per-session egress allowlist (`storeEgressAllowlist`, fed `modelHosts` from
   the runtime build in `session-service.ts`) for Managed.

5. **Provisioning hand-off (the §9.5 seam) — one exact contract** (this is the single
   source of truth; §6.3 matches it verbatim):
   - `POST /internal/managed-credential` (sessions-api). **Auth: a dedicated secret
     `OC_MANAGED_CRED_HMAC_SECRET`** (NOT `V3_INTERNAL_AUTH_SECRET` / the static
     `X-Internal-Auth`), HMAC over `timestamp + method + path + body`, short replay
     window, body redacted in logs, network-restricted (P2-f). Body
     `{ owner_id, provider:"openrouter", key, or_key_hash, operation_id }`. Effect:
     store via `reserveAndWrite`/secret-ledger + insert a managed `credential_metadata`
     row (provider `"openrouter"`, fixed `name`, **persisting `or_key_hash` +
     `operation_id`**); return `managed_credential_id`. **Idempotent per
     `(owner_id, operation_id)`** (re-call = rotate, `rotateCredentialKey`
     `core/credentials.ts:165`).
   - `GET /internal/managed-credential?owner_id=&or_key_hash=` (same auth) → whether a
     managed credential is bound — the edge's lost-response recovery (§5.1).

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
   (wire-mapped to `400 {type:"invalid"}` today, `api/agents.ts:52,98`; add a distinct
   `invalid_credential` type only if you want it separable) for anything that is
   neither `"managed"` nor `^cred_`. Call it in `createAgent`/`patchAgent` **before** the source branch so a
   malformed ref fails fast and distinctly (today an unknown string only fails later
   as "credential not found"). Also tighten credential **create** `provider`
   (`api/credentials.ts`) to the closed `"anthropic" | "openai"` — the internal
   `"openrouter"` managed provider is system-only, never user-supplied. SDK
   (`sdks/typescript/src/agents`): `Credential.id: CredentialId`,
   `CreateAgentParams.credential?: CredentialRef`,
   `UpdateAgentParams.credential?: CredentialRef | null` so `credential: cred.id`
   and `credential: "managed"` typecheck while arbitrary strings don't.

8. **`key` and `credential` are mutually exclusive (P3).** Today create/patch accept
   both (`api/agents.ts:35,88`). Enforce one source per request: supplying both →
   `400 {type:"invalid"}` (reuse `AgentValidationError`, `api/agents.ts:52,98` — no new
   type needed); `credential:"managed"` + `key` → same `400`. Inline `key` stays the
   BYO shortcut; `credential` selects an existing source (`"managed"` or `cred_…`).

### 6.8 UI deltas (exact)

Repo `opencomputer/web`. **Most of what this section originally specced shipped in
PR #448** — so the Managed delta is now small. Symbol refs (line numbers drift).

**Already shipped (#448) — do NOT re-implement:**
- Shared **`web/src/lib/runtimes.ts`** (`RUNTIMES` → `{provider, models, keyLabel,
  keyPlaceholder}`, `getRuntime`, `defaultModelFor`, `runtimeOptions`), imported by
  both `Agents.tsx` and `AgentDetail.tsx`. (This *is* the §6.8.G shared-lib pattern.)
- **Model list is runtime-derived** in both pickers (create: `options={rt.models}`;
  detail: `modelOptions` from `rt.models`). There is no `MODELS` const and no
  `.filter` to add. Managed adds **no** model widening — model follows the runtime,
  independent of source.
- **Credential list filtered by the runtime's provider** in both
  (`credentials.filter(c => c.provider === rt.provider)`).

**Remaining Managed delta (the only UI work):**

**A. Create dialog — `Agents.tsx`.** Add a `MANAGED='managed'` sentinel; prepend a
`Managed · billed to credits` entry to `credOptions` **outside** the provider filter
(Managed has no provider). In the create mutation, send `credential:"managed"` when
chosen (no key needed — the non-`NEW_CRED` path already allows an empty key). Default
the picker to Managed when `managedAvailable` (C).

**B. Live picker — `AgentDetail.tsx`.** Same `Managed` entry in `credOptions`; map
`agent.credential_id === 'managed'` to it in the selected value; on select,
`switchCredMutation.mutate('managed')` (already calls `updateAgent(id,{credential})`).

**C. Gating — `managedAvailable`, the single authority (P2).** Neither dialog reads
billing today. Add a `getBilling` query and show the Managed entry only when
`billing?.managedAvailable` — a **new** field on `/billing` (= edge
`model_billing_status === 'active'`; add to `BillingStateSchema`). Do **not** gate on
`billingProvider === 'autumn'` (an autumn org mid-provisioning would offer Managed
then `422`). UX-only; backend enforces via §6.7.4. **Coupling caveat (G4):** this
equals the backend's "managed credential bound" check only while §5.1 keeps
`status='active'` ⟺ credential-bound — the partial states (§5.1/§10) are where they
diverge, so reconcile must close that window.

**D. API layer (`web/src/api/`).** `createAgent`/`updateAgent` `credential` already
accept any string, so `"managed"` needs no client change (tighten to `CredentialRef`
per G). Hide internal `"openrouter"` managed rows from the credentials list if the
backend returns them (§6.7.6). Add a Managed mock fixture (`mock.ts`).

**E. Credentials page — `web/src/pages/Credentials.tsx`: UNCHANGED** (self-contained
CRUD; no dependency on the dialogs).

**F. Billing model-spend panel (from §6.4).** `PrepaidPlan` (`Billing.tsx:249`),
grid `:291`; add a `ModelUsageBreakdown` `<Panel>` beside `<UsageBreakdown/>`
(`:408`, component `:589`); reuse `Panel`/`ResourceTable`/`formatCost`.

**G. Credential-source type (rescoped — the runtime shared-lib already exists in #448).**
`runtimes.ts` already DRYs the model/runtime/provider axis. What's **not** factored is
the **credential-source** selection, still crammed as sentinels (`'__new__'`,
`'__default__'`, `'managed'`) in one `string` state, with the two pickers diverged
(detail has `ORG_DEFAULT`, create doesn't). Add a sibling
`web/src/lib/credential-source.ts` (same pattern as `runtimes.ts`): the union
`Source = {kind:'managed'} | {kind:'orgDefault'} | {kind:'credential'; id: CredentialId} | {kind:'new'}`,
the `Select`-value ↔ `Source` map, and `toWire(source): CredentialRef | null | undefined`
(managed→`"managed"`, credential→id, orgDefault→`null` on patch / omit on create,
new→post-create id); import in both. Type the web client `credential` as
`CredentialRef` + zod `z.union([z.literal('managed'), z.string().startsWith('cred_')])`.

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
- **Watermark** = per-key `managed_model_keys.committed_micro` = OR `usage` already
  debited (micro-USD, `round(usage_usd × 1e6)`). OR `usage` is monotonic.
- **Debit per tick — immutable interval, persist before track (P1-a).** The in-flight
  interval is written to the key row **before** the Autumn call
  (`pending_from/to_micro`, `pending_idem = "model_spend:<org>:<from>:<to>"`).
  `value = round((to − from) × (1 + markup_bps/10000))`. Advance
  `committed_micro = to` and clear pending **only after** track success/`409`. On
  restart a pending interval is retried **verbatim** (never recomputed against newer
  `usage`). ⇒ **exactly-once**: the key always maps to one fixed interval, so a
  success-then-crash replay is a true dup (no dropped tail, no widened key).
  - Why the naive forms are wrong: keying on the **start watermark only** drops the
    new spend (a post-crash retry computes a larger delta but reuses the old key →
    `409` → watermark jumps, tail lost). Keying on `from:to` **without persisting the
    interval first** double-charges (a pre-persist crash recomputes `from:to_new`, a
    new key, charging the already-charged `from:to_old` again). Persist-then-track
    with an immutable interval is the only correct form.
- **Cap push — markup-correct (P1-b).** The OR cap bounds **provider** spend, but
  Autumn charges `provider × (1+markup)`. To make the Autumn balance the hard
  customer budget:
  `new_limit_usd = usage_usd + remaining_usd / (1 + markup_bps/10000)`
  (`remaining_usd = balances.credits.remaining`). `PATCH` only past an epsilon.
  Setting `usage + remaining` (no markup divisor) would let OR allow `$remaining` of
  provider spend while Autumn charges `remaining×(1+markup)` > balance → overspend.
- **No negatives:** OR `usage` never decreases; refunds/credits are handled on the
  Autumn side (grant credits), not by reversing OR.

---

## 8. Instrumentation (don't ship without these)

Emitted from the edge crons + provisioning hook; surfaced in the existing metrics
stack (and ClickHouse where noted).

**Keep metric labels low-cardinality — no org-id labels** (P3-i); per-org detail
lives in structured logs + ClickHouse, queryable without exploding the metric store.

- **Counters (no `{org}`):** `model_or_key_provision_total{result}`,
  `model_or_key_delete_total{result}`, `model_cap_update_total{result}`,
  `model_spend_debit_micro_credits_total` (sum of `value`),
  `model_meter_track_total{result=ok|dup|err}`,
  `model_or_api_errors_total{op,http_code}`, `model_halt_resume_total{action}`.
- **Gauges:** `model_meter_sync_lag_seconds` (now − last successful tick),
  `model_or_account_balance_usd` (our float; **alert** low),
  `model_managed_orgs_active`. (Per-org `cap_remaining` → logs/ClickHouse, not a gauge.)
- **Reconcile:** `model_reconcile_drift_usd` aggregate (Σ OR spend − Σ Autumn
  debits); **alert** if `|drift|` or its rate exceeds threshold. Per-org drift →
  structured logs / a ClickHouse view.
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

**9.7 Runtime ↔ OpenRouter protocol (claude likely; codex UNVALIDATED — gate build on this).**
`claude`/Anthropic: OR documents a Claude-Code path
(`ANTHROPIC_BASE_URL=https://openrouter.ai/api` + `ANTHROPIC_AUTH_TOKEN`) — *likely*
feasible, still validate in our runtime. `codex`/OpenAI: **not** a clean "set
baseURL" — our v3-codex pins `wire_api:"responses"` + `requires_openai_auth:true`
(`v3-codex/server.ts:113–114`), and OR's OpenAI-compatible surface is
chat/completions-centric; whether the Responses API + non-OpenAI-auth path works
through OR is **unverified**. **The work** (§5.2): each runtime currently *blocks*
base-URL injection — v3-claude **deletes** both `ANTHROPIC_AUTH_TOKEN` and
`ANTHROPIC_BASE_URL` (`server.ts:~87–88`), v3-codex **hardcodes** the OpenAI provider
block (`server.ts:~111–114`) — so make both configurable and **validate end-to-end
(protocol + tool calls + usage/cost echo) before offering each runtime under Managed.**
A runtime not yet validated is simply not offered. This spike (esp. codex) gates the
build (open-q #4).

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
guard → `400 {type:"invalid"}` (`AgentValidationError`; §6.7.7). The UI models the picker selection as a
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
- **Provisioning hand-off (edge→sessions-api) fails** → partial state (OR key but no
  bound credential). `model_billing_status` stays `provisioning`; Managed resolves to
  **`422 managed_unavailable`** (not `no_credential`). The state machine (§5.1) +
  reconcile (§5.7) repair each partial case — OR-key-without-credential,
  credential-without-status-flip, status-`active`-without-key. Bounded retries →
  `status='error'` + alert.

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
