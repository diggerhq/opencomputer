# Sign-up attribution — design

version: 1 (C1 amended 2026-10-06 after edge@2 landed)
Status: **building** — decisions 1a 2b 3a 4a 5a 6a 7a taken
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
PostHog `signed_up` event and a Plausible `Signup` goal, and classifies the
referrer into a channel server-side so untagged links still count.

## Where sign-up actually happens (code map)

- Prod browser sign-up: `cloudflare-workers/api-edge/src/index.ts`
  `authLogin` → WorkOS AuthKit → `authCallback` →
  `provisionWorkOSIdentity(req, env, profile, workosOrgID, "browser", attribution)`.
  New-user branch: `INSERT INTO users … ON CONFLICT(email) DO UPDATE` — a conflict
  means the user already existed under another WorkOS id, so "new" is decided by the
  insert actually creating a row (`meta.changes === 1` and re-read id === candidate).
- CLI device sign-up: same function with `"cli"`. No browser, no cookie.
- Invitations: `acceptPendingInvitations` runs right after the personal org is
  created; a non-null return at creation time means the user arrived by invite.
- D1 schema: `cloudflare-workers/api-edge/schema-snapshots/current_schema.sql`,
  migrations in `cloudflare-workers/api-edge/migrations/` (`0010_signup_attribution.sql`).
- Dashboard SPA: `web/` (Vite + React), served as Worker assets; PostHog init in
  `web/src/main.tsx`.
- Internal admin routes use HMAC with `CF_ADMIN_SECRET` (`/internal/pool-probe` pattern).
- The Go server's WorkOS path (`internal/auth/oauth_handlers.go`,
  `ProvisionOrgAndUser`) is the self-hosted/combined-mode path; not the prod
  sign-up. Out of scope (decision 7a).

## Constraints

- No PII beyond what `users` already holds; the cookie carries no identity.
- Attribution must never break login: every step after the user insert is
  best-effort (`try/catch`, `ctx.waitUntil` for network calls).
- D1 prod gets changes only via Wrangler migrations (`migrations/README.md`).
- Cookie ≤ 2 KB, readable by JS on both hosts (not HttpOnly), `SameSite=Lax`,
  `Secure`, 90 days.
- Plausible server-side events must carry the visitor's `User-Agent` and client IP
  so they join the site visit; the callback request comes from the user's browser.

## Components

### C1 — Cookie contract `oc_attr` (shared by the site script, the SPA and the edge; the edge implementation in `cloudflare-workers/api-edge/src/attribution.ts` is canonical)

Name `oc_attr`; Domain `.opencomputer.dev` (host-only on any other host, e.g. localhost);
Path `/`; Max-Age 7 776 000 (90 d); `SameSite=Lax; Secure` (omit `Secure` on `http:`);
value = URL-encoded JSON:

```json
{
  "v": 1,
  "ft": { "t": 1790000000, "src": "twitter", "med": "social", "cmp": "launch", "term": null, "cnt": null,
          "ref": "t.co/abc", "lp": "opencomputer.dev/", "gclid": null, "fbclid": null },
  "lt": { "...same shape..." }
}
```

Field rules (every writer must agree; these resolve the gaps the first draft left):
- **Touch test**: a touch exists when the URL has any query key starting with `utm_`
  (value may be empty), or a non-empty `gclid`/`fbclid`, or an **external** referrer.
  Internal navigation records nothing.
- **Internal host** = hostname lowercased ends with `opencomputer.dev` (literal; on dev
  hosts a same-host referrer therefore counts as a touch — accepted).
- `ft` is written once and never overwritten; `lt` is overwritten on every touch.
- `t` = unix **seconds** (integer).
- `src/med/cmp/term/cnt` ← `utm_source/medium/campaign/term/content`: trimmed,
  lowercased, cut to **100** chars; empty → `null`.
- `gclid/fbclid`: trimmed, **case kept**, cut to **100** chars; empty → `null`.
- `ref` ← referrer `host + pathname` (no query/fragment, `URL.host` so a port is kept),
  cut to **200** chars; **`null` when the referrer is absent, unparseable, or internal**
  (even on a utm-tagged touch).
- `lp` ← landing `host + pathname`, same rules, ≤ 200 chars; `null` if unparseable.
- **Malformed cookie** (undecodable, invalid JSON, `v !== 1`, `ft` missing, or a touch
  whose `t` is not a finite number) → replaced as if absent: `ft = lt = new touch`.
  When reading, string fields are cut to their caps and unknown keys dropped.
- **Size cap**: the full `oc_attr=<urlencoded value>` string must be ≤ **2048** bytes.
  If over, apply in order until it fits: slim `lt`; slim `ft`; drop `lt` (`null`).
  *Slim* = set `term`, `cnt`, `lp` to `null` and cut `ref` to its host. `ft` always
  keeps `t/src/med/cmp`.
- `src` absent with an external `ref` → `src` stays `null`; the edge derives the channel from `ref`.

### C2 — App capture (`web/src/lib/attribution.ts`, called once from `web/src/main.tsx`)

`recordTouch(location, referrer, now, doc)` implements C1 on the dashboard host. Pure
`computeTouch(url, referrer, now): Touch | null` and `mergeCookie(existing, touch): string`
are unit-tested; `document.cookie` I/O is a thin wrapper. Runs before PostHog init, on
first load only.

### C3 — Edge capture at `/auth/login`

