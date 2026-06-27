# Agent sandbox ownership — end-user org owns the compute

Status: **Phase 0 live; Phases 0.5 / 1 / 2 / 3 all BUILT + dev-verified, inert
pending prod activation + test.** Owners span three repos (opencomputer edge +
OC core, sessions-api). Companion to the dashboard work
(`durable-agent-sessions-ui.md`). What shipped + how to turn it on: see
**Implemented** + **Activation** below.

## Requirement (non-negotiable)

A Durable Agent Session's sandboxes (brain + hands) must be **owned by the
end-user's OpenComputer org** — visible in that org's Sandboxes view, counted
against its quota, and **billed to that org**. The user must be able to see every
box their sessions ran on. The service-owned model (all agent boxes under one
sessions-api platform org) is not acceptable as an end state. No shortcut auth,
no shared keys.

## One identity, propagated every hop

The whole chain carries a **single identity: the OC org id**, asserted at each
internal hop as a short-lived **signed org-token** (HS256, claim `org_id`). This
is not new machinery — the edge already mints exactly this to reach a cell
(`cloudflare-workers/api-edge/src/index.ts:77-117`, signed with
`SESSION_JWT_SECRET`). We extend the same primitive to two more hops. Mentally
it's **a virtual, ephemeral "UI key" scoped to one org** at every boundary — same
semantics as an org API key, but minted per request from a trusted caller, never
stored, never in the browser.

```
browser (oc_session cookie)
  → edge            verifies cookie → caller.orgID
  → /v3             trusts edge org-token → owner = oc-org:<orgID>
  → OC core         trusts "sessions-api acting for org X" → sandbox owned by org X
```

**act-as-org, not key custody.** A trusted service (edge, sessions-api) asserts
"I am acting for org X" via a signed token; the receiver attributes the call to
org X. sessions-api never holds a customer's OC credential. This mirrors the
edge→cell cap-token and avoids a credential-custody surface entirely.

## Current state → target

| Hop | Today | Target |
|---|---|---|
| browser → edge | cookie → `caller.orgID` ✓ | unchanged |
| edge → /v3 | nothing (no proxy) | edge mints org-token; proxies `/api/dashboard/v3/*` |
| /v3 owner | `sha256(osb_key)` (per key) | `oc-org:<orgID>` (per OC org) |
| /v3 → OC core | one platform key `OPENCOMPUTER_API_KEY` (`sessions-api/src/v3/runtime/config.ts:45`, used via `ocOpts()` in `runtime/sandbox.ts` + `credential.ts`) → boxes owned by the service org | act-as-org assertion → boxes owned by the session's org |
| billing/quota | service org | **customer org** |

## Decisions settled

- **Billing:** agent compute bills to the **customer's org** (the meaning of
  ownership). Agent boxes count against that org's concurrency/quota.
- **Mechanism:** **act-as-org** signed assertion, reusing the cap-token pattern.
  No per-customer OC-key custody.
- **Identity:** the **OC org id** is the universal owner; `/v3` owner becomes
  `oc-org:<orgID>`; `osb_` keys resolve to the *same* owner so SDK/CLI/demo and
  dashboard see one org's data.

## Path (each phase proper on its own — no throwaway)

- **Phase 0 — org identity into `/v3` + org-scoping** *(edge + sessions-api)*
  - Edge: `/api/dashboard/v3/*` proxy mints a signed org-token (`org_id =
    caller.orgID`) and forwards it; cookie-gated; nothing sensitive in the browser.
  - `/v3`: accept the edge org-token → `owner = oc-org:<orgID>`. Also resolve
    `osb_` keys → org (an OC `org-for-key` lookup) so the same owner results both
    ways. Shared secret edge↔/v3.
  - Outcome: the dashboard runs on real `/v3` with correct per-org identity; SDK
    and demo see the same org's data. Boxes still service-owned until Phase 2.
  - Migration: existing per-key `/v3` rows become orphaned under the new owner —
    reset in dev; one-time migrate or reset pre-launch (no GA users yet).

- **Phase 1 — `/v3` exposes session → sandbox** *(sessions-api)*
  - A read endpoint returning the box id(s) a session used. The link doesn't
    exist in the public surface today. Useful immediately; required for the
    dashboard to relate a session to its boxes.

