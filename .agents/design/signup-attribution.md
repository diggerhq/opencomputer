# Sign-up attribution — design

version: 1
Status: **design draft — awaiting decisions**
Thread: Slack `1791323950.009919` · branch `agent/signup-attribution` · base `main`

## Brief

Know where each sign-up comes from. Marketing site `opencomputer.dev` runs Plausible
(aggregate, cookieless, no user identity). The dashboard `app.opencomputer.dev` runs
PostHog (`web/src/main.tsx`, `person_profiles: 'identified_only'`, identified by
local user id in `web/src/hooks/auth-provider.tsx`). Neither answers "which channel
did *this account* come from" because the first touch happens on the site and the
account is created on the app: PostHog on the app only ever sees `opencomputer.dev`
as the referrer.

In scope: app side (this repo). Out: the site script (a handoff prompt for the agent
owning the site ships with the PR), multi-touch, ad-platform conversion APIs,
cross-device identity, consent UI, backfill of existing users.

## Kernel

One first-party cookie `oc_attr` on `.opencomputer.dev`, written by whichever page
the visitor lands on first (site or app), carries first-touch and last-touch
source. The API edge reads it in the WorkOS callback and, **only when it creates
a new user**, writes one row to D1 `signup_attribution`, emits a server-side
PostHog `signed_up` event (and, optionally, a Plausible `Signup` goal), and
classifies the referrer into a channel server-side so untagged links still count.

## Where sign-up actually happens (code map)

- Prod browser sign-up: `cloudflare-workers/api-edge/src/index.ts`
  `authLogin` (≈L3756) → WorkOS AuthKit → `authCallback` (≈L3996) →
  `provisionWorkOSIdentity(req, env, profile, workosOrgID, "browser")` (≈L3821).
  New-user branch: `if (!userRow)` with `INSERT INTO users … ON CONFLICT(email) DO
  UPDATE` — a conflict means the user already existed under another WorkOS id, so
  "new" must be decided by the insert actually creating a row, not by `!userRow`.
- CLI device sign-up: same function with `"cli"` (≈L4504). No browser, no cookie.
- Invitations: `acceptPendingInvitations` runs right after the personal org is
  created; a non-null return at creation time means the user arrived by invite.
- D1 schema: `cloudflare-workers/api-edge/schema-snapshots/current_schema.sql`
  (`users(id, email, workos_user_id, name, created_at)`), migrations in
  `cloudflare-workers/api-edge/migrations/` (next: `0010_…`).
- Dashboard SPA: `web/` (Vite + React), served as Worker assets; PostHog init in
  `web/src/main.tsx`.
- Internal admin routes use HMAC with `CF_ADMIN_SECRET` (`/internal/pool-probe`
  pattern ≈L5187).
- The Go server's WorkOS path (`internal/auth/oauth_handlers.go`,
  `ProvisionOrgAndUser`) is the self-hosted/combined-mode path; not the prod
  sign-up. Out of scope (decision 7).

## Constraints

- No PII beyond what `users` already holds; the cookie carries no identity.
- Attribution must never break login: every step after the user insert is
  best-effort (`try/catch`, `ctx.waitUntil` for network calls).
- D1 prod gets changes only via Wrangler migrations (`migrations/README.md`).
- Cookie ≤ 2 KB, readable by JS on both hosts (not HttpOnly), `SameSite=Lax`,
  `Secure`, 90 days.
- Plausible server-side events must carry the visitor's `User-Agent` and
  `X-Forwarded-For` so they join the site visit; the callback request comes from
  the user's browser, so both are available.

## Components

### C1 — Cookie contract `oc_attr` (shared with the site; the handoff prompt repeats it verbatim)

Name `oc_attr`; Domain `.opencomputer.dev` (host-only on any other host, e.g. localhost);
Path `/`; Max-Age 7 776 000 (90 d); `SameSite=Lax; Secure`; value = URL-encoded JSON:

```json
{
  "v": 1,
  "ft": { "t": 1790000000, "src": "twitter", "med": "social", "cmp": "launch", "term": null, "cnt": null,
          "ref": "t.co", "lp": "opencomputer.dev/", "gclid": null, "fbclid": null },
  "lt": { "...same shape..." }
}
```

