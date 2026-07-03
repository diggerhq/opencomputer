# Deferred actions — deeplink intents that survive signup

Status: active (design frozen; ready to implement)
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
  model, random adjective-noun name) and lands on the agent's sessions tab
  with the composer prefilled. **It does not create a session** — the first
  turn spends credits, so it happens on an explicit user keypress. This also
  closes the drive-by case: a malicious link can at worst create a free
  agent, never spend money.
- No confirm interstitial on `/do` (execution is free by construction). A
  per-type `requiresConfirm` flag can be added to the registry when an
  action type with real side effects arrives.
- Prompt cap at envelope validation: 4000 chars after trim, min 1.
- **Attribution params are first-class passengers.** `utm_*`, ad click IDs
  (`gclid`, `fbclid`, …), and `ref` ride as sibling query params next to
  `action` — never inside the envelope — so analytics tools read them from
  their standard positions. Everything that rewrites or strips URLs
  preserves them: the shim carries them over, `/do` strips only `action`,
  and `returnTo = pathname + search` round-trips them through auth
  untouched. Our only reserved param names are `action` (on `/do`) and
  `returnTo` (on `/auth/login`) — neither collides with any tracking
  convention.
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
  prompt: z.string().trim().min(1).max(4000),
})
```

Also extract the name generator so `/do` and the create dialog share it:
move `NAME_ADJECTIVES`, `NAME_NOUNS`, `randomAgentName()` from
`web/src/pages/Agents.tsx:48-59` into a new `web/src/lib/agent-names.ts`
and import it back into `Agents.tsx` (no behavior change there).

### Step 2 — edge: `returnTo` through WorkOS `state`

File: `cloudflare-workers/api-edge/src/index.ts`. Route dispatch is at
`:1963-1964`; the `json()` helper already exists in this file.

(a) Add an exported validator near `authLogin`:

```ts
// Same-origin path only: no scheme, no host, no protocol-relative, no
// backslash tricks. Anything else → null (caller falls back to /dashboard).
export function safeReturnTo(raw: string | null): string | null {
  if (!raw || raw.length > 2048) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("\\")) return null;
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

### Step 6 — SPA: legacy `/?prompt=` shim

The site already ships `/?prompt=<text>`. In `web/src/App.tsx`, wrap the
index route: a tiny inline component that checks
`window.location.search` for `prompt`; if present and non-blank, build the
envelope with `encodeAction({v: 1, type: 'agent_prefill', params: {prompt:
value.slice(0, 4000)}})`, and return `<Navigate to={...} replace />` where
the target is `/do?action=<encoded>` **plus every other query param
carried over verbatim** (delete `prompt` from a `URLSearchParams` copy, set
`action`, keep the rest — dropping `utm_*`/`gclid` here would silently
destroy attribution); otherwise render `<Dashboard />`. The site should
migrate its hero to mint `/do?action=...` URLs directly (one-line change in
`diggerhq/durableagentsessions`, separate repo — not this PR); the shim
keeps the shipped link working meanwhile.

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
- Envelope codec unit test (vitest is not set up under `web/` — if adding
  it is disproportionate, cover the codec with a round-trip + malformed-
  input test in the edge test file by copying the two pure functions'
  behavior contract, or verify by hand in the browser console and say so in
  the PR).
- Byte-scan the diff before push: `git diff origin/main | LC_ALL=C grep -P
  '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'` must return nothing.

Manual matrix (needs a deployed edge — record in the PR which rows ran;
rows 1–2 need Igor's dev edge or a post-merge check, do not deploy from
this branch):

1. Anonymous → prompt box → signup (fresh email) → lands on `/do` → agent
   exists, composer prefilled, send works, turn runs on managed billing.
2. Anonymous → prompt box → login (existing account) → same.
3. Logged-in → prompt box → immediate execution, no auth bounce.
4. Logged-out, shared session URL (no action) → login → lands on that
   session, not `/dashboard` (generic returnTo works).
5. Tampered `returnTo` (`//evil.com`, `https://evil.com`, `\`) → `/dashboard`.
6. Malformed / unknown-type envelope → unsupported-link screen.
7. Refresh and back-button after execution → no duplicate agent (also
   verify in dev that StrictMode double-mount doesn't double-create).
8. `/?prompt=` legacy shim → identical outcome to 1–3.
9. Non-ASCII prompt (emoji, CJK) survives encode → decode → agent prompt.
10. Attribution: `/do?action=...&utm_source=test&gclid=x` anonymous →
    signup → PostHog shows `deferred_action_landed` pre-auth with the UTM
    props, and the identified person carries `$initial_utm_source=test`;
    `/?prompt=...&utm_source=test` shim path preserves both params onto
    `/do`.

## Failure modes (behavior contract)

| Case | Outcome |
| --- | --- |
| Malformed / unknown-type / oversized action | Neutral "unsupported link" screen, dashboard link, `deferred_action_failed` |
| `returnTo` fails validation | Callback falls back to `/dashboard` (today's behavior) |
| Agent create fails (e.g. `managed_unavailable` 422) | `failed` state on `/do` with retry + dashboard link |
| Refresh / back after execution | Param already stripped; no replay. Re-visiting the same envelope later creates a second agent (random name) — visible, not silent; acceptable |
| User abandons WorkOS mid-flow | Nothing created; the link works when clicked again |
| Email verification completed in another browser | `state` is bound to the WorkOS flow, not the browser — callback still lands on `returnTo` |

## PR / process

- This work lives on `feat/deferred-actions` (PR #483, draft). PR-only
  repo: never merge, never push main, no force-push. Commit messages carry
  rationale per repo convention.
- Site-side URL migration and this doc's write-backs are the coordinator's,
  not the implementer's. If a frozen decision looks wrong while building,
  stop and flag it in the PR description rather than improvising.