- **Phase 2 — boxes owned by the customer org** *(OC core + sessions-api)* — the real B
  - OC core: sandbox-create accepts "sessions-api **acting for org X**" via the
    signed-org-token trust, attributing the sandbox to org X (ownership, quota,
    billing, listing). Confirm the exact auth seam in `internal/api` /
    `internal/auth`.
  - sessions-api: `ocOpts()` provisions with the **session's org**, not the
    service key. Shared secret /v3↔OC-core.
  - Outcome: agent boxes appear in the customer's Sandboxes page, count against
    its quota, bill to its org.

- **Phase 3 — dashboard ties it together** *(web)*
  - Sandboxes page surfaces agent boxes (tagged); session ↔ box links both ways.

## Open implementation points

- **Shared-secret management** for the two trust hops (edge↔/v3, /v3↔OC-core):
  provision + rotation. Reuse `SESSION_JWT_SECRET`-style handling.
- **OC-core act-as-org seam** — the precise place sandbox-create derives the
  owning org, and how a trusted service overrides it for org X. Confirm before
  Phase 2.
- **Quota** — agent boxes count against the customer org's concurrency. Intended,
  but means agents and interactive sandboxes share the limit; flag for the quota
  owner.
- **`osb_` → org resolution** — BUILT as edge `GET /api/whoami` (D1-backed,
  returns `{org_id, user_id}`); sessions-api `resolveOrgForKey` calls it. LIVE on prod.

## Invariants

- Org-tokens are short-lived, signed, and **never reach the browser**.
- The receiver always re-derives the owner from the verified token/assertion,
  never from a client-supplied value (same rule `/v3` `resolveOwner` already
  enforces).
- Every hop attributes to exactly one OC org; no call is ownerless.

## Environments (how dev vs prod actually splits)

- **sessions-api** — a **single instance** (no dev/prod split), easy to deploy
  (Fly `bolt-platform`, on merge to main). Its `OPENCOMPUTER_API_URL` (+
  `OC_ORG_FOR_KEY_URL`) decide **which OC edge it provisions/resolves against** —
  point at the dev edge for dev testing, the prod edge for prod.
- **OC edge** — real dev/prod split: a **dev edge** (`igor-dev`) + the prod edge.
- **OC core** — real dev/prod split: a **dev box** + prod.
- **web statics** — built into each edge (dev statics on the dev edge, prod on
  prod).

So ownership IS fully testable in dev: point the single sessions-api at the dev
edge, with `OC_PROVISION_SECRET` on both — provisioning flows dev edge → dev box,
boxes owned by the org, shown in the dev dashboard. No prod needed to test.

Still ship `/v3`/edge changes **additive + inert-until-configured** (behind a
secret) since sessions-api is one shared instance.

## Concrete seams (confirmed by code, 2026-06-27)

The three-repo trace is done; the design is buildable as below.

**The whole thing hinges on one column: `sandboxes_index.org_id`.**
- A sandbox's owner is stamped exactly once, at the edge `createSandbox` →
  `insertSandboxIndex(env, caller, …)` writing `caller.orgID`
  (`api-edge/src/index.ts:477-503`); the cap-token carries the same `org_id` and
  the CP trusts it without re-auth (`internal_sandbox.go:67-75`, cell-id replay
  guard only).
- **Billing + quota auto-follow that column** — concurrency counts
  `WHERE org_id=?1 AND status='running'` (`index.ts:461-465`), and
  `usage_samples.org_id` (the billing key, `events-ingest`) is copied from it.
  So **stamp the box with org X and ownership, quota, and billing all move to X
  with no secondary change.** This is why Phase 2 is small.

**Trust model — the one correctness call (mechanism refined after SDK check).**
The `@opencomputer/sdk` has NO custom-header option (`sandbox.ts:26` — only
`apiKey`/`apiUrl`), but every op already sends the key as `X-API-Key`
(`exec.ts:67`, `filesystem.ts:18`, create `sandbox.ts:357`). And every edge
sandbox route does `authenticate()` then `row.org_id !== caller.orgID → 404`. So
the cleanest, secure mechanism is: **deliver the act-as-org assertion AS the
`X-API-Key` — a signed JWT the edge recognizes.**
- sessions-api mints HS256 `{org_id: X, session_id, iss:"sessions-api",
  aud:"opencomputer-api", exp: now+maxTurnSeconds+600}` signed with a NEW shared
  secret (`OC_PROVISION_SECRET`) and passes it as `apiKey` in `ocOpts()` whenever
  the session owner is `oc-org:X` (else the service key — inert fallback).