Field rules (both writers must agree):
- A *touch* is recorded when the page has any `utm_*`, `gclid`, `fbclid`, or an
  external referrer (host not ending in `opencomputer.dev`). Internal navigation
  records nothing.
- `ft` is written once and never overwritten; `lt` is overwritten on every touch.
- `src/med/cmp/term/cnt` ← `utm_source/medium/campaign/term/content`, lowercased,
  trimmed, ≤ 100 chars. `ref` ← referrer host + path, no query, ≤ 200 chars.
  `lp` ← landing host + path, no query, ≤ 200 chars. `t` ← unix seconds.
- If `src` is absent but `ref` is external, `src` stays null; the edge classifier
  derives the channel from `ref`.
- Writers never read `lt`/`ft` semantics differently; a malformed cookie is
  replaced as if absent.

### C2 — App capture (`web/src/lib/attribution.ts`, called once from `web/src/main.tsx`)

`recordTouch(location, document.referrer, now)` implements C1 on the dashboard
host. Pure function `computeTouch(url, referrer, now): Touch | null` and
`mergeCookie(existing: string | null, touch): string` are unit-tested;
`document.cookie` I/O is a thin wrapper. Runs before PostHog init, on first
load only (not on route change).

### C3 — Edge capture at `/auth/login`

`authLogin` also applies C1 from its own request (query `utm_*`, `Referer`
header) by appending a `Set-Cookie` to the 302. Covers deep links like
`app.opencomputer.dev/auth/login?utm_source=…` that never render the SPA.

### C4 — Edge persistence (`cloudflare-workers/api-edge/src/attribution.ts`)

- `parseAttributionCookie(cookieHeader): Attribution | null` (tolerant).
- `classifyChannel(touch, entry): Channel` where `Channel` =
  `direct | organic_search | paid_search | social | referral | email | invite | cli | other`.
  Rules, in order: `entry === "invite"` → `invite`; `entry === "cli"` → `cli`;
  `gclid` or `med in (cpc, ppc, paid)` → `paid_search`; `med in (email, newsletter)`
  → `email`; `src/ref` host in a fixed table (google, bing, duckduckgo, yahoo → `organic_search`;
  twitter.com, x.com, t.co, linkedin.com, news.ycombinator.com, reddit.com,
  facebook.com, youtube.com, github.com → `social`); any other `ref` → `referral`;
  no touch at all → `direct`. First-touch decides the channel; last-touch is stored.
- `recordSignupAttribution(env, ctx, { userID, entry, cookie, req, nowSec })`:
  inserts the row, then `ctx.waitUntil` the analytics emits. Never throws.
- Hook: `provisionWorkOSIdentity` gains a 6th parameter `attribution:
  { cookie: string | null; req: Request }` and, inside the new-user branch, after
  `acceptPendingInvitations`, calls `recordSignupAttribution` with
  `entry = invitedOrgID ? "invite" : selection`. "New" = the `INSERT` reported
  `meta.changes === 1` **and** the re-read row's id equals `candidateID`.

Table (migration `0010_signup_attribution.sql`, plus the snapshot):

```sql
CREATE TABLE signup_attribution (
  user_id        TEXT PRIMARY KEY REFERENCES users(id),
  entry          TEXT NOT NULL,            -- browser | cli | invite
  channel        TEXT NOT NULL,            -- see Channel
  first_source   TEXT, first_medium TEXT, first_campaign TEXT, first_term TEXT, first_content TEXT,
  first_referrer TEXT, first_landing TEXT, first_touch_at INTEGER,
  last_source    TEXT, last_medium  TEXT, last_campaign  TEXT, last_term  TEXT, last_content  TEXT,
  last_referrer  TEXT, last_landing  TEXT, last_touch_at  INTEGER,
  gclid          TEXT, fbclid TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_signup_attribution_created ON signup_attribution(created_at);
```

### C5 — Analytics emit (same module)

- PostHog (decision 2): `POST {POSTHOG_HOST}/capture/` with
  `{ api_key, event: "signed_up", distinct_id: userID, properties: { channel, entry,
  source, medium, campaign, referrer, landing, $set_once: { signup_channel,
  signup_source, signup_medium, signup_campaign, signup_referrer } } }`.
  `distinct_id` = local user id, the same value `posthog.identify` uses in the SPA,
  so the event and person merge. New Worker vars `POSTHOG_PROJECT_TOKEN`,
  `POSTHOG_HOST` (default `https://us.i.posthog.com`); unset → skip.
