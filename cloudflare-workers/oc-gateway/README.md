# oc-gateway — thin per-session Worker over OpenRouter

**W3 (productionized) / Lane L2** for the Flue-native agent type (`oc-bg-agents .agents/work/flue-native-buildout.md`, design `013 §4`). Implements **inter-lane Contract #1** (Gateway HTTP contract), hardened from the 1a spike (`spike/oc-gateway`, #486) and **live-verified** against real OpenRouter.

It **extends** the shipped managed-model path (does not replace it): org-level spend keeps flowing through the org's single OpenRouter inference key → the existing `model_meter` cron → Autumn (`opencomputer/cloudflare-workers/api-edge/src/{model_billing,model_meter,openrouter}.ts`, `token-billing.md`). The gateway only adds the injection point a CF Worker needs (it can't use the box secrets-proxy) plus **per-session sub-metering + on-path budget enforcement**.

---

## Contract #1 — the Gateway HTTP contract

### 1. Path shape

```ts
registerProvider('anthropic', { baseUrl: `${env.OC_GATEWAY}/anthropic`, apiKey: <session_token> });
```

| Gateway request | Forwarded to OpenRouter |
|---|---|
| `POST {gw}/anthropic/v1/messages` | `POST https://openrouter.ai/api/v1/messages` (Claude-Code path) |
| `POST {gw}/openai/chat/completions` | `POST https://openrouter.ai/api/v1/chat/completions` |
| `GET  {gw}/healthz` | — (liveness) |

Rule: `/{provider}/<tail>` → `<OR base for provider> + <tail>`, query string preserved. `cloudflare/<model>` is **out of scope** — `env.AI.run()` bypasses `fetch`, so the gateway can't meter it (design §4).

### 2. Per-session token — EdDSA, with a lease-epoch fence

A compact **EdDSA (Ed25519) JWT** the tenant Worker holds as the provider `apiKey`. The **minter** (control plane / session DO) holds the private key; the **gateway holds only the public key** (`GATEWAY_TOKEN_PUBLIC_KEY` = base64url raw 32-byte Ed25519 public key) — the same asymmetry as the turn token, so a compromised gateway can't forge tokens.

**Claims:** `{ sub: ses_, org, agt, bud?, ep?, iat, exp }` — `sub` = sub-meter/budget key; `org` selects the org's OR key; `bud` = per-session USD cap (omit/0 = uncapped); `ep` = lease/turn epoch.

**Transport:** `Authorization: Bearer <token>` or `x-api-key: <token>`. **Verify:** alg pinned to `EdDSA` (rejects `none`/HS256 swaps) + signature + `exp`/`iat` + required claims → `401` on failure.

**Lease-epoch fence:** the `SessionBudget` DO tracks a monotonic `max_epoch`; a token whose `ep` is below it is **superseded** → `401 {code:"token_superseded"}`. A newer epoch bumps the watermark, invalidating older-epoch tokens still in flight (DO-serialized). Omitted `ep` skips the fence.

> **Mint↔verify seam (confirm with the orchestrator):** W1 signs the EdDSA token; default delivery = per-turn token (option a) read by Flue's `getApiKey`, so the meter attributes by `sub` unspoofably. The gateway is configured with the public key only.

### 3. Request/response passthrough

- **Body:** buffered (small), **`cache_control` stripped for caching-unsafe models** (§6), `usage:{include:true}` injected so OR echoes cost, re-serialized; all else preserved.
- **Auth swap:** the tenant token is stripped; `Authorization: Bearer <org OR key>` set; `http-referer`/`x-title` added. Everything else (`anthropic-version`, …) passes through.
- **Response:** OR's status/headers/body returned **untouched** — JSON or `text/event-stream` (SSE straight through). Transparent proxy on the response path.

### 4. Metering + reconciliation