- The **only edge change**: `authenticate()` — if the key is a JWT (not `osb_`)
  and `OC_PROVISION_SECRET` is set, verify it → `{orgID: X}`. Everything else
  flows automatically: `createSandbox` stamps X (it's `caller.orgID`), sub-ops on
  X's boxes pass the org-match check, billing/quota follow `sandboxes_index.org_id`.
  No cap-token claim, no CP change, no per-route change, no SDK change.
- Lifetime = a turn (`maxTurnSeconds+600`, same as the sandbox timeout); minted
  fresh per `ensure` (per turn). Powerful (full org-X authority for its lifetime)
  but mintable only by the secret-holder — same trust class as
  `OC_ORG_TOKEN_SECRET`. Receiver always re-derives org from the verified JWT.
- Inert until the secret is set on both sides (matches the prod-only rule):
  without it the edge won't accept JWT keys and sessions-api won't mint them.

**Prerequisite — one owner identity.** Phase 2 needs every session's `owner` to
be a real org. Dashboard sessions already are (`oc-org:X`). `osb_`/SDK sessions
are `oc:sha256(key)` (`auth/org.ts:18`), one-way → no org. Fix is cheap: the edge
`api_keys` table maps `key_hash → org_id` (`index.ts:158-175`) and sessions-api
already round-trips `osb_` keys to OC (`OC_KEY_VALIDATE_URL`). Resolve `osb_`→org
there so owner = `oc-org:X` for ALL sessions — this also makes SDK/demo sessions
show in the dashboard (closes the demo-visibility gap).

**Phase 1 is nearly free.** The box ids are already recorded on the session +
turn rows (`schema.ts:60-61,90-91`, set in `runtime/turn.ts:278-279`); they're
just not serialized (`serializeSession` omits them). Phase 1 = add them to the
response (or a small read endpoint).

**Open implementation points (verify during build):**
- **SDK custom headers** — does `@opencomputer/sdk` `Sandbox.create`/`connect`
  accept a `headers` option so `ocOpts()` (`runtime/sandbox.ts:20`, ~10 call
  sites) can attach the act-as-org token? If not, that's the first thing to add.
- **Quota sharing** — agent boxes will count against the customer org's
  concurrency, shared with its interactive sandboxes. Confirmed intended
  (ownership ⇒ quota); confirm the limit is sized for it.
- **No cap-token claim needed** (revised). The edge resolves org X in
  `authenticate()` from the verified JWT, so the existing cap-token already
  carries X to the CP — no `actas_org_id` claim, no CP change.

## Implemented (Phase 2) — what shipped

Mechanism = the act-as-org assertion delivered AS the `X-API-Key` (signed JWT),
so one edge `authenticate()` change covers create-stamp + sub-op authz + billing.
Built + verified; **inert until `OC_PROVISION_SECRET` is set on both sides.**

**sessions-api** — branch `feat/v3-act-as-org`, PR diggerhq/sessions-api#27:
- `provisionApiKey(ownerId, sessionId)` in `src/v3/runtime/config.ts` — mints
  HS256 `{ iss:"sessions-api", aud:"opencomputer-api", org_id, session_id,
  exp: now + maxTurnSeconds + 600 }` signed with `OC_PROVISION_SECRET`. Returns
  null when the secret is unset or the owner isn't `oc-org:*` (→ platform-key
  fallback).
