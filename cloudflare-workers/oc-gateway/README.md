# Agent model gateway

The framework-neutral model gateway for hosted OpenComputer agent Workers. Flue is the first
adapter, but the permanent Worker and operator configuration are not framework-named. Contract and
rationale live in `oc-bg-agents` design 013 §4 and work item 022 W7-P.

It **extends** the shipped managed-model path (does not replace it): org-level spend keeps flowing through the org's single OpenRouter inference key → the existing `model_meter` cron → Autumn (`opencomputer/cloudflare-workers/api-edge/src/{model_billing,model_meter,openrouter}.ts`, `token-billing.md`). The gateway only adds the injection point a CF Worker needs (it can't use the box secrets-proxy) plus **org+agt budget enforcement + best-effort per-session sub-metering**. It pushes **nothing** to Autumn.

---

## Contract #1 — the Gateway HTTP contract

### 1. Path shape

An unmodified Flue app registers a managed provider at the gateway **inside `defineAgent`**:

```ts
registerProvider('anthropic', {
  baseUrl: `${env.OC_GATEWAY}/anthropic`,
  apiKey: env.OC_SESSION_TOKEN,        // the per-DEPLOY token (bound by W7 as an env var)
  headers: { 'X-OC-Session': id },     // the DO's own init id = ses_… — best-effort attribution
});
```

The provider client appends its native tail; the gateway strips the provider prefix and forwards to the OpenRouter base the box path already uses (`credential.ts` `MANAGED_ANTHROPIC_BASE = https://openrouter.ai/api`):

| Gateway request | Forwarded to OpenRouter |
|---|---|
| `POST {gw}/anthropic/v1/messages` | `POST https://openrouter.ai/api/v1/messages` (Claude-Code path) |
| `POST {gw}/openai/chat/completions` | `POST https://openrouter.ai/api/v1/chat/completions` |
| `GET  {gw}/healthz` | — (liveness) |

Rule: `/{provider}/<tail>` → `<OR base for provider> + <tail>`, query string preserved. `cloudflare/<model>` is **out of scope** — `env.AI.run()` bypasses `fetch`, so the gateway can't meter it (design §4).

### 2. The deploy token — per-DEPLOY, EdDSA, lease-fenced

**Resolved token seam.** The token is **per-DEPLOY**, not per-session. Flue's `registerProvider` `apiKey` is a static string only, and its provider registry is isolate-global while CF co-locates many session-DOs of one agent's script in one isolate — so per-session data injected via `registerProvider` (the token OR the header) **races** across co-located sessions. Therefore the token carries only `(org, agt)` and the **hard cost-safety boundary is at the org+agt grain**.

**Claims:** `{ org, agt, iat, exp, ep? }` — **no** `sub:session`, **no** `bud`.
- `org` — bare lowercase UUID from canonical owner `oc-org:<uuid>`; selects the org's OpenRouter key.
- `agt` — canonical `^agt_[0-9a-f]{24}$` id for the deployed agent.
- `ep` — optional monotonic deploy epoch; a token below the current lease floor is fenced.

**Prod hardening over the spike:**
- **EdDSA (Ed25519):** the minter (W7 deploy pipeline) holds the private key; the gateway holds only `GATEWAY_TOKEN_PUBLIC_KEY` — a compromised gateway can't forge tokens. Alg pinned (rejects `none`/HS256 swaps).
- **Lease-epoch fence** (`DeployLease` DO, per `${org}:${agt}`): the floor rises to a token's `ep` on first use, so a **rotated** deploy's higher-epoch token instantly supersedes older tokens (401 `token_superseded`). A **revoke without redeploy** is `POST /admin/lease/bump {org, agt, min_epoch}`.

**Transport:** `Authorization: Bearer <token>` **or** `x-api-key: <token>`. Verify = alg-pin + signature + `exp`/`iat` + exact bare-org/agent claim shapes. Failure → `401`.

### 3. Enforcement grain (co-location refinement)

