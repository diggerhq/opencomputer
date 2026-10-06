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
  "streams": []
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

Checks: `cd cloudflare-workers/api-edge && npm ci && npx vitest run`

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

Depends on: nothing.

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

(empty)

## Prompts

- "plausible exists on the site you just cant see it because you dont have access to it, but yes go ahead, just let me know once you're done what needs to be done to the site" → decisions 1a 2b 3a 4a 5a 6a 7a; this plan v2
