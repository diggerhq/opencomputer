# Web dashboard — frontend architecture & conventions

How the dashboard (`web/`) is structured and the engineering bar to hold when
changing it. This is a reference, not a runbook: it captures the system-design
decisions and the non-obvious reasons behind them, so they don't get
re-litigated or quietly eroded. The dashboard is a React SPA served at the edge
(see `dev-edge-setup.md`). Scope here is code and architecture, not visual
design.

## Stack

React 19 · React Router 7 (declarative `<Routes>`) · Vite 8 · TypeScript 6 ·
Tailwind v4 · shadcn/ui (Radix) · TanStack Query 5 · zod 4 · ESLint 9
(type-aware).

**The toolchain version is API surface.** Vite 8 requires Node ≥20.19, so a bump
that raises the runtime floor is a breaking change for every contributor and for
CI, not an implementation detail. Pin it in three places that must agree:
`web/package.json` `engines.node`, `web/.nvmrc`, and the Node version in the
workflow that builds `web/dist` (`.github/workflows/deploy-server.yml`).
Dependency upgrades are deliberate and recorded (which lib, why, what it forces);
ESLint is held at 9 because `eslint-plugin-jsx-a11y` peers `^9`.

## The data boundary is the contract

`src/api/schemas.ts` holds zod schemas and is the **single source of truth** for
API shapes. Types are `z.infer`'d there and re-exported from `client.ts`, so
`import { type Session } from '@/api/client'` keeps working and the type can
never drift from the validator that produced it.

`apiFetch(path, opts, schema?)` parses every response it's given a schema for.
The posture is **dev-hard / prod-soft**: a mismatch throws in dev (catches
backend/schema drift early) and in prod logs it but passes the raw data through,
so a schema that lags the backend by one field can't take a screen down. Tighten
toward always-throw once the schemas are proven in prod.

A new endpoint means: add a schema, pass it to `apiFetch`, add a mock entry that
satisfies it. The dev-hard parse runs against the preview mock too, which **keeps
the mock honest** — it has already caught a mock missing a required field that
would otherwise have rendered the wrong branch. `res.json()` is `unknown` at the
boundary and narrowed deliberately (the `errorMessage` helper); no bare `any`
crosses `fetch`.

## Types and lint earn their keep

Type-aware ESLint is on (`recommendedTypeChecked` with `projectService`); config
files opt out (`disableTypeChecked` + `allowDefaultProject`). It is not
cosmetic — turning it on surfaced ~13 unhandled promises, several unsafe-`any`
JSON boundaries, and the RR7 change below. Fix the cause; don't sprinkle
disables. The classes of bug it pays back:

- **RR7 gotcha:** `navigate()` returns a `Promise`. In an event handler that's a
  misused-promise — `onClick={() => void navigate('/x')}`, not `() => navigate('/x')`.
- **Fire-and-forget query work is `void`-ed** explicitly
  (`void queryClient.invalidateQueries(...)`): documents intent and satisfies
  `no-floating-promises`.
- TS narrows through aliased boolean conditions (`const hasDomain = !!org?.x && …`
  narrows `org` inside `hasDomain ? …`), so non-null assertions in those branches
  are genuinely unnecessary and the lint says so. Trust it over `!`.

## Resilience

- **Error boundaries** wrap the app at the top level and per route. The route
  boundary is keyed `` `${orgId}:${pathname}` `` so a render throw clears when you
  navigate away **and** pages remount on org switch (see state ownership). A
  thrown render is contained to one route, never a white screen.
- **`notifyError(message, error)`** is the single error sink: a human-readable
  toast plus `console.error` with the raw error. Every `catch` / mutation
  `onError` goes through it. Users never see a raw error string; the console
  keeps the real one.

## State ownership

Server state lives in TanStack Query; component state stays local; there is no
third store. Auth is just `useQuery(['me'])` (`hooks/auth-provider.tsx`) rather
than a hand-rolled context with its own fetching.

- **Org switch** is `switchOrgApi(id)` → `queryClient.clear()` → `await refetch()`.
  `clear()` removes cached queries but does **not** refetch the active `['me']`
  observer, so without the explicit refetch the shell keeps showing the previous
  org. This is the kind of cache-semantics detail that has to be encoded, not
  assumed.
- **Local state must not bleed across orgs.** Clearing the server cache does not
  reset a component's own `useState` (a name draft, a filter, a half-filled
  form). The org-scoped route subtree is therefore keyed by active org id so it
  remounts on switch. Anything async and user-triggerable (the org switcher) is
  race-guarded (disabled + in-flight flag) so a double-fire can't interleave.

## Performance

- **Code-split by route.** Pages are `lazy()`; the heaviest deps (xterm, in
  `Terminal`/`LogsPanel`) load only when a sandbox is opened, under `Suspense`.
  This roughly halved initial JS (~1003kB → ~576kB; xterm's ~340kB is on-demand).
- **Prefetch on intent.** Hovering or focusing a sandbox row warms the route
  chunk and the detail query (`usePrefetchSandbox`), so the click feels instant.
  Idempotent by construction: the dynamic import dedupes and the query has a
  `staleTime`. Prefetch is an optimization, never a correctness dependency.

## Async and lifecycle hygiene

- **Everything started is cleaned up.** A `setTimeout` backing transient UI is
  held in a ref and cleared on unmount and on re-trigger; long-lived `WebSocket`
  / `EventSource` handlers check a `disposed` flag so a late `onclose` can't set
  state on or write to a torn-down component. `useTransientFlag` exists for the
  common set-flag-then-auto-reset case so the cleanup isn't re-derived each time.
- **Optimistic affordances confirm on success only.** Clipboard shows "Copied"
  after the write resolves; a rejection (permissions, insecure context) surfaces
  via `notifyError` rather than a false confirmation.
- **Live lists key by a stable id, never the array index.** Append + cap-trim +
  client-side filter make index keys reconcile incorrectly; streamed events get a
  client-assigned monotonic ingest seq used as the key.

## Working method

- **Preview harness.** `VITE_PREVIEW=1` serves `src/api/mock.ts` with no backend
  or auth, so the whole dashboard renders locally for fast iteration. The mock is
  schema-checked (dev-hard zod), so it can't silently drift from the real shapes.
- **Dead code is split out, not left inline.** When pages are removed, their API
  surface moves to a dormant module (e.g. `src/api/agents.ts`) rather than sitting
  in the active client, so `client.ts` reflects routed behavior. Removing a
  feature is intentional and noted, not a silent gap.
- **The gate before commit** is `typecheck` + `lint` + `format:check` + `build`,
  all green (`prettier --write` first). Scripts are in `web/package.json`.
