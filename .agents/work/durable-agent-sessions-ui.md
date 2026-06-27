# Durable Agent Sessions — dashboard UI

Status: **draft, decisions converging** — exploration done. First cut = Agents +
Sessions + session webhooks; Repos and the rest follow. Blocked on the `/v3`
credential + tenant decision (#1) before the management screens can be built.
Lands in the same dashboard (`web/`) and PR lineage as the modernization work.
Engineering principles: `.agents/reference/web-frontend.md`.

Goal: bring Durable Agent Sessions to the dashboard. Scope is the **stable v1
`/v3` surface**; Labs-preview concepts (channels, triggers, workspaces,
artifacts, custom runtimes) appear only as inline "coming soon", never as built
screens.

## Two findings that shape everything

1. **The dashboard can reach `/v3`, but `/v3` tenancy is per-key, not per-org.**
   Connectivity is already solved: `/v3` (Fly app `bolt-platform`) reflects any
   Origin (bearer-token model, not cookies) and is built for browser callers —
   read+steer use a short-lived **client token**, SSE authenticates via `?token=`
   (`sessions-api/src/index.ts:36-60`). So the browser can stream events and steer
   directly. (The two `workers/` are background delivery + telemetry; `src/gateway`
   is the model gateway — neither fronts the API.)
   The real decision is the credential + tenant model. Management routes
   (list/create agents, sessions, credentials, destinations) need an opaque `osb_`
   **org key**, which must stay server-side. And `/v3` derives the tenant as
   `owner_id = sha256(osb_key)` — **per key, not per OC org**
   (`sessions-api/src/v3/auth/org.ts:18`). Sessions created with one key are
   invisible to another even within one OC org, and `/v3` has no notion of the OC
   org the dashboard authenticates as. A coherent org dashboard therefore needs
   (a) a server-side path that mints client tokens + proxies management with an
   org-scoped credential, and (b) a decision on org-scoping `/v3`. See Open
   decisions #1. Everything below assumes a credential path exists.

2. **Session webhooks are session-scoped; sandbox webhooks are org-scoped.**
   `/v3` destinations are created per session (`POST /v3/sessions/:id/destinations`)
   with a write-only secret; they have no org-level or agent-level roll-up.
   Sandbox/platform webhooks (`cloudflare-workers/api-edge/src/webhooks.ts`, Svix,
   org- or sandbox-pinned, retrievable secret) already exist on the backend with
   **no UI**. A single org-wide "all webhooks" list across both is not possible
   today without an API change. This forces the webhook IA (see Webhooks).

## What gets UI, and where

The `/v3` surface is 12 entities. Most are not top-level screens — they live
inside a session. The management nouns a user actually administers:

| Entity | Surface | Screen |
|---|---|---|
| **Agents** | CRUD (`/v3/agents`) | Top-level: list + create/edit. Reusable "what" (prompt, model, runtime, credential, limits). |
| **Sessions** | create/list/read/archive/cancel/result (`/v3/sessions`) | Top-level: list + a rich detail (below). The durable runs. |
| **Credentials** | CRUD + default (`/v3/credentials`) | Its own page (kept separate from platform **API Keys** by design — different purpose): model-provider keys (anthropic/openai), write-only, `last4`, org default. |
| **Repos + GitHub** | `/v3/repos`, `/v3/github/apps`, `/v3/github/installations` | Page: connected repos + GitHub App (install OC app / BYO via manifest) + installations. |
| **Webhooks** | sandbox (org) vs session destinations (per-session) | Split — see Webhooks. |

Lives **inside Session detail**, not as nav: Events (live SSE stream + level/type
filter), Turns, Messages/steer, Sources (checked-out repos), Destinations +
Deliveries (this session's webhooks), Result, and "mint client token" (for
embedding a live stream in the user's own app).

Not built in v1: **Runtimes** (read-only; surfaces as the runtime selector in the
agent editor + an inline "custom runtimes coming soon"), **Client tokens** as a
page (programmatic; only the mint-helper on session detail), Turns/Events/
Deliveries as standalone nav.

## Session detail is the centerpiece

One screen carries most of the product. Sections:
- **Header**: status (queued/running/awaiting_input/idle/failed/archived), agent,
  runtime, usage, limits; actions = steer, cancel, archive.
- **Event stream** (primary): live via SSE (`?stream=sse`, Last-Event-ID resume),
  filter by level (user/progress/internal) and type. Reuse the `LogsPanel`
  streaming patterns (disposed-guard, stable ingest keys) — events are richer
  than log lines (actor, type, body/`body_ref`), so a dedicated renderer.
- **Steer box**: post a user message (`POST …/messages`), idempotency-keyed,
  disabled on archived.
- **Turns / Sources / Webhooks** as secondary sections or tabs.

## Sidebar: two planes, subtly separated

The nav is a flat `NAV` array in `app-shell.tsx` today. Segregate into groups
with spacing + a hairline divider, and small low-contrast group labels. Proposed:

```
Dashboard

Agents            ← group: the durable-agent plane (launch focus)
  Agents
  Sessions
  Repos
  Credentials

Sandboxes         ← group: the raw-compute plane (existing)
  Sandboxes
  Checkpoints
  Templates

Account
  API Keys
  Webhooks
  Billing
  Settings
```

Options for the separation, subtle → explicit: (a) extra spacing + a hairline
only; (b) spacing + hairline + small muted group labels (recommended — reads as
intentional, common dashboard pattern); (c) collapsible groups (probably
overkill at this size). Order is swappable; leading with Agents reflects the
launch focus, but Sandboxes-first is defensible as the foundation.

## Webhooks: honest split now, unify later

Per finding #2, do not force one list. Recommendation:
- **Session destinations live on Session detail** (a Webhooks/Delivery section) —
  they are session-scoped by API, so that is their natural home. Create/list/
  delete destinations + a deliveries view with status and **redeliver**.
- **A global "Webhooks" page manages sandbox/platform webhooks** (org-scoped,
  backend already exists, no UI). This is genuinely useful on its own.
- **Don't pretend they're one system.** True unification (an org/agent-level
  view of session webhooks) needs an API change: agent-level default
  destinations, or an org roll-up endpoint. Flag it as a follow-up, don't block.

Open sub-question: should **Agents carry default destinations** so a user
configures "notify me on turn.completed" once per agent instead of per session?
That is the missing piece that would make a unified webhook UX real. Worth
raising with the `/v3` owners.

## Mechanical pre-step: free the "Session" name

The dashboard's `Session` type, `getSessions`, `['sessions']` keys, and
`/sandboxes` data layer all currently mean **sandbox** (backend vocab). Real
agent Sessions now collide with that. Rename the sandbox data layer
(`Session→Sandbox`, `getSessions→getSandboxes`, query keys, file names) **as its
own mechanical commit before** any agent-session code — separate mechanical from
behavioral change (per the principles doc). After it, "Session" is free.

## Reuse

`Panel`, `PageHeader`, `ResourceTable`, `StatusBadge` (extend tones for session/
turn states), `EmptyState`, `ConfirmDialog`, `CopyRow`, `Field`/form,
`MetricCard`. New API goes through `apiFetch` + zod schemas in `schemas.ts` + mock
entries (dev-hard parse keeps the mock honest). New pages are `lazy()` routes
behind the org+route-keyed error boundary.

## Decisions

**Settled:**
- **Webhooks IA** — session destinations on session detail; a separate global
  page for sandbox/platform webhooks; no forced unification.
- **Credentials separate from API Keys** — distinct pages, different purpose.
- **First cut = Agents + Sessions + session webhooks.** Webhooks are part of
  what makes it usable, so session destinations + deliveries ship on the session
  detail in the first cut. Repos, the global sandbox-webhooks page, and the full
  Credentials page come later.

**Settled (continued):**
- **Identity & ownership** — RESOLVED, full design in
  `oc-bg-agents/.agents/work/agent-sandbox-ownership.md`. One OC org id is
  propagated as a signed org-token at every hop (act-as-org), reusing the edge→
  cell cap-token pattern. `/v3` becomes org-scoped (`owner = oc-org:<id>`); agent
  sandboxes are owned by + billed to the **customer's org** (not the service
  org). No shared keys, no per-customer key custody. The dashboard's part is
  **Phase 0** there: the edge proxies `/api/dashboard/v3/*` minting the org-token,
  `/v3` trusts it. Phases 1–2 (session→sandbox exposure, OC-core act-as-org
  ownership) are sessions-api + OC-core.

Also settled: **model credential** is set via API/SDK at test time (no dashboard
affordance for now); **sidebar separation** = spacing + small muted group labels
(built).

**Still open (need input / cross-team confirm):**
1. **Agent-level default destinations?** Not in `/v3` today (destinations are
   session-scoped). Adding them is what would make a unified, configure-once
   webhook UX real — pursue or leave as a follow-up?

## Rough sequence (after decision #1)

0. Mechanical, separate commit: rename the sandbox data layer
   (`Session→Sandbox`, etc.); stand up the `/v3` client path + zod schemas.
1. Agents: list + create/edit (runtime selector, credential reference).
2. Sessions: list + detail — live events (SSE) + steer. The core.
3. Session webhooks: destinations + deliveries (with redeliver) on the detail.
4. Sidebar grouping.
5. Later: Repos + GitHub connection; full Credentials page; global sandbox
   webhooks page; (if chosen) agent-level default destinations.
