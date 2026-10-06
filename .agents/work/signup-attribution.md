# Sign-up attribution — plan

thread: 1791323950.009919
lead session: ses_eecc59d7bffd4gjXixa38bDjNW
repo: diggerhq/opencomputer
branch: agent/signup-attribution
base: main
version: 2
design: .agents/design/signup-attribution.md

```kevin-state
{
  "version": 2,
  "leadSessionId": "ses_eecc59d7bffd4gjXixa38bDjNW",
  "threadId": "1791323950.009919",
  "subscriptionId": "evs_0b56c81ad9024838acb5dd2772c41f69",
  "streams": [
    {
      "stream": "edge",
      "attempt": 2,
      "sessionId": "1cb61bdf-43b5-a73a-92e5-b1aa84d8e3ce",
      "branch": "agent/signup-attribution--edge",
      "state": "landed"
    },
    {
      "stream": "web",
      "attempt": 1,
      "sessionId": "5a71358a-0bac-fc3e-bb93-70cb9195dea4",
      "branch": "agent/signup-attribution--web",
      "state": "running"
    }
  ]
}
```

## Design summary

`oc_attr` cookie on `.opencomputer.dev` (first + last touch) → read in the API edge
WorkOS callback → on a newly created user: D1 `signup_attribution` row, server-side
PostHog `signed_up` + Plausible `Signup`, channel classified server-side.
Decisions taken (design §Decisions): 1a 2b 3a 4a 5a 6a 7a.

## Code map

- `cloudflare-workers/api-edge/src/index.ts` — `authLogin`, `authCallback`, `provisionWorkOSIdentity`, CLI exchange
- `cloudflare-workers/api-edge/src/attribution.ts` (new) + `attribution.test.ts` (new)
- `cloudflare-workers/api-edge/migrations/0010_signup_attribution.sql` (new), `schema-snapshots/current_schema.sql`
- `cloudflare-workers/api-edge/wrangler.prod.toml`, `wrangler.toml` — var docs
- `web/src/lib/attribution.ts` (new) + `attribution.test.ts` (new), `web/src/main.tsx`

## Streams

### edge — persistence, classifier, emits, login/callback hooks (design C1, C3, C4, C5)

Files:
- `cloudflare-workers/api-edge/src/attribution.ts` (new)
- `cloudflare-workers/api-edge/src/attribution.test.ts` (new)
- `cloudflare-workers/api-edge/src/index.ts`
- `cloudflare-workers/api-edge/migrations/0010_signup_attribution.sql` (new)
- `cloudflare-workers/api-edge/schema-snapshots/current_schema.sql`
- `cloudflare-workers/api-edge/wrangler.toml`
- `cloudflare-workers/api-edge/wrangler.prod.toml`

Done when:
- `parseAttributionCookie`, `classifyChannel`, `touchFromRequest` (query + Referer per C1),
  `mergeAttributionCookie` are exported, pure, and unit-tested (malformed cookie, no touch,
  each channel rule, first-touch immutability, 2 KB cap).
- `authLogin` appends a `Set-Cookie: oc_attr=…` to its 302 when its own request carries a touch.
- `provisionWorkOSIdentity` takes `attribution: { cookie: string | null; req: Request }`
  (browser passes the request cookie header; CLI passes `cookie: null`); on a created user
  (insert `meta.changes === 1` and re-read id === candidate) it calls `recordSignupAttribution`
  with `entry = invitedOrgID ? "invite" : selection`. Any failure inside is logged, never thrown.
- `recordSignupAttribution` inserts the `signup_attribution` row and `ctx.waitUntil`s the
  PostHog capture (vars `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST`) and Plausible event
  (var `PLAUSIBLE_DOMAIN`, forwarding `User-Agent` and `X-Forwarded-For`); unset vars skip.
  `ctx` is threaded from the fetch handler (follow the existing `ctx.waitUntil` usage).
- Migration `0010_signup_attribution.sql` matches design C4 exactly; the snapshot gains the
  same table; wrangler files document the three new vars in the existing comment style.
- Existing tests still pass.

Checks: `cd cloudflare-workers/api-edge && NODE_ENV=development npm ci && npx vitest run`

Depends on: nothing (contract C1 is in the design).

### web — SPA capture (design C1, C2)