- **HARD (the 402): org+agt.** `SpendCounter` DO keyed `agt:${org}:${agt}` — race-free (the value comes from the token, identical for every co-located session of the agent). `/check` gates **before** the call; over → `402 budget_exceeded`. Budget is looked up **server-side** (provisioned via `/admin/agent/budget`, else `AGENT_BUDGET_USD_DEFAULT`) — **never** carried in the token.
- **BEST-EFFORT per session: `X-OC-Session`.** `SpendCounter` DO keyed `sess:<session>` — the gateway only **records** spend here for per-session visibility (dashboard W11). It is **never gated**, so a co-location race can't wrongly block a legitimate session. Exact per-session enforcement is deferred to an upstream Flue per-request resolver (tracked ask — see below).

### 4. Request/response passthrough

- **Request body:** buffered (model requests are small), `usage:{include:true}` injected so OpenRouter echoes cost, re-serialized. `cache_control` stripped for caching-unsafe models (§6). All other fields preserved.
- **Auth swap:** the tenant's `Authorization`/`x-api-key` **and** the `X-OC-Session` header are stripped; `Authorization: Bearer <org OR key>` set. `http-referer`/`x-title` added for OR attribution. Everything else passes through. **No raw provider key ever reaches the tenant** — it holds only the deploy token; the OR key lives in the gateway.
- **Response:** OpenRouter's status, headers, body returned **untouched** — JSON or `text/event-stream`.

### 5. Metering + reconciliation — one cost-source-of-truth

- **On-path sub-meter:** `/check` gates (org+agt) before; `/add` commits cost after (off the response path via `waitUntil`), idempotent on the OpenRouter generation id. Recorded at the org+agt grain (authoritative for enforcement) **and** best-effort per session.
- **Cost source:** the `usage.cost` (USD) OpenRouter echoes per response (`cost.ts`; SSE terminal usage). Exact-cost fallback `GET /api/v1/generation?id=<id>` (documented, unwired).
- **Reconciliation:** the gateway forwards through the **org's existing OR inference key**, so OR's per-key cumulative usage still captures Flue spend → `model_meter` cron → Autumn, **exactly as the brain-box path does today**. The gateway builds **no** billing path and pushes **nothing** to Autumn. Its counters are for **enforcement + display only**; they and OR's per-key usage are independent by design.
- **Budget refusal:** `402 {error:{type:"budget_exceeded", code:"insufficient_quota"}, oc:{org,agent,spent_usd,budget_usd}}` — a provider-style error so the Flue turn terminates and the tailer maps it to outcome `budget_exceeded` (§8). *The exact shape Flue surfaces cleanly is a live-verify item.*

### 6. Org OpenRouter key resolution (from Infisical, via a sessions-api seam)

The managed OR **inference** key's plaintext lives in **Infisical**, referenced by the org's managed credential and resolved only by `sessions-api` `resolveManagedSecret` (`credential.ts`). A CF Worker can't reach Infisical or the box secrets-proxy (design §4), so the gateway resolves it through a **dedicated internal sessions-api route** — mirroring the edge's dedicated-secret plaintext-key hand-off (`model_billing.ts §6.7.5`: a route carrying a live key gets its **own** secret, not the generic internal-auth one):

```
POST {GATEWAY_ORKEY_URL}   Authorization: Bearer {GATEWAY_ORKEY_SECRET}   body {"org": orgId}
  → 200 {"key": "sk-or-..."}   (resolveManagedSecret for the org's active managed credential)
```

The plaintext is cached per-org in-isolate with a 60 s TTL. There is no single-key test or production
override: missing seam configuration returns no key, and tests exercise the same org-scoped request.

### 7. Prompt-caching safety

Some models route (via OpenRouter) to a backend that rejects Anthropic `cache_control` breakpoints (`claude-3-haiku` → OR→Bedrock 400s; `claude-haiku-4.5` works). The gateway **strips `cache_control`** from the body for an env-extensible denylist (`CACHE_CONTROL_UNSAFE_MODELS`) so the call still completes; caching-safe models are untouched.

### 8. Control-plane admin routes (guarded by `GATEWAY_ADMIN_SECRET`)

- `POST /admin/agent/budget {org, agt, budget_usd|null}` — provision the org+agt hard cap (W1/W7 seam).
- `POST /admin/lease/bump {org, agt, min_epoch}` — revoke deploy tokens below `min_epoch` (no redeploy).

---

## What's here

