# Agent sandbox ownership — end-user org owns the compute

Status: **design, approved direction** — building toward it. Owners span three
repos (opencomputer edge + OC core, sessions-api). Companion to the dashboard
work (`durable-agent-sessions-ui.md`).

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
- **`osb_` → org resolution** — needs an OC endpoint returning org for a key (the
  edge can expose `GET /api/org-for-key`, D1-backed).

## Invariants

- Org-tokens are short-lived, signed, and **never reach the browser**.
- The receiver always re-derives the owner from the verified token/assertion,
  never from a client-supplied value (same rule `/v3` `resolveOwner` already
  enforces).
- Every hop attributes to exactly one OC org; no call is ownerless.

## `/v3` is prod-only (deploy note)

There is no dev/staging `sessions-api`: the dev dashboard (the `igor-dev` edge)
proxies to **prod** `/v3` (`api.opencomputer.dev` / `bolt-platform`). So `/v3`
changes are validated against prod — ship them **additive and inert-until-
configured**, the way Phase 0's org-token did (behind `OC_ORG_TOKEN_SECRET`, a
no-op until the secret is set on both sides).

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
  concurrency, shared with its interactive sandboxes. Intended (ownership ⇒
  quota), but confirm the limit is sized for it.
- **`actas_org_id` on the cap-token** vs a separate edge→CP assertion — extend
  the cap-token (Option A); minimal, billing already threads the org param.

## Build order (refined)

1. **Phase 1** — expose session→sandbox (serialize the recorded ids). Safe, no
   trust changes, unblocks Phase 3.
2. **Phase 0.5 — `osb_`→org** — unify owner so every session is `oc-org:X`
   (also fixes demo visibility). Prereq for owning SDK/demo sessions' boxes.
3. **Phase 2** — act-as-org provisioning (the signed token + edge stamp + cap
   `actas_org_id`). The core. Ship inert behind `OC_PROVISION_SECRET`.
4. **Phase 3** — dashboard surfaces agent boxes + session↔box links.