Files:
- `web/src/lib/attribution.ts` (new)
- `web/src/lib/attribution.test.ts` (new)
- `web/src/main.tsx`

Done when:
- `computeTouch(url, referrer, now)` and `mergeCookie(existing, touch)` implement C1
  byte-for-byte (same field names, limits, `ft` immutable, `lt` overwritten, malformed →
  replaced) and are unit-tested; `recordTouch()` wraps `document.cookie` with
  `Domain=.opencomputer.dev` when the host ends with `opencomputer.dev`, host-only otherwise,
  `Path=/; Max-Age=7776000; SameSite=Lax; Secure` (Secure omitted on `http:`).
- `main.tsx` calls `recordTouch()` once before `posthog.init`; a thrown error is swallowed.
- `npm run typecheck`, `npm run lint`, `npm test` pass.

Checks: `cd web && npm ci && npm run typecheck && npm run lint && npm test`

Depends on: nothing. **After landing, the lead compares it with the edge's C1 choices
(build record, edge@2 amendments) and re-dispatches `web@2` to align if it diverges.**

## Order

`edge` and `web` in parallel from `agent/signup-attribution`; no shared files.
Integrate each as it lands.

## Verification

- Unit: both streams' tests.
- Manual (after deploy, owner): visit `app.opencomputer.dev/?utm_source=test&utm_medium=x`,
  sign up with a fresh email, then `wrangler d1 execute opencomputer-prod --remote -c
  wrangler.prod.toml --command "select * from signup_attribution order by created_at desc limit 5"`;
  PostHog shows `signed_up` on the person; Plausible shows the `Signup` goal with source.
- Report query (design C6).

## How to resume

Read `kevin-state`, then `where_are_we` for this thread.

## Build record

- 2026-10-06 — `edge@1` **blocked**, nothing landed: the implementer's sandbox shell returned
  `ThrottlingException: Rate exceeded` on every command (5 attempts, including `true`); no clone,
  no branch, no checks. Lead's shell works again → re-dispatched as `edge@2`.
- 2026-10-06 — `edge@2` **landed** on `agent/signup-attribution--edge`: 8147938 (migration 0010 +
  snapshot), a823bda (record attribution on user creation and `/auth/login`), 2ccc274 (Worker var
  docs). Checks pass: 19 files / 327 tests (25 new in `attribution.test.ts`), `tsc --noEmit` clean.
  Amendments reported (contract choices the design left open — the C1 ones bind the `web` stream):
  - Checks need `NODE_ENV=development` (sandbox exports production; `npm ci` then drops vitest). Plan updated.
  - `ctx` rides inside the 6th param `SignupAttributionContext {cookie, req, ctx?}` rather than a
    7th param; `authCallback`/`authCLIExchange` take `ctx` from the fetch handler. **Accepted.**
  - C1: `ref` is `null` for internal or unparseable referrers.
  - C1: `gclid`/`fbclid` trimmed, ≤100 chars, **not** lowercased (case-sensitive ids).
  - C1: 2 KB cap applies to the full `oc_attr=<urlencoded>` string; over it, slim `lt`, then `ft`
    (drop term/cnt/lp, cut ref to host), then drop `lt`; `ft` always keeps t/src/med/cmp.
  - C1: "external = host not ending in opencomputer.dev" applied literally; on dev hosts a same-host
    referrer counts as a touch. Prod unaffected; left as is.
  - C4: `utm_source` matches the host table by name or host-without-.com; referrer hosts match search
    engines on any DNS label (`www.google.co.uk`), social on equal-or-subdomain. A `src` not in the
    table with no `ref` → `other` (src check precedes ref check).
  - C5: PostHog/Plausible props use the first touch (fallback last), the same touch that decides the
    channel; `gclid`/`fbclid` columns likewise. Plausible XFF falls back to `CF-Connecting-IP`.
  - Insert is `ON CONFLICT(user_id) DO NOTHING`; CLI ignores any cookie; a failed insert skips emits.
- `web@1` running.

## Prompts

- "plausible exists on the site you just cant see it because you dont have access to it, but yes go ahead, just let me know once you're done what needs to be done to the site" → decisions 1a 2b 3a 4a 5a 6a 7a; this plan v2
- "go" → dispatch `edge@1`, `web@1` (7c3d251)
