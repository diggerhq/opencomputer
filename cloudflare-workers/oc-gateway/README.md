# oc-gateway — thin per-session Worker over OpenRouter

**Spike C / Lane L2** for the Flue-native agent type (`oc-bg-agents .agents/work/flue-native-buildout.md`, design `013 §4`). This is the **frozen inter-lane Contract #1** (Gateway HTTP contract) plus a runnable minimal Worker that proves it.

It **extends** the shipped managed-model path (does not replace it): org-level spend keeps flowing through the org's single OpenRouter inference key → the existing `model_meter` cron → Autumn (`opencomputer/cloudflare-workers/api-edge/src/{model_billing,model_meter,openrouter}.ts`, `token-billing.md`). The gateway only adds the injection point a CF Worker needs (it can't use the box secrets-proxy) plus **per-session sub-metering + on-path budget enforcement**.

---

## Contract #1 — the Gateway HTTP contract

### 1. Path shape

An unmodified Flue app registers a managed provider at the gateway:

```ts
registerProvider('anthropic', { baseUrl: `${env.OC_GATEWAY}/anthropic`, apiKey: <session_token> });
```

The provider client appends its native tail; the gateway strips the provider prefix and forwards to the OpenRouter base the box path already uses (`credential.ts` `MANAGED_ANTHROPIC_BASE = https://openrouter.ai/api`):

| Gateway request | Forwarded to OpenRouter |
|---|---|
| `POST {gw}/anthropic/v1/messages` | `POST https://openrouter.ai/api/v1/messages` (Claude-Code path) |
| `POST {gw}/openai/chat/completions` | `POST https://openrouter.ai/api/v1/chat/completions` |
| `GET  {gw}/healthz` | — (liveness) |

Rule: `/{provider}/<tail>` → `<OR base for provider> + <tail>`, query string preserved. Only `anthropic` is proven in this spike; `openai` shares the shape (for the codex family). `cloudflare/<model>` is **out of scope** — `env.AI.run()` bypasses `fetch`, so the gateway can't meter it (design §4).

### 2. Per-session token — format + verification

A compact **HS256 JWT** the tenant Worker holds as the provider `apiKey`. Minted by the session's DO / sessions-api; verified on-path by the gateway (single trust domain).

**Claims:** `{ sub: <session_id>, org: <org_id>, agt: <agent_id>, bud?: <budget_usd>, iat, exp }`
- `sub` — session id: the sub-meter + budget key.
- `org` — selects the org's OpenRouter inference key (never leaves the gateway).
- `agt` — attribution only.
- `bud` — per-session hard budget in **USD**; omit/`0` = uncapped.

**Transport:** `Authorization: Bearer <token>` **or** `x-api-key: <token>` (Anthropic-style clients use the latter). The gateway accepts either.

**Verification:** signature (`crypto.subtle.verify`, constant-time) + `exp`. On failure → `401 {error:{type:"unauthorized"}}`.

> **Prod hardening (flagged, not in the spike):** switch to **EdDSA** — the minter holds the private key, the gateway holds only the public key (same asymmetry as the turn token), and **fence** on the session's lease epoch so a superseded token stops verifying. HS256 (shared secret) is the spike choice.

### 3. Request/response passthrough

- **Request body:** buffered (model requests are small), `usage:{include:true}` injected so OpenRouter echoes cost, re-serialized. All other fields preserved.
- **Auth swap:** the tenant's `Authorization`/`x-api-key` is stripped; `Authorization: Bearer <org OR key>` is set. `http-referer`/`x-title` added for OR attribution. Everything else (content-type, `anthropic-version`, …) passes through.
- **Response:** OpenRouter's status, headers, and body are returned **untouched** — JSON or `text/event-stream` (SSE streams straight through to Flue). The gateway is a transparent proxy on the response path.

### 4. Metering hook + reconciliation

