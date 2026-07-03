# Deferred actions — deeplink intents that survive signup

Status: active (design, pre-implementation)
Last updated: 2026-07-03
Owns: the deferred-action mechanism — action envelope, `/do` executor route, auth-loop `returnTo` survival — and its first action type (`agent_prefill` from the launch site prompt box)
Supersedes: —
Implementation: `cloudflare-workers/api-edge/src/index.ts` (authLogin/authCallback) · `web/src/components/ProtectedRoute.tsx` · `web/src/` new `/do` route + action registry
Public docs: —

## Trigger

The Durable Agent Sessions launch site (`diggerhq/durableagentsessions`) has a
Lovable-style hero prompt box: "What should your agent do?" → `Build it` →
`app.opencomputer.dev/?prompt=<encoded>`. Today that prompt dies before it
reaches anything:

- Logged-out user (the launch funnel's main case): `ProtectedRoute` redirects
  to a bare `/auth/login` (`web/src/components/ProtectedRoute.tsx:15`) —
  path + query dropped. The edge starts the WorkOS flow with no `state` param
  (`cloudflare-workers/api-edge/src/index.ts:1157-1168`), and the callback
  hard-codes its landing to `${origin}/dashboard` (`index.ts:1275`).
- Logged-in user: the SPA reads no query params on entry; the router
  catch-all normalizes to `/` and the param is silently eaten.

The general problem is bigger than one campaign: any deep link into the
dashboard (a shared session URL, an agent page) strands logged-out users on
the home screen. And the launch site is the first of several planned
experiments that want "click on external site → thing happens in the app
after signup".

## Pattern

This is deferred deep linking (the mobile-attribution industry's term: an
intent that survives an app install; here, one that survives signup),
carried through hosted auth by the OAuth `state` parameter — which exists
precisely to round-trip application state through an authorization flow.
Prompt-first products (Lovable, Bolt, v0) run this exact funnel: anonymous
prompt → signup wall → workspace materialized from the prompt.

Two design consequences we adopt from the pattern:

1. **The URL is the store.** No server-side intent table, no TTL sweeps, no
   anonymous-write endpoint to abuse. The action rides the URL through the
   redirect chain. localStorage cannot be the primary carrier: the site and
   the app are different origins, and an app-origin stash breaks when signup
   completes in a different browser context (email verification opened
   elsewhere). The `state` round-trip survives everything WorkOS survives.
2. **Actions are typed and versioned from day one.** The first type is
   `agent_prefill`; the envelope is where future experiments plug in without
   new architecture.

## Design

### 1. Action envelope

A small JSON object, base64url-encoded into a single query param on a
dedicated route:

```
https://app.opencomputer.dev/do?action=<base64url({
  "v": 1,
  "type": "agent_prefill",
  "params": { "prompt": "Watch my error tracker and triage new issues" }
})>
```

- `v` — envelope version; unknown version → treat as malformed.
- `type` — dispatch key into the handler registry. Unknown type → friendly
  "this link isn't supported yet" state, no crash.
- `params` — type-specific payload, validated by the handler (zod, like the
  rest of `web/src/api`).

Size budget: URLs are safe to ~2 KB; hero prompts are well under. An action
type that outgrows this later gets a server-side stashed-intent-id variant
(`/do?intent=<id>`); explicitly out of scope now.

### 2. Auth-loop survival (`returnTo` through WorkOS `state`)

The generic infrastructure piece — fixes all dashboard deep links, not just
`/do`:

- `web/src/components/ProtectedRoute.tsx`: capture
  `location.pathname + location.search` and redirect to
  `/auth/login?returnTo=<encodeURIComponent(...)>` instead of bare
  `/auth/login`.
- Edge `authLogin` (`index.ts:1157`): read `returnTo`, validate (below), put
  it in the WorkOS authorize URL's `state` param as
  `JSON.stringify({returnTo})`.
- Edge `authCallback` (`index.ts:1170-1283`): parse `state` if present,
  validate `returnTo` again, and 302 to `${origin}${returnTo}` instead of the
  hard-coded `${origin}/dashboard`. Missing/invalid state → `/dashboard` as
  today.

**Open-redirect protection** (validated at both ends, enforced at the
callback): `returnTo` must start with `/`, must not start with `//` or
contain `\` or a scheme separator — a same-origin path only. `state`
tampering can therefore only choose a different page on our own origin, so
no signing is needed. Cap length (2 KB) to keep the authorize URL sane.

First-signup provisioning (personal org, $5 Autumn credit,
`index.ts:1226-1268`) is untouched — it happens in the same callback before
the redirect, so a brand-new user lands on `returnTo` with a working org.

### 3. `/do` executor route (SPA)

New route in `web/src/App.tsx` behind the existing `ProtectedRoute`. The
ordering falls out for free: authed user executes immediately; anonymous
user bounces through auth and lands back on the identical URL. New and
existing users take the same path.

Executor behavior:

- Decode + validate the envelope; dispatch on `type` to a registry
  (`web/src/lib/deferred-actions.ts`, one handler per type).
- Execute once: `history.replaceState` to strip the param before the
  handler's first await resolves, so refresh/back cannot replay. Mutating
  calls carry `Idempotency-Key` where the API supports it (session create
  already does; agent create is idempotent by `(owner, name)`).
- Malformed/unknown action → a small neutral screen with a link to the
  dashboard; log to PostHog.
- While executing: minimal progress state ("Setting up your agent…"), then
  navigate to the result.

### 4. First action type: `agent_prefill`

Params: `{ prompt: string }` (required, trimmed, non-empty, length-capped —
reuse the agent-prompt limit).

Handler:

1. `POST /api/dashboard/v3/agents` with `prompt` = the user's text,
   `credential: "managed"`, default runtime (`claude`) and model, `name`
   derived from the prompt (first words slugified + short suffix; the
   dashboard's existing random-name helper as fallback). Creating an agent
   is free and needs zero org configuration — managed billing provisions on
   demand (sessions-api `resolveCredentialForSession`, managed default).
2. Navigate to the agent's page with the session composer pre-filled with
   the same text, ready to send.

Deliberately **no autostart**: the first turn spends credits, so it happens
on an explicit user keypress. This both matches the intended UX ("taken to
the new agent screen, already created, with pre-filled text") and closes the
drive-by abuse case — a malicious page linking a logged-in user to
`/do?action=...` can create a free agent at worst, never spend money.
`params.autostart: true` is a one-line addition later if funnel data shows
people stall at send.

Composer prefill mechanics: the handler navigates with router state
(`navigate('/agents/:id', { state: { composerPrefill: prompt } })`);
`AgentDetail`'s sessions-tab composer seeds from it. Router state doesn't
survive refresh — acceptable; the agent already exists.

### 5. Compatibility shim

The site already ships `/?prompt=<text>`. A tiny effect on the root route:
if `?prompt=` is present, rewrite to
`/do?action=<agent_prefill envelope>` (replace, not push). The site should
migrate its hero to mint `/do?action=...` URLs directly; the shim keeps the
shipped link working meanwhile and can be removed later.

### 6. Analytics

The point of the experiment is the funnel. PostHog (already in the SPA)
events, all carrying `action_type` and a `source` param passed through from
the site (`utm_*` passthrough kept in the envelope's params or as sibling
query params — sibling params, so attribution tooling sees them):

- `deferred_action_landed` (pre-auth state unknown; fired on `/do` mount)
- `deferred_action_executed` (agent id, ms elapsed)
- `deferred_action_failed` (reason: malformed / unknown_type / api_error)
- first-send from a prefilled composer (property on the existing
  session-start event rather than a new one)

Signup itself is already observable from the edge/WorkOS side; landed →
executed gap approximates "signup wall drop-off" for anonymous arrivals.

## Failure modes

| Case | Outcome |
| --- | --- |
| Malformed / unknown-type / oversized action | Neutral "unsupported link" screen, dashboard link, PostHog event |
| `returnTo` fails validation | Callback falls back to `/dashboard` (today's behavior) |
| Agent create fails (e.g. `managed_unavailable` 422) | Error state on `/do` with retry + link to manual create dialog |
| Refresh / back after execution | Param already stripped; no replay. Same envelope re-visited later: agent create is idempotent by `(owner, name)` only for identical config — name suffix makes repeats create a second agent, which is acceptable and visible, not silent |
| User abandons WorkOS mid-flow | Nothing created; link still works when clicked again |
| Email verification completed in another browser | `state` is bound to the WorkOS flow, not the browser — callback still lands on `returnTo` in whichever context completes auth |

## Scope

One PR in this repo:

- edge: `authLogin` + `authCallback` `returnTo`-via-`state` (~40 lines incl.
  validation)
- web: `ProtectedRoute` capture (~3 lines), `/do` route + registry +
  `agent_prefill` handler (~150 lines), root-route shim, composer-prefill
  seed in `AgentDetail`, PostHog events

Not in scope: sessions-api (nothing needed — the API already supports the
whole chain), server-side intent storage, autostart, additional action
types, site-side URL migration (separate repo, one-line change there).

## Test plan (manual matrix before merge)

1. Anonymous → prompt box → signup (fresh email) → lands on `/do` → agent
   exists, composer prefilled, send works, turn runs on managed billing.
2. Anonymous → prompt box → login (existing account) → same.
3. Logged-in → prompt box → immediate execution, no auth bounce.
4. Logged-out, shared session URL (no action) → login → lands on that
   session, not `/dashboard` (generic returnTo works).
5. Tampered `returnTo` (`//evil.com`, `https://evil.com`, `\`) → `/dashboard`.
6. Malformed / unknown-type envelope → unsupported-link screen.
7. Refresh and back-button after execution → no duplicate agent.
8. `/?prompt=` legacy shim → identical outcome to 1–3.

## Open questions

- Name derivation from prompt: slugified words vs. the existing random-name
  helper. Cosmetic; decide in review.
- Should `/do` render a one-click confirm instead of auto-executing for
  *logged-in* arrivals? Current answer: no — execution is free by
  construction (no autostart), so the interstitial would only add friction.
  Revisit if an action type with side effects beyond "create free resource"
  arrives; the registry can carry a per-type `requiresConfirm` flag then.
