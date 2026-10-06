# Sign-up attribution — plan

thread: 1791323950.009919
lead session: ses_eecc59d7bffd4gjXixa38bDjNW
repo: diggerhq/opencomputer
branch: agent/signup-attribution
base: main
version: 1
design: .agents/design/signup-attribution.md

```kevin-state
{
  "version": 1,
  "leadSessionId": "ses_eecc59d7bffd4gjXixa38bDjNW",
  "threadId": "1791323950.009919",
  "streams": []
}
```

## Design summary

`oc_attr` cookie on `.opencomputer.dev` (first + last touch) → read in the API edge
WorkOS callback → on a newly created user: D1 `signup_attribution` row, server-side
PostHog `signed_up` (+ optional Plausible `Signup`), channel classified server-side.

## Code map

- `cloudflare-workers/api-edge/src/index.ts` — `authLogin`, `authCallback`, `provisionWorkOSIdentity`, CLI exchange
- `cloudflare-workers/api-edge/src/attribution.ts` (new) + `attribution.test.ts` (new)
- `cloudflare-workers/api-edge/migrations/0010_signup_attribution.sql` (new), `schema-snapshots/current_schema.sql`
- `cloudflare-workers/api-edge/wrangler.prod.toml`, `wrangler.toml` — var docs
- `web/src/lib/attribution.ts` (new) + `attribution.test.ts` (new), `web/src/main.tsx`

## Streams

(to be written after the design decisions)

## Order

## Verification

## How to resume

Read `kevin-state`, then `where_are_we` for this thread.

## Build record

## Prompts

See the design's Prompts section.