- **On-path sub-meter:** per session, in a `SessionBudget` **Durable Object** (strongly consistent — serializes concurrent calls so subagents/parallel tools can't double-spend past the cap). `POST /check` gates **before** the call (`spent < budget`); `POST /add` commits the response's cost **after** (off the response path via `waitUntil`), idempotent on the OpenRouter generation id.
- **Cost source:** the `usage.cost` (USD) OpenRouter echoes per response (`cost.ts`; for SSE, the terminal usage chunk). Exact-cost fallback: `GET /api/v1/generation?id=<id>` (documented, unwired).
- **Reconciliation — one cost-source-of-truth:** the gateway forwards through the **org's existing OR inference key**, so OR's per-key cumulative usage still captures Flue spend → `model_meter` cron → Autumn, **exactly as the brain-box path does today**. The gateway builds **no** billing path and pushes **nothing** to Autumn. Its per-session counter is for **enforcement + per-session display only** (optionally emitted to `OC_INGEST`); it and OR's per-key usage are independent by design and need not reconcile to the penny.
- **Budget refusal:** `402 {error:{type:"budget_exceeded", code:"insufficient_quota"}, oc:{spent_usd,budget_usd}}` — shaped as a provider-style error so the Flue/pi-ai turn terminates and the tailer maps it to outcome `budget_exceeded` (§8). *The exact shape Flue surfaces cleanly is a live-verify item.*

### 5. Org OpenRouter key resolution

The gateway maps `org_id → OR inference key`. **Prod:** fetch the org's sealed OR key from the credential store (Infisical) via the internal seam, cached per-org. **Spike stand-in:** `ORG_KEYS` KV (`org_id → key`), or a single `SPIKE_OR_KEY` secret for one-org verification.

### Explicit answer: per-session OR keys vs. on-path counter

**On-path token counter — confirmed; per-session OR keys are the wrong tool.**

- **Per-session OR keys would break the "one cost-source-of-truth" invariant.** The `model_meter` cron reconciles *per-org* keys to Autumn; minting an OR key per session (thousands of them) multiplies the reconciliation surface and fragments org billing, and adds a per-session key lifecycle (create/cap/delete) at session scale. OR key caps are also coarse USD limits — wrong granularity for fast per-session budgets.
- **The gateway is already on the path**, so it reads the cost OR echoes and enforces **before/after each call** — authoritative, not the best-effort `observe()` the design relegates to Tier-3. The per-session counter is a **sub-ledger under the org's single key**; org spend still flows through that one key to Autumn, unchanged.
- **Cost:** a bounded **one-call overshoot** (a call that passes the pre-check but whose cost tips the total over) — acceptable for "refuse past the limit". Proven in `test/integration.test.ts` (budget $0.03, $0.02/call → 2 pass, 3rd refused at $0.04).

---

## What's here

| File | Role |
|---|---|
| `src/index.ts` | the Worker: verify → budget gate → org-key inject → forward → tee-meter → passthrough |
| `src/token.ts` | HS256 session token mint/verify (Web Crypto, no deps) |
| `src/budget.ts` | `SessionBudget` DO — per-session spend counter + hard gate (µ$ integers) |
| `src/cost.ts` | per-response cost extraction (JSON + SSE) |
| `scripts/mint.ts` | mint a session token for live verification |
| `test/` | `logic` (token/cost, 8) + `integration` (real handler + real DO vs mock OR, 6) — **14 green** |

## Verification status

- **In-process integration (green, CI-able):** `npx vitest run` drives the real worker handler + real `SessionBudget` DO with `fetch` stubbed to a mock OpenRouter. Proves: 401 (no/expired token), forward with **org-key injection** (session token never reaches OR) + `usage.include`, body passthrough, **on-path budget enforcement** with bounded overshoot, uncapped sessions.
- **One real `anthropic/*` turn — documented, not run here** (no OpenRouter key / dev env in this environment; the buildout allows documenting it). The wire format is already validated for the managed path (§9.7 spike: OR echoes cost on both inference paths).

### Live verification (run when an OR inference key + a workers.dev/dispatch env are available)

```bash
# 1. secrets (dev): a real OR inference key + a token secret
cat > .dev.vars <<EOF
GATEWAY_TOKEN_SECRET=$(openssl rand -hex 16)
SPIKE_OR_KEY=<a real openrouter inference key>
EOF

# 2. run the gateway locally (or `wrangler deploy` to an isolate)
npx wrangler dev --port 8798 --local

# 3. mint a session token bound to a $0.05 budget
TOKEN=$(GATEWAY_TOKEN_SECRET=<same secret> \
  node --experimental-strip-types scripts/mint.ts --session ses_live --org org_1 --budget 0.05)

# 4. one real anthropic turn THROUGH the gateway (unmodified-Flue shape)
curl -sN -X POST http://localhost:8798/anthropic/v1/messages \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"model":"anthropic/claude-sonnet-5","max_tokens":64,"messages":[{"role":"user","content":"say hi"}]}'
#    → expect a real completion; OR bills the org key; the DO records the sub-cost.

# 5. or drive it as a real Flue app (the true acceptance):
#    registerProvider('anthropic', { baseUrl: 'http://localhost:8798/anthropic', apiKey: TOKEN })
#    then run one turn — it completes, and repeated turns refuse once the $0.05 sub-budget is hit.
```

**Acceptance (design §14 / Slice-0):** an unmodified app `registerProvider(baseUrl=gateway)` completes an `anthropic/*` turn; org spend appears on the existing OpenRouter→Autumn path (no new billing); a per-session budget refuses on-path.