- Plausible (decision 2): `POST https://plausible.io/api/event` with
  `{ name: "Signup", url: "https://app.opencomputer.dev/auth/callback", domain: PLAUSIBLE_DOMAIN,
  props: { channel, source, campaign } }`, forwarding the request's `User-Agent`
  and `X-Forwarded-For` so Plausible joins it to the site visitor. Var
  `PLAUSIBLE_DOMAIN` (`opencomputer.dev`); unset → skip. The site must **not**
  also fire `Signup`, or it double counts (handoff prompt says so).

### C6 — Report (decision 3)

Default: PostHog insight "signed_up by channel, weekly" (no code) plus this query,
documented in the PR, for D1:

```sql
SELECT strftime('%Y-%W', created_at, 'unixepoch') AS week, channel, count(*) AS signups
FROM signup_attribution GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC;
```

Option: `GET /internal/signup-attribution?weeks=12`, HMAC `CF_ADMIN_SECRET` like
`/internal/pool-probe`, returning `[{ week, channel, signups }]`.

## Interactions

1. Visitor lands on site or app with a touch → C1 cookie written (site script or C2/C3).
2. Visitor clicks Log in → `/auth/login` (C3 may add a touch) → WorkOS → `/auth/callback`.
3. `authCallback` passes `{ cookie: req.headers.get("cookie"), req }` to
   `provisionWorkOSIdentity`; on a *created* user, C4 writes the row, C5 emits.
4. SPA loads, `posthog.identify(user.id)` → person merges with the server event.

## Risks

- **Double counting in Plausible** if the site also fires `Signup` → handoff prompt forbids it.
- **Email-conflict path** marks nothing (not a new account) — intended; note in PR.
- **Cookie contention**: site and app write the same cookie; C1 is the single contract
  and both implementations keep `ft` immutable, so order of writes cannot lose first touch.
- **PostHog person merge** relies on `distinct_id` = local user id in both places;
  `auth-provider.tsx` already does this.
- **Ad blockers** block posthog-js on the app, not the server-side event — server-side
  is the more complete record; D1 is the source of truth either way.
- Worker vars need setting in prod (`POSTHOG_PROJECT_TOKEN`, `PLAUSIBLE_DOMAIN`); unset
  means D1 rows only. Documented in `wrangler.prod.toml` comments.

## Decisions

1. **Persistence shape** — a) new table `signup_attribution` (pick: no churn on `users`,
   easy to drop, indexable) · b) columns on `users`.
2. **Analytics emit on sign-up** — a) PostHog server-side only · b) PostHog + Plausible
   `Signup` goal server-side (pick: the Plausible dashboard you already watch gets
   conversions by source with zero site work) · c) Plausible only.
3. **Report** — a) PostHog insight + documented D1 query (pick: zero code, no new
   surface) · b) also an HMAC `/internal/signup-attribution` JSON endpoint.
4. **Cookie carrier** — a) one `oc_attr` JSON cookie with `ft`/`lt` (pick) · b) two
   cookies `oc_ft`/`oc_lt`.
5. **Channel for invited users** — a) `invite` regardless of cookie (pick: the inviter's
   channel is not theirs) · b) classify from cookie like anyone else.
6. **Capture points in the app** — a) SPA first load + `/auth/login` edge (pick: covers
   deep links) · b) SPA only.
7. **Go server WorkOS path** — a) leave untouched (pick: prod sign-up is the edge) ·
   b) mirror the hook in `internal/auth/workos.go` too.

## Unknowns left

- L3: whether Plausible joins the server-side `Signup` to the site visitor in practice
  (IP/UA hashing) — verified after deploy by checking the goal's source breakdown.
- L1: PostHog project token / Plausible domain availability as Worker vars (owner sets them).

## Prompts

- "if I were to build attribution to know where each sign up is coming from, how would I build it?" → brief v1
- "i use plausible rn for the site" → brief v2
- "the site is at https://github.com/opencomputer-site-v1" → repo split
- "actually you can focus on the app side, once done you can give me a prompt that I can send [the site agent] because he has access to the marketing site" → brief v3
- "design" → this document, v1
