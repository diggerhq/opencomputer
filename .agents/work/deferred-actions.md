# Deferred actions — deeplink intents that survive signup

Status: active (built on `feat/deferred-actions`, PR #483; pending review + live matrix)
Last updated: 2026-07-03
Owns: the deferred-action mechanism — action envelope, `/do` executor route, auth-loop `returnTo` survival — and its first action type (`agent_prefill` from the launch site prompt box)
Supersedes: —
Implementation: `cloudflare-workers/api-edge/src/index.ts` (authLogin/authCallback) · `web/src/components/ProtectedRoute.tsx` · `web/src/` new `/do` route + action registry
Public docs: —

All file:line anchors below verified against `main` at 7fab201.

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
  catch-all (`web/src/App.tsx:51`) normalizes to `/` and the param is
  silently eaten.

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

## Frozen decisions (do not re-litigate in implementation)

- Envelope: `{v: 1, type: string, params: object}`, base64url-encoded UTF-8
  JSON in `?action=` on the `/do` route. Unknown `v` or `type` → friendly
  unsupported-link screen, never a crash.
- Carrier: `returnTo` → WorkOS `state` → callback redirect. Same-origin
  **path** only; validation at both ends, enforcement at the callback; no
  signing (tampering can only pick a different page on our origin).
- `agent_prefill` creates the agent (managed credential, default runtime +
  model, deterministic prompt-derived name) and lands on the agent's sessions
  tab with the composer prefilled. **It does not create a session** — the first
  turn spends credits, so it happens on an explicit user keypress. This also
  closes the drive-by case: a malicious link can at worst create a free
  agent, never spend money.
- No confirm interstitial on `/do` (execution is free by construction). A
  per-type `requiresConfirm` flag can be added to the registry when an
  action type with real side effects arrives.
- Prompt cap at envelope validation: **1000 chars** after trim, min 1. Kept
  in lockstep with the edge `returnTo` length cap (**4096**) — a longer
  prompt would make the `/do?action=` URL exceed what round-trips through
  the WorkOS `state` param on the anonymous signup path. WorkOS documents no
  `state` maximum, so we bound it ourselves rather than rely on a large
  round-trip.
- **Single entry — no `/?prompt=` shim.** There is exactly one way in:
  `/do?action=<envelope>`. The launch site mints that URL directly (it uses
  the same base64url algorithm as `encodeAction`). We deliberately do NOT
  add a `/?prompt=` compatibility path — one behavior, no fork.
- **Attribution params are first-class passengers.** `utm_*`, ad click IDs
  (`gclid`, `fbclid`, …), and `ref` ride as sibling query params next to
  `action` — never inside the envelope — so analytics tools read them from
  their standard positions. Everything that rewrites or strips URLs
  preserves them: `/do` strips only `action`, and
  `returnTo = pathname + search` round-trips them through auth untouched.
  Our only reserved param names are `action` (on `/do`) and `returnTo` (on
  `/auth/login`) — neither collides with any tracking convention.
- **Deterministic agent name** (`agent_prefill`): derived from the prompt
  (slug + short stable hash), NOT random. So a retry — or the same link
  clicked twice — resolves to the same `(owner, name)` and `/v3/agents`
  create-or-get returns the existing agent instead of duplicating. That
  endpoint dedupes on `(owner, name)`; it has no idempotency-key path.
- **`safeReturnTo` rejects ASCII control chars** in addition to
  host/protocol/backslash tricks — a CR/LF surviving URL-decoding would
  corrupt or inject into the callback `Location` header.
- `/do` sits OUTSIDE `ProtectedRoute` and owns its auth check. Reason: an
  anonymous arrival must fire `deferred_action_landed` while the UTM-laden
  URL is live, BEFORE bouncing to login — behind ProtectedRoute the page
  never renders pre-auth, so the top of the funnel (landed but never signed
  up) would be invisible and first-touch attribution would date from after
  signup.

## Build plan

Seven steps, each independently compilable; commit per step or in coherent
pairs. Steps 1–3 are the generic mechanism; 4–7 are the first action type
and funnel wiring.

### Step 1 — envelope module: `web/src/lib/deferred-actions.ts` (new)

Unicode-safe base64url helpers + envelope codec + zod schema. Get the
encoding exactly right (naive `btoa` breaks on non-ASCII):

```ts
import { z } from 'zod'

export const ActionEnvelopeSchema = z.object({
  v: z.literal(1),
  type: z.string().min(1),
  params: z.record(z.unknown()),
})
export type ActionEnvelope = z.infer<typeof ActionEnvelopeSchema>

export function encodeAction(envelope: ActionEnvelope): string {
  const bytes = new TextEncoder().encode(JSON.stringify(envelope))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

// Returns null on any malformed input (bad base64, bad JSON, schema miss).
export function decodeAction(raw: string): ActionEnvelope | null {
  try {
    const b64 = raw.replaceAll('-', '+').replaceAll('_', '/')
    const bin = atob(b64)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    const res = ActionEnvelopeSchema.safeParse(parsed)
    return res.success ? res.data : null
  } catch {
    return null
  }
}

export const AgentPrefillParamsSchema = z.object({
  prompt: z.string().trim().min(1).max(1000), // lockstep with edge returnTo cap
})
```

The `agent_prefill` handler derives a **deterministic** name from the prompt
(a slug + short stable hash — `deriveAgentName`), so retries and repeat
clicks hit the same `(owner, name)` and dedupe server-side. (No shared
random-name module — `Agents.tsx` keeps its own `randomAgentName` for the
interactive create dialog, where fresh names are wanted.)

### Step 2 — edge: `returnTo` through WorkOS `state`

File: `cloudflare-workers/api-edge/src/index.ts`. Route dispatch is at
`:1963-1964`; the `json()` helper already exists in this file.

(a) Add an exported validator near `authLogin`:

```ts
// Same-origin path only: no scheme, no host, no protocol-relative, no
// backslash tricks, no control chars. Anything else → null (caller falls
// back to /dashboard). The 4096 cap is in lockstep with the prompt cap.
export function safeReturnTo(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 4096) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null; // CR/LF header injection
  return raw;
}
```

(b) `authLogin` (`:1157-1168`): read `returnTo` from the request URL; when
`safeReturnTo` passes, add `authURL.searchParams.set("state",
JSON.stringify({ returnTo }))`. No `state` param otherwise (today's shape).

(c) `authCallback` (`:1170-1283`): parse `state` if present —
`JSON.parse` in a try/catch, then `safeReturnTo(parsed.returnTo)` again.
Replace the hard-coded landing at `:1275`:

```ts
const dashURL = `${reqURL.origin}${returnTo ?? "/dashboard"}`;
```

Everything else in the callback (user/org upsert `:1197-1268`, JWT mint
`:1272`, cookie header `:1280`) is untouched — first-signup provisioning
(personal org, Autumn customer) happens before the redirect, so a
brand-new user lands on `returnTo` with a working org.

(d) Tests in `cloudflare-workers/api-edge/src/index.test.ts` (vitest, `npm
test` in `cloudflare-workers/api-edge/`): `safeReturnTo` accepts `/do?x=1`,
`/sessions/abc`; rejects `https://evil.com`, `//evil.com`, `/a\\b`,
`javascript:alert(1)`, 3000-char input, null.

### Step 3 — SPA: capture the requested URL

`web/src/components/ProtectedRoute.tsx:15` — replace:

```ts
const returnTo = window.location.pathname + window.location.search
window.location.replace(
  returnTo === '/'
    ? '/auth/login'
    : `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
)
```

### Step 4 — SPA: `/do` route + `agent_prefill` handler

(a) New page `web/src/pages/DeferredAction.tsx`, registered in
`web/src/App.tsx` OUTSIDE `ProtectedRoute` (a sibling of the
`ProtectedRoute` route inside `<Routes>`, like the catch-all at `:51`) —
the executor is a full-screen transient state that owns its auth check, not
a shell page. Lazy-import like the other pages (`App.tsx:9-23`).

Auth handling inside the page (`AuthProvider` wraps all routes,
`App.tsx:27`, so `useAuth` works here): while `loading` → spinner; if
`!user` → fire the pre-auth `landed` event (step 7) and
`window.location.replace('/auth/login?returnTo=' +
encodeURIComponent(window.location.pathname + window.location.search))`;
if `user` → execute. The explicit self-redirect duplicates two lines of
ProtectedRoute deliberately — the price of firing analytics pre-bounce.

(b) Handler registry, in `web/src/lib/deferred-actions.ts`:

```ts
export type ActionResult = { navigateTo: string; navigateState?: unknown }
export type ActionHandler = (params: unknown) => Promise<ActionResult>
// Registry — one entry per action type. Add new types here.
export const actionHandlers: Record<string, ActionHandler> = { ... }
```

`agent_prefill` handler (imports `createAgent` from `@/api/client`,
`DEFAULT_RUNTIME`/`defaultModelFor` from `@/lib/runtimes:87,100`,
`randomAgentName` from the new `@/lib/agent-names`):

```ts
async function agentPrefill(params: unknown): Promise<ActionResult> {
  const p = AgentPrefillParamsSchema.parse(params) // throws → failed state
  const agent = await createAgent({
    name: randomAgentName(),
    prompt: p.prompt,
    model: defaultModelFor(DEFAULT_RUNTIME),
    runtime: DEFAULT_RUNTIME,
    credential: 'managed', // reserved value, see Agents.tsx:43
  })
  return {
    navigateTo: `/agents/${agent.id}/sessions`,
    navigateState: { composerPrefill: p.prompt },
  }
}
```

(c) The page component: read `?action=` once on mount, decode, dispatch,
navigate on success. Hard requirements:

- **StrictMode double-mount guard** (`web/src/main.tsx:45` — StrictMode is
  ON; an unguarded effect fires twice in dev and creates two agents). Use a
  `useRef(false)` executed-flag set synchronously before the first await.
- **Strip ONLY the `action` param before executing** (after the `landed`
  capture): read the envelope into a variable, then rebuild the URL without
  `action` but WITH all sibling params (`utm_*`, click IDs) and
  `window.history.replaceState` to it — refresh/back cannot replay, and
  attribution params stay live for the analytics session.
- States: `running` (spinner + "Setting up your agent…", style it on the
  ProtectedRoute spinner, `ProtectedRoute.tsx:19-28`), `unsupported`
  (unknown type / malformed envelope: neutral copy + `<Link to="/">Go to
  dashboard</Link>`), `failed` (API error: message from `notifyError`-style
  extraction + retry button that re-runs the handler with the captured
  envelope + dashboard link).
- Navigate with `navigate(result.navigateTo, { replace: true, state:
  result.navigateState })`.

### Step 5 — SPA: composer prefill in AgentDetail

`web/src/pages/AgentDetail.tsx` — the sessions-tab composer's state is
`const [task, setTask] = useState('')` at `:123`. Add `useLocation` to the
existing react-router import (`:3`) and seed:

```ts
const location = useLocation()
const [task, setTask] = useState(
  () =>
    (location.state as { composerPrefill?: string } | null)?.composerPrefill ??
    '',
)
```

Router state doesn't survive refresh — acceptable; the agent already
exists. Note the default tab for `/agents/:id` is overview (`:54-59`), so
the handler navigates to `/agents/:id/sessions` explicitly.

### Step 6 — Site emits `/do?action=` directly (no shim)

**One way in, no fork.** The launch site (`diggerhq/durableagentsessions`,
separate repo) mints `/do?action=<envelope>` URLs in its hero, using the
same base64url algorithm as `encodeAction`, with any inbound `utm_*`/click
IDs appended as sibling params. No `/?prompt=` compatibility path is added
to the SPA — `App.tsx`'s index route stays `<Dashboard />`. (The site's
current `/?prompt=` hero is pre-launch and switches to `/do` as part of
shipping this; that one-line change lives in the site repo, not this PR.)

### Step 7 — PostHog funnel events + attribution

Convention: `import posthog from 'posthog-js'` and call `.capture`
directly (as `web/src/api/client.ts:1,169`; init is gated on the token in
`main.tsx:28`, so calls are safe no-ops locally). From the `/do` page:

- `deferred_action_landed` `{action_type, authenticated: boolean}` — on
  mount, while the URL (incl. `utm_*` siblings) is intact. For the
  anonymous branch this fires immediately before the login redirect: pass
  `{ transport: 'sendBeacon' }` as capture options, or the navigation eats
  the batched event.
- `deferred_action_executed` `{action_type, agent_id, ms}` — after handler
- `deferred_action_failed` `{action_type, reason:
  'malformed'|'unknown_type'|'api_error'}`

Do not add a custom first-send event — if we later want it, it becomes a
property on the existing session-start path, not a new event.

How signup-source attribution works end to end (no extra code beyond the
above; this is the why behind the ordering rules):

1. The site link carries `utm_source=...` etc. as sibling params. The
   pre-auth `landed` event is captured while they're in the URL, so PostHog
   records first-touch campaign properties on the anonymous person.
2. `returnTo` preserves the full query string through the WorkOS round
   trip, so the first post-auth pageview re-presents the same params —
   attribution holds even if the pre-auth beacon was lost.
3. On login, `posthog.identify` (`web/src/hooks/auth-provider.tsx:24`)
   merges the anonymous pre-auth person into the identified one — the
   signup inherits `$initial_utm_*` from the original click. "Source of
   signups" is then a standard PostHog insight; no edge/D1 changes needed.
4. Cross-domain caveat: params the SITE received (from a tweet, an ad)
   don't propagate to the app link by themselves. Site-side convention
   (`diggerhq/durableagentsessions`, not this PR): the hero forwards its
   own inbound `utm_*`/`gclid`/`fbclid`/`ref` onto the `/do` URL it mints.
   Optional follow-up, explicitly not v1: if the site adopts the same
   PostHog project, pass the site's `distinct_id` across the domain hop
   (posthog-js `bootstrap` option) to stitch site pageviews to app signups.

## Do NOT touch

- `cloudflare-workers/api-edge/assets/` — gitignored build output; never
  build or commit it.
- `wrangler.toml` / `wrangler.prod.toml` and any `wrangler` command — the
  default configs point at prod. No deploys from this branch; personal-dev
  edge testing needs `--config wrangler.igor-dev.toml` and the runbook
  `.agents/reference/dev-edge-setup.md` (coordinate with Igor instead).
- `web/src/api/client.ts` request layer and `sessions-api` — nothing needed
  there; `createAgent` (`client.ts:427`) and `createSession`
  (`client.ts:631`) already cover the chain. v1 does not call
  `createSession` at all.
- The signup/org-provisioning block in `authCallback` (`index.ts:1197-1268`).

## Verification

Automated (all must pass before push):

- `cd web && npm run typecheck && npm run lint` — plus `npm run build` once
  to catch tsc -b project issues.
- `cd cloudflare-workers/api-edge && npm test` — includes the new
  `safeReturnTo` cases.
- `safeReturnTo` cases (cap, control chars, host/protocol tricks) live in
  the edge test file. The codec has no `web/`-side vitest yet — verify by
  hand in the browser console or add a runner later.
- Byte-scan the diff before push. **Do NOT use `grep -P` alone** — a NUL
  byte makes grep treat the file as binary and silently report no match
  (this bit us during the review round). Use a NUL-safe scan, e.g.
  `git diff origin/main | LC_ALL=C grep -aP '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'`
  (the `-a` forces text mode) and separately confirm no NUL:
  `git grep -I -l $'\x00' $(git diff --name-only origin/main)` returns
  nothing.

Manual matrix (needs a deployed edge — record in the PR which rows ran;
rows 1–2 need Igor's dev edge or a post-merge check, do not deploy from
this branch):

1. Anonymous → prompt box → signup (fresh email) → lands on `/do` → agent
   exists, composer prefilled, send works, turn runs on managed billing.
2. Anonymous → prompt box → login (existing account) → same.
3. Logged-in → prompt box → immediate execution, no auth bounce.
4. Logged-out, shared session URL (no action) → login → lands on that
   session, not `/dashboard` (generic returnTo works).
5. Tampered `returnTo` (`//evil.com`, `https://evil.com`, `\`, a `%0d%0a`
   CRLF) → `/dashboard`.