- `ocOpts(owner)` in `src/v3/runtime/sandbox.ts`, `src/v3/runtime/credential.ts`,
  `src/v3/sandbox/oc.ts` passes that token as `apiKey`. `ownerId`+`sessionId`
  threaded through sandbox create/connect, SecretStore create/update/setSecret,
  and the hands tool proxy (so the SecretStore is org-owned too and sub-ops on
  X's boxes authorize).

**OC edge** — opencomputer `feat/web-ui-dev` (PR 426), `cloudflare-workers/api-edge/src/index.ts`:
- `verifyProvisionToken(secret, token)` + a branch in `authenticate()`: when
  `OC_PROVISION_SECRET` is set and the key is a JWT (`eyJ…`, 3 segments, not
  `osb_`), verify it → `{ orgID: X }`. Everything else (createSandbox stamp,
  `org_id` match on sub-ops, concurrency/billing) follows automatically.

**Secret** — `OC_PROVISION_SECRET`: one shared HS256 value on the prod OC edge
(`wrangler secret put`) and prod sessions-api (env). Same trust class as
`OC_ORG_TOKEN_SECRET`.

**Verified** — `node:crypto` mint ↔ Worker `crypto.subtle` verify match
byte-for-byte; live on the dev edge: valid token → 200, tampered → 401, `osb_`
key → 200 (no regression); both repos `tsc` clean.

**Activate (all prod — no dev `/v3` exists):** merge #27 + deploy prod
sessions-api (inert); deploy the prod OC edge (inert); set `OC_PROVISION_SECRET`
on both → live for **dashboard** sessions. SDK/`osb_` sessions need Phase 0.5.

## Build status — all phases built

- **Phase 0** — edge org-token → `/v3` org-scoped. **LIVE in prod.**
- **Phase 0.5 — `osb_`→org** — **LIVE on prod**: edge `/api/whoami` shipped via #429;
  sessions-api `resolveOrgForKey` (#28) resolves keys to their org. Verified on prod
  (whoami → `{org_id,user_id}`).
- **Phase 1 — session→sandbox** — sessions-api `sandboxes:{brain,hands}` on
  `serializeSession` **LIVE on prod** (#28). Dashboard *display* of them ships with
  the dashboard (Path A, below).
- **Phase 2 — act-as-org** — **LIVE on prod** (sessions-api #27 + edge #429 +
  `OC_PROVISION_SECRET` set both sides; validated). See **SHIPPED + LIVE on prod**.
- **Phase 3 — dashboard surfaces boxes** — code **BUILT** (session detail links boxes;
  org-scoped Sandboxes list auto-shows org-owned boxes). **Not on prod until the
  dashboard ships (Path A, below).**

## Test in dev (ORIGINAL PLAN — the dev box is NOT a faithful replica; see "Dev env" below)

Dev edge (`igor-dev`) already has `/api/whoami` + `authenticate()` act-as-org +
`proxyToV3` + webhooks deployed. Then:

1. **sessions-api** (the single instance): merge #28 + deploy, and point it at the
   dev edge — `OPENCOMPUTER_API_URL` = dev edge, `OC_ORG_FOR_KEY_URL` = dev edge
   `/api/whoami`.
2. Set `OC_PROVISION_SECRET` to the **same value** on sessions-api **and** the dev
   edge (`wrangler secret put … --config wrangler.igor-dev.toml`).
3. Dev box (OC core) needs no change — it trusts the edge cap-token, which now
   carries the customer org.
4. Test via the **dev dashboard**: create a session → box provisioned via dev edge
   → dev box, owned by the org, shown on the session + in the org's Sandboxes
   list. An SDK/`osb_` session resolves to the same org and appears too (0.5).

## SHIPPED + LIVE on prod (2026-06-27)

The Phase-2 edge bits were **fast-tracked out of PR 426 into an isolated PR** and
activated on prod ahead of the dashboard, so the "Test in dev" / original
deploy-to-prod plan above are superseded. What actually shipped:

- **Isolated edge PR — diggerhq/opencomputer #429** (`feat/edge-act-as-org`,
  cherry-picked `cfe7f19`+`710554b` from #426): ONLY the edge ownership bits —
  `authenticate()` act-as-org token + `GET /api/whoami`. Merged → `deploy-api-edge.yml`
  deployed `opencomputer-edge-prod` (app.opencomputer.dev, account b8f). The rest of
  #426 (new dashboard SPA, proxyToV3, dashboard-webhooks) stays on `feat/web-ui-dev`.
- **sessions-api**: #27 (Phase 2) + #28 (Phase 0.5/1/queue-prefix) already on `main` + deployed.
- **Activated**: `OC_PROVISION_SECRET` set MATCHING on the prod edge
  (`wrangler secret put … -c wrangler.prod.toml`) and prod sessions-api
  (`fly secrets import -a bolt-platform`). **Edge first** → no reject window.
- **Validated end-to-end on prod**: `osb_`-key session → `/api/whoami` org
  `2f9094d9-…` → act-as-org provisioned box `sb-841a064e`, whose
  `sandboxes_index.org_id` == that org (cell azure-us-east-2-a); agent ran, turn completed.
- **Global**, not a canary: every new prod session now provisions org-owned boxes.

**Rollback of the activation** (reversible, no data/migration/redeploy): unset
`OC_PROVISION_SECRET` on **either** side → sessions-api falls back to the platform
key (boxes platform-owned), edge ignores act-as-org JWTs.
`fly secrets unset OC_PROVISION_SECRET -a bolt-platform` and/or
`wrangler secret delete OC_PROVISION_SECRET -c wrangler.prod.toml`.

## Dev env is NOT a faithful prod replica (UI test can't run on dev)

Full dev stack stood up (local `dev-env.md`), but the **dev box** was set up for an
earlier stage and isn't wired for full agent-session provisioning. A dev session
clears org-resolution + credential-seal but **fails at provision**. Gaps, in order hit:
1. ✅ edge↔box shared secrets (`OPENSANDBOX_SESSION_JWT_SECRET` / `SECRET_ENCRYPTION_KEY`
   / `CF_EVENT_SECRET`) were empty — **fixed** (matched edge↔box, box restarted).
2. ⚠️ **capacity pipeline** — box CF event forwarder off (`CFEventEndpoint`/`CellID`
   unset) + no dev events-ingest worker → `cells.capacity_updated_at` goes stale →
   picker: "no cells available with capacity". Worked around once by poking the D1 row.
3. ❌ **edge-side secret-store resolution** — box (`version: dev`, predates edge secret-stores)
   → "secret store not found" at create. Needs current OC core redeployed to the box.
4. ❌ **runtime artifacts** — fresh dev Supabase has no `runtime_builds` pointer → legacy
   path → needs the runtime bundle in dev R2 (empty) or a dev snapshot + pointer.

Net: finishing the dev box is a deferred multi-system infra task. **Prod is the only
fully-wired stack** → UI testing goes there (below).

## UI end-to-end test (create session → see its sandboxes) — Path A + rollback

The new v3 dashboard UI lives only on `feat/web-ui-dev` (#426), deployed to the **dev**
edge. A dashboard is bound to the edge that serves it (auth + org-token + the
`/api/sandboxes` D1), so you can't cleanly point dev's UI at prod's backend (split brain).
The faithful test = put the new dashboard on the **prod** edge.

**Plan (Path A):**
1. Branch-deploy the new dashboard to prod (no merge):
   `gh workflow run deploy-api-edge.yml --ref feat/web-ui-dev -f target=prod`
   → builds the new SPA + deploys `opencomputer-edge-prod`.
2. Align `OC_ORG_TOKEN_SECRET` MATCHING on the prod edge (`wrangler … -c wrangler.prod.toml`)
   and prod sessions-api (`bolt-platform`) so the dashboard's `/v3` proxy authenticates.
   (Additive on prod — the v1 dashboard never used the v3 proxy.)
3. Smoke on **app.opencomputer.dev**: load → WorkOS login → create agent (paste model key)
   → create session → confirm its **sandboxes** show on the session, owned by your org.

**Rollback (fast, no data involved):**
- The dashboard is one worker artifact. Revert by redeploying from `main`:
  `gh workflow run deploy-api-edge.yml --ref main -f target=prod` (~45s) → restores the
  **v1 dashboard** + `main`'s edge. `main` already carries #429, so **ownership stays
  live through the rollback** (dashboard and ownership are decoupled).
- `OC_ORG_TOKEN_SECRET` is inert without the v3 dashboard; optional to unset after rollback.
- No migrations, no sessions-api change → nothing else to revert.

**Risk:** Path A makes the new dashboard **live on prod for all users** until rolled back.
Detection = the step-3 smoke immediately after deploy; if any step fails, run the
one-command rollback before it matters.
