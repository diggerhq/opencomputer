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
      "state": "merged"
    },
    {
      "stream": "web",
      "attempt": 2,
      "sessionId": "6a5a5a53-380a-10bc-6aea-4996586301d3",
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
- `cloudflare-workers/api-edge/src/attribution.ts` + `attribution.test.ts`
- `cloudflare-workers/api-edge/migrations/0010_signup_attribution.sql`, `schema-snapshots/current_schema.sql`
- `cloudflare-workers/api-edge/wrangler.prod.toml`, `wrangler.toml` — var docs
- `web/src/lib/attribution.ts` + `attribution.test.ts`, `web/src/main.tsx`

## Streams

### edge — persistence, classifier, emits, login/callback hooks (design C1, C3, C4, C5) — merged

Files: `cloudflare-workers/api-edge/src/attribution.ts`, `attribution.test.ts`, `index.ts`,
`migrations/0010_signup_attribution.sql`, `schema-snapshots/current_schema.sql`, `wrangler.toml`, `wrangler.prod.toml`.

Done when: see build record (edge@2). Checks: `cd cloudflare-workers/api-edge && NODE_ENV=development npm ci && npx vitest run`.

### web — SPA capture (design C1, C2)

Files:
- `web/src/lib/attribution.ts`
- `web/src/lib/attribution.test.ts`
- `web/src/main.tsx`

Done when:
- `computeTouch` / `mergeCookie` implement the **amended** C1 exactly as the edge does
  (`cloudflare-workers/api-edge/src/attribution.ts` is canonical): touch when any `utm_*` key
  is present (even empty) or non-empty `gclid`/`fbclid` or external referrer; `ref` null for
  internal/absent/unparseable referrers; click ids trimmed, case kept, ≤100; the 2048-byte
  cap on `oc_attr=<value>` with the slim-`lt` → slim-`ft` → drop-`lt` rule; malformed cookie
  replaced. Tests cover each rule.
- `recordTouch()` writes `document.cookie` with `Domain=.opencomputer.dev` when the host ends
  with `opencomputer.dev`, host-only otherwise, `Path=/; Max-Age=7776000; SameSite=Lax; Secure`
  (omit Secure on `http:`).
- `main.tsx` calls `recordTouch()` once before `posthog.init`; a thrown error is swallowed.
- typecheck, tests, and eslint **on this stream's three files** pass (`eslint .` is broken on `main`).

Checks: `cd web && NODE_ENV=development npm ci --include=dev && npm run typecheck && npx eslint src/lib/attribution.ts src/lib/attribution.test.ts src/main.tsx && npm test`

## Order

`edge` ✔ merged · `web@1` merged · `web@2` aligns web to the amended C1, from `agent/signup-attribution`.

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

- 2026-10-06 — `edge@1` **blocked**, nothing landed: implementer's shell rate-limited
  (`ThrottlingException`) on every command. Re-dispatched as `edge@2`.
- 2026-10-06 — `edge@2` **landed → merged** (4b78f3b): 8147938 (migration 0010 + snapshot),
  a823bda (record attribution on user creation and `/auth/login`), 2ccc274 (Worker var docs).
  Checks pass: 19 files / 327 tests (25 new), `tsc --noEmit` clean. Amendments accepted:
  `ctx` inside the 6th param `SignupAttributionContext`; C1/C4/C5 gaps resolved as the edge
  implements them — folded into the design (b10dc5b). `NODE_ENV=development` needed for checks.
- 2026-10-06 — `web@1` **landed**: 072f495 (`web/src/lib/attribution.ts` + tests), 53f5880
  (`main.tsx` hook). typecheck ✔, 68 files / 355 tests ✔, its three files lint clean ✔;
  `npm run lint` reports 17 pre-existing `react-hooks/*` errors in unrelated files, identical
  on the base — **judged passing for this stream**, lint scoped to its files from now on.
  **Diverges from the edge on C1** (both wrote rules the draft left open): web requires
  non-empty `utm_*` values (edge: any key); web fills `ref` for internal referrers on tagged
  touches (edge: null); web caps click ids at 200 (edge: 100); web has no 2 KB slimming rule.
  → design C1 amended to the edge's rules; `web@2` dispatched to align. Merging `web@1` first
  so the integration branch carries the hook; `web@2` builds on it.
- Note for the PR: `web/` lint is broken on `main` independently of this work.

## Prompts

- "plausible exists on the site you just cant see it because you dont have access to it, but yes go ahead, just let me know once you're done what needs to be done to the site" → decisions 1a 2b 3a 4a 5a 6a 7a; plan v2
- "go" → dispatch `edge@1`, `web@1` (7c3d251)