6. Malformed / unknown-type envelope → unsupported-link screen.
7. Refresh and back-button after execution → no duplicate agent (also
   verify in dev that StrictMode double-mount doesn't double-create).
8. Retry idempotency: force the create to fail once (offline), hit **Try
   again**, and re-run the same link twice — deterministic name means one
   agent, not several.
9. Non-ASCII prompt (emoji, CJK) survives encode → decode → agent prompt.
10. Attribution: `/do?action=...&utm_source=test&gclid=x` anonymous →
    signup → PostHog shows `deferred_action_landed` pre-auth with the UTM
    props, the `deferred_action_executed` event carries `agent_id`, and the
    identified person carries `$initial_utm_source=test`.

## Failure modes (behavior contract)

| Case | Outcome |
| --- | --- |
| Malformed / unknown-type / oversized action | Neutral "unsupported link" screen, dashboard link, `deferred_action_failed` |
| `returnTo` fails validation | Callback falls back to `/dashboard` (today's behavior) |
| Agent create fails (e.g. `managed_unavailable` 422) | `failed` state on `/do` with retry + dashboard link |
| Refresh / back after execution | Param already stripped; no replay. Re-visiting the same envelope later resolves to the same `(owner, name)` (deterministic name) → the existing agent, no duplicate |
| User abandons WorkOS mid-flow | Nothing created; the link works when clicked again |
| Email verification completed in another browser | `state` is bound to the WorkOS flow, not the browser — callback still lands on `returnTo` |

## PR / process

- This work lives on `feat/deferred-actions` (PR #483, draft). PR-only
  repo: never merge, never push main, no force-push. Commit messages carry
  rationale per repo convention.
- Site-side URL migration and this doc's write-backs are the coordinator's,
  not the implementer's. If a frozen decision looks wrong while building,
  stop and flag it in the PR description rather than improvising.

## Review round (2026-07-03) — changes from the first build

Reviewer findings, all addressed on the branch (code is authoritative where a
sketch above lagged):

1. **Length lockstep (the launch-path bug).** The prompt cap (was 4000) and
   the edge `returnTo` cap (was 2048) were inconsistent, so a valid long
   prompt silently dropped to `/dashboard` after signup. Fixed: prompt cap
   1000, `returnTo` cap 4096, sized so the encoded `/do?action=` URL always
   fits the WorkOS `state` round-trip. WorkOS documents no `state` max, so we
   bound it ourselves.
2. **Dropped the `/?prompt=` shim entirely** (was behind ProtectedRoute, so
   it never got the pre-auth `/do` behavior anyway). One entry, no fork — the
   site emits `/do?action=` directly. Resolves the reviewer's finding 2 and
   the "no forking without reason" directive together.
3. **`safeReturnTo` rejects ASCII control chars** (CR/LF header injection),
   with edge tests.
4. **Retry-safe agent creation:** deterministic prompt-derived name (was
   random), so retry / repeat-click dedupes on `(owner, name)` instead of
   spawning duplicates. Reverted the now-unneeded `agent-names.ts`
   extraction — `Agents.tsx` keeps its own random name for the create dialog.
5. **Telemetry:** `deferred_action_executed` carries `agent_id` (via a
   handler `analytics` field) as the contract specified, not `navigate_to`.

Process note: the control-char regex was first written with **literal** NUL/
0x1f/0x7f bytes (compiles green, binary in git). The `grep -P` byte-scan
missed it — a NUL makes grep treat the file as binary and report no match.
Use the NUL-safe scan in Verification above.
