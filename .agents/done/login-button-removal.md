# Login button removal + real sign-out

**Done.** Shipped on `feat/web-ui-dev` (evergreen UI PR #426).

## What

The dashboard no longer shows an in-app "Sign in" button screen. An
unauthenticated visitor is sent **straight to the WorkOS hosted login**, and
**Sign out now actually ends the WorkOS session** (not just our cookies).

## Why

- The interstitial login page was an extra click with no purpose — the gate can
  redirect to the IdP directly.
- With the button gone, the app gate always bounces to WorkOS. Logout previously
  only cleared OC's cookies, so the WorkOS SSO session survived and the gate
  silently re-authenticated the user (a "logout logs me back in" loop). Sign-out
  had to end the WorkOS session too.

## Changes

Frontend (`web/`):
- `components/ProtectedRoute.tsx` — unauthenticated → `window.location.replace('/auth/login')` (spinner during the bounce); no in-app login route.
- `App.tsx` — dropped the `/login` route + import. `pages/Login.tsx` — deleted.
- `api/client.ts` — `logout()` follows the hosted logout URL the backend returns.

Backend — both serving paths, since dev (box Go server) and prod (CF edge) handle
`/auth/logout` differently:
- `internal/auth/oauth_handlers.go` — `HandleLogout` builds WorkOS's hosted
  logout URL via the SDK (`GetLogoutURL`, sid from the access-token JWT).
- `cloudflare-workers/api-edge/src/index.ts` — capture the WorkOS `sid` at
  callback into the `oc_session` JWT (`wsid`), and return the hosted logout URL
  from edge `/auth/logout`.

## Required config (per WorkOS environment)

A **default Sign-out redirect** must be set in the WorkOS dashboard (Redirects):
staging `http://localhost:3000/` + the dev-edge URL; production
`https://app.opencomputer.dev/`. Without it WorkOS returns
`app-homepage-url-not-found`. We use WorkOS-managed redirects (no hard-coded
`return_to`).

## Outcome

Verified through the prod-mirror dev edge: unauthenticated → WorkOS; sign-out →
session ended → fresh WorkOS login (no auto-relogin, no error). Commits:
`3b596e6` (gate + Go logout), `b162475` (edge logout + review fixups).
