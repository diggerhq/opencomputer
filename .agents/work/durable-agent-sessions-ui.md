# Durable Agent Sessions — dashboard UI

Status: **first draft for review** — exploring shape before building. Lands in the
same dashboard (`web/`) and PR lineage as the modernization work. Engineering
principles: `.agents/reference/web-frontend.md`.

Goal: bring Durable Agent Sessions to the dashboard. Scope is the **stable v1
`/v3` surface**; Labs-preview concepts (channels, triggers, workspaces,
artifacts, custom runtimes) appear only as inline "coming soon", never as built
screens.

## Two findings that shape everything

1. **The dashboard does not currently talk to `/v3`.** Today it calls
   `/api/dashboard/*` on the OpenComputer edge worker (D1, WorkOS-cookie auth).
   The agent-sessions API is a **separate service** (sessions-api, `/v3`) authed
   by **org API keys** (`osb_…`). Nothing wires the cookie-authed dashboard to
   `/v3` yet. **This is the prerequisite and the one real unknown — decide it
   first (see Open decisions #1).** Everything below assumes it's solved.

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
| **Credentials** | CRUD + default (`/v3/credentials`) | Small page: model-provider keys (anthropic/openai), write-only, `last4`, org default. Distinct from platform **API Keys** — note the naming risk. |
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

## Open decisions (need input before building)

1. **How does the dashboard reach `/v3`?** Recommended: the OC edge proxies
   `/v3` under the dashboard origin and resolves the logged-in user's org to an
   org-scoped call (mirrors today's `/api/dashboard` model, keeps cookie auth).
   Alternatives: sessions-api validates the dashboard session directly (CORS), or
   the user supplies an org key (poor UX). **Blocks everything; confirm with edge
   + sessions-api owners.**
2. **Agent-level default webhook destinations?** Decides whether a unified
   webhook UX is possible now or is a follow-up.
3. **Credentials vs API Keys naming** — two key-management pages. Keep separate
   with clear labels, or consolidate into a "Keys & secrets" area?
4. **Sidebar group labels** — subtle labels (b) or spacing-only (a)?
5. **Scope for first cut** — minimum lovable = Agents (list/create) + Sessions
   (list + detail with live events + steer). Repos / Credentials / global
   Webhooks can follow. Confirm the cut.

## Rough sequence (after decisions)

0. Mechanical: rename sandbox data layer; wire the `/v3` client path (decision #1).
1. Agents: list + create/edit (+ runtime selector, credential picker).
2. Sessions: list + detail (events SSE + steer) — the core.
3. Sidebar grouping.
4. Repos + GitHub connection; Credentials.
5. Webhooks: session destinations on detail; then the global sandbox page.