| File | Role |
|---|---|
| `src/index.ts` | verify deploy token → lease fence → org+agt hard gate → org-key inject → forward → tee-meter → passthrough |
| `src/token.ts` | EdDSA per-deploy token mint/verify (Web Crypto, no deps) |
| `src/budget.ts` | `SpendCounter` DO — keyed spend counter + hard gate (µ$ integers); org+agt (hard) + per-session (tracked) |
| `src/deploylease.ts` | `DeployLease` DO — per-(org,agt) lease-epoch floor (rotation/revocation fence) |
| `src/orgkey.ts` | fail-closed org OR-key resolution via the dedicated sessions-api seam |
| `src/cost.ts` | per-response cost extraction (JSON + SSE) |
| `src/models.ts` | `cache_control` safety (strip for unsafe models) |
| `scripts/mint.ts` | mint a per-deploy token for live verification |
| `test/` | `logic` (25) + `integration` (11) — **36 green** |

## Production deployment

The permanent Worker identity is `oc-agent-gateway-prod`, exposed only at its Workers.dev URL. Its
fresh `SpendCounter` and `DeployLease` state is owned by that Worker. Production config fixes
`GATEWAY_ORKEY_URL` to `https://api.opencomputer.dev/internal/gateway/org-key`; it does not configure
`AGENT_BUDGET_USD_DEFAULT`.

Default deploy fails intentionally. Production requires the explicit command:

```bash
npm --prefix cloudflare-workers/oc-gateway run deploy:production
```

Set `GATEWAY_TOKEN_PUBLIC_KEY`, `GATEWAY_ORKEY_SECRET`, and `GATEWAY_ADMIN_SECRET` for the
`production` Wrangler environment one at a time. Never print their values.

## Verification status

- **In-process integration (green, CI-able):** `npx vitest run` drives the real worker handler + real `SpendCounter`/`DeployLease` DOs with `fetch` stubbed to a mock OpenRouter. Proves: 401 (no/expired/superseded token), forward with **org-key injection** (deploy token never reaches OR; session header never egresses) + `usage.include`, body passthrough, **org+agt hard enforcement** with bounded overshoot, **co-location** (two sessions share the org+agt cap), **per-session tracked-but-never-gated**, `cache_control` strip, admin provision.
- **Live turn:** one real `anthropic/*` turn through a local `wrangler dev` gateway → OpenRouter, against a **$1-capped throwaway** OR inference key minted from `OPENROUTER_PROVISIONING_KEY` and torn down after.

### Live verification

```bash
nvm use 22.19
# 1. mint a $1-capped throwaway OR inference key + an Ed25519 keypair + a deploy token; write .dev.vars
#    (helper reads OPENROUTER_PROVISIONING_KEY from a path arg — never sourced, never printed)
# 2. run the gateway locally (real DOs, real egress to openrouter.ai)
npx wrangler dev --port 8799
# 3. one real anthropic turn THROUGH the gateway (unmodified-Flue shape)
curl -sN -X POST http://localhost:8799/anthropic/v1/messages \
  -H "authorization: Bearer $TOKEN" -H "x-oc-session: ses_live" -H 'content-type: application/json' \
  -d '{"model":"anthropic/claude-haiku-4.5","max_tokens":64,"messages":[{"role":"user","content":"say hi"}]}'
#    → a real completion; OR bills the throwaway key; a low AGENT_BUDGET_USD_DEFAULT makes the 2nd call 402.
# 4. tear down: DELETE the OR key (by hash) and stop wrangler.
```

**Acceptance (buildout W3):** a real turn completes gateway → OpenRouter; the deploy token verifies (org+agt) and yields **no raw provider key** to the tenant; the org+agt budget refuses on-path (402); per-session spend is tracked by `X-OC-Session`. Org spend stays on the existing OpenRouter→Autumn cron.

## Control-plane seams

1. **Org OR-key route:** sessions-api exposes `POST {GATEWAY_ORKEY_URL}` with a dedicated bearer and returns `{key}` from the org's active managed credential.
2. **Per-agent budget provisioning (optional):** if a per-(org,agt) cap other than `AGENT_BUDGET_USD_DEFAULT` is wanted, W1/W7 calls `POST /admin/agent/budget`.
3. **Lease epoch (`ep`) minting:** W7 should mint a monotonic per-(org,agt) `ep` into the deploy token so rotation auto-fences; a leaked token is revoked via `POST /admin/lease/bump`.