- **On-path sub-meter** in a `SessionBudget` **DO** (strongly consistent — serializes concurrent calls so subagents can't double-spend). `POST /check` gates **before** (`spent < budget`) + runs the epoch fence; `POST /add` commits cost **after** (via `waitUntil`), idempotent on the OR generation id.
- **Cost source:** the `usage.cost` (USD) OR echoes per response (`cost.ts`; SSE terminal usage). Fallback `GET /api/v1/generation?id=` (unwired).
- **One cost-source-of-truth:** the gateway forwards through the **org's existing OR key**, so OR's per-key usage still captures Flue spend → `model_meter` cron → Autumn, **exactly as the brain-box path does**. The gateway builds no billing path and pushes nothing to Autumn; its counter is enforcement + per-session display only (optionally emitted to `OC_INGEST`).
- **Budget refusal:** `402 {error:{type:"budget_exceeded", code:"insufficient_quota"}, oc:{spent_usd,budget_usd}}` — a provider-style error so the turn terminates and the tailer maps it to outcome `budget_exceeded`. Bounded **one-call overshoot** (a call that passes pre-check but tips the total over) is accepted.

### 5. Org OpenRouter key resolution

The gateway maps `org_id → OR inference key`. The plaintext lives in **Infisical**, sealed by sessions-api (edge `managed_model_keys` owns the key lifecycle; `credential.ts resolveManagedSecret`). A CF Worker can't reach Infisical, so the gateway resolves through a **dedicated internal sessions-api seam** (mirrors the edge's dedicated-secret plaintext-key hand-off — a route carrying a live key gets its own secret):

```
POST {GATEWAY_ORKEY_URL}   Authorization: Bearer {GATEWAY_ORKEY_SECRET}   {"org": orgId}  →  {"key": "sk-or-..."}
```

Cached per org in-isolate (60s TTL — bounds exposure + avoids per-call hits). `TEST_OR_KEY` short-circuits resolution for the acceptance run. **L3 seam to build:** the route reusing `resolveManagedSecret` (flagged in the W3 PR).

### 6. Prompt-caching safety

Some models route (via OR) to a backend that rejects Anthropic `cache_control` — `anthropic/claude-3-haiku` (→ Bedrock) **400s** the whole request. The gateway **strips `cache_control`** from the body for an env-extensible denylist (`models.ts`, `CACHE_CONTROL_UNSAFE_MODELS`); caching-capable models are untouched.

---

## What's here

| File | Role |
|---|---|
| `src/index.ts` | the Worker: verify → epoch-fence + budget gate → org-key inject → cache-safe + usage → forward → tee-meter → passthrough |
| `src/token.ts` | EdDSA session token verify + mint/keygen helpers (Web Crypto, no deps) |
| `src/budget.ts` | `SessionBudget` DO — per-session spend counter + hard gate + epoch fence (µ$ integers) |
| `src/orgkey.ts` | org OR-key resolver — internal seam + per-isolate cache + test override |
| `src/models.ts` | `cache_control` safety (unsafe-model denylist + strip) |
| `src/cost.ts` | per-response cost extraction (JSON + SSE) |
| `scripts/mint.ts` | EdDSA mint helper (generates a keypair; mints a session token) |
| `test/` | `logic` (15) + `integration` (8, real handler + real DO vs mock OR) — **23 green** |

## Verification

**Unit + integration (`npx vitest run`, 23 green):** EdDSA mint/verify + alg-pin + wrong-key/expired/tamper; `SessionBudget` epoch fence + budget gate + `/add` idempotency; `cache_control` strip; cost extraction; and the full on-path flow through the real handler (401 no/bad token, org-key injection with the session token never reaching OR, `usage.include`, passthrough, on-path 402, epoch fence 401, cache_control strip).

**Live acceptance (run 2026-07-05 against real OpenRouter via `wrangler dev --local`, throwaway $1-capped OR key, torn down after):**
- Happy path — a real `anthropic/claude-haiku-4.5` turn completed gateway → OpenRouter → `200`, answer `pong`, `usage.cost` echoed; **no OR key in the response**; token ≠ key.
- Budget — `bud=$0.000001`: call 1 `200` (spent $3.8e-05) → call 2 **`402 budget_exceeded`** on-path.
- cache_control — `claude-3-haiku` with a `cache_control` block: **via gateway `200`** (stripped) vs **direct-to-OR `400`** (proves the strip is necessary and works).
- Epoch fence — epoch 2 adopted → epoch 1 **`401 token_superseded`**. Auth — no/garbage token **`401`**.

### Reproduce the live run

```bash
# secrets in .dev.vars (gitignored): the gateway's public key + a real OR key
GATEWAY_TOKEN_PUBLIC_KEY=<from scripts/mint.ts stderr>
TEST_OR_KEY=<a real openrouter inference key>

npx wrangler dev --port 8791 --local
# mint a token with the matching private key, then POST a real turn:
GATEWAY_TOKEN_PRIVATE_KEY=<b64url pkcs8> node --experimental-strip-types scripts/mint.ts \
  --session ses_live --org org_1 --budget 0.05
curl -sN -X POST http://localhost:8791/anthropic/v1/messages \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"model":"anthropic/claude-haiku-4.5","max_tokens":16,"messages":[{"role":"user","content":"say pong"}]}'
```