`authLogin` applies C1 from its own request (query `utm_*`, `Referer` header) by appending
a `Set-Cookie` to the 302. Covers deep links like `app.opencomputer.dev/auth/login?utm_source=…`.

### C4 — Edge persistence (`cloudflare-workers/api-edge/src/attribution.ts`)

- `parseAttributionCookie`, `classifyChannel(touch, entry): Channel`, `touchFromRequest`,
  `mergeAttributionCookie`, `recordSignupAttribution`.
- `Channel` = `direct | organic_search | paid_search | social | referral | email | invite | cli | other`.
  Rules in order: `entry === "invite"` → `invite`; `entry === "cli"` → `cli`; `gclid` or
  `med ∈ {cpc, ppc, paid}` → `paid_search`; `med ∈ {email, newsletter}` → `email`; `src`
  matches the host table by name or host-without-`.com` (google/bing/duckduckgo/yahoo →
  `organic_search`; twitter.com, x.com, t.co, linkedin.com, news.ycombinator.com, reddit.com,
  facebook.com, youtube.com, github.com → `social`); `src` present but unknown → `other`;
  otherwise `ref` host matches search engines on any DNS label (`www.google.co.uk`) or
  social on equal-or-subdomain; any other `ref` → `referral`; no touch → `direct`.
  **First touch decides the channel**; last touch is stored.
- `provisionWorkOSIdentity` 6th param `SignupAttributionContext { cookie, req, ctx? }`;
  browser passes the `Cookie` header, CLI passes `cookie: null`. On a created user, after
  `acceptPendingInvitations`, `recordSignupAttribution` runs with
  `entry = invitedOrgID ? "invite" : selection`. Never throws; a failed insert skips the emits.
- Insert is `ON CONFLICT(user_id) DO NOTHING` (retried callbacks are safe).

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

- PostHog: `POST {POSTHOG_HOST}/capture/` with `event: "signed_up"`, `distinct_id` = local
  user id (same as the SPA's `posthog.identify`), properties `channel, entry, source, medium,
  campaign, referrer, landing` from the **first** touch (fallback last) and
  `$set_once: { signup_channel, signup_source, signup_medium, signup_campaign, signup_referrer }`.
  Vars `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST` (default `https://us.i.posthog.com`); unset → skip.
- Plausible: `POST https://plausible.io/api/event` `{ name: "Signup", url, domain: PLAUSIBLE_DOMAIN,
  props: { channel, source, campaign } }`, forwarding `User-Agent` and `X-Forwarded-For`
  (fallback `CF-Connecting-IP`). Var `PLAUSIBLE_DOMAIN` (`opencomputer.dev`); unset → skip.
  **The site must not also fire `Signup`** or it double counts.

### C6 — Report (3a)

PostHog insight "signed_up by channel, weekly" plus, for D1:

```sql
SELECT strftime('%Y-%W', created_at, 'unixepoch') AS week, channel, count(*) AS signups
FROM signup_attribution GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC;
```

## Interactions

1. Visitor lands on site or app with a touch → C1 cookie written (site script or C2/C3).
2. Visitor clicks Log in → `/auth/login` (C3 may add a touch) → WorkOS → `/auth/callback`.
3. `authCallback` passes `{ cookie, req, ctx }` to `provisionWorkOSIdentity`; on a *created*
   user, C4 writes the row, C5 emits.
4. SPA loads, `posthog.identify(user.id)` → person merges with the server event.

## Risks

- **Double counting in Plausible** if the site also fires `Signup` → handoff prompt forbids it.
- **Email-conflict path** marks nothing (not a new account) — intended.
- **Cookie contention**: site and app write the same cookie; C1 is the single contract and
  every writer keeps `ft` immutable, so write order cannot lose first touch.
- **PostHog person merge** relies on `distinct_id` = local user id in both places.
- **Ad blockers** block posthog-js on the app, not the server-side event; D1 is the source of truth.
- Worker vars need setting in prod (`POSTHOG_PROJECT_TOKEN`, `PLAUSIBLE_DOMAIN`); unset
  means D1 rows only.
- `web/` `npm run lint` is already failing on `main` (17 `react-hooks/*` errors in unrelated
  files) — not this work's to fix; stream checks lint only their own files.

## Decisions (taken)

1. Persistence shape — **a** new table `signup_attribution`.
2. Analytics emit — **b** PostHog + Plausible server-side.
3. Report — **a** PostHog insight + documented D1 query.
4. Cookie carrier — **a** one `oc_attr` JSON cookie with `ft`/`lt`.
5. Invited users — **a** channel `invite`.
6. App capture points — **a** SPA first load + `/auth/login` edge.
7. Go server WorkOS path — **a** untouched.

## Unknowns left

- L3: whether Plausible joins the server-side `Signup` to the site visitor in practice —
  verified after deploy by checking the goal's source breakdown.
- L1: PostHog project token / Plausible domain availability as Worker vars (owner sets them).

## Prompts

- "if I were to build attribution to know where each sign up is coming from, how would I build it?" → brief v1
- "i use plausible rn for the site" → brief v2
- "the site is at https://github.com/opencomputer-site-v1" → repo split
- "actually you can focus on the app side, once done you can give me a prompt that I can send [the site agent] because he has access to the marketing site" → brief v3
- "design" → this document, v1
- "plausible exists on the site you just cant see it because you dont have access to it, but yes go ahead, just let me know once you're done what needs to be done to the site" → decisions taken
