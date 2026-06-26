# Web dashboard UI modernization

Bring the OpenComputer dashboard (`web/`) up to modern frontend practice and the
OpenComputer brand — **as a product-grade operational console**, not a marketing
reskin. Three drivers: we hand-own far too much UI code (633 inline styles, no
components/forms/lint), there's no enforced design system, and the look ("Void
Glass" dark indigo) is off-brand vs the site + docs (light ink-on-paper).

The approach: adopt the stack the site already uses (Tailwind + shadcn/ui +
lucide + react-hook-form/zod + ESLint flat), build a **dashboard design system**
on top of it (product tokens + semantic statuses + OC component wrappers), and
do core library version bumps **last**. Status: **draft for review**, not started.

> Measured **2026-06-26** at `feat/web-ui-dev` (`git rev-parse --short HEAD`).
> Counts: `grep -rao 'style={' web/src | wc -l` (633), `… 'className='` (141),
> `find web/src -name '*.tsx' -o -name '*.ts' | xargs wc -l` → **7,587** (TS/TSX;
> ~8,035 if you also count `theme.css`).
> Versions: `cd web && npm outdated`. Re-run these before trusting the tables —
> they stale fast.

## Goal / non-goals

**Goals**
- Stop hand-writing styling, modals, dropdowns, forms, icons.
- A real, enforced **dashboard** design system (brand-aligned, product-dense,
  accessible) — not raw shadcn + marketing tokens pasted per screen.
- A linter/formatter so a multi-person codebase stays consistent.

**Non-goals (this effort)**
- No framework migration. Client-rendered SPA behind the `api-edge` Worker /
  Go `serveDashboardUI` is the right shape — **not** Next/Remix.
- No data-layer rewrite. TanStack Query stays.
- Not a product/IA redesign. Screens keep their information + behavior; we
  restyle and harden states.

## Current state (assessment)

| Area | Today | Verdict |
|---|---|---|
| Build / lang | Vite 6.4, TS 5.6, React 18.3, react-router 6.30 | all 1–2 majors behind (Vite 8/TS 6/React 19/RR7) |
| **Data** | **TanStack Query 5.90** (48 `useQuery`, 28 `useMutation`, optimistic) | **keep — modern** |
| Charts / term | recharts 3.7 / `@xterm` 6 | current |
| Styling | `theme.css` (448 LOC) + **633 inline `style={{}}`** vs 141 `className` | replace |
| Components | none — modals/dropdowns/tables hand-rolled | replace |
| Forms | none — 90 `useState` | replace |
| Icons | none — 26 inline `<svg>` | replace |
| Lint/format | **none** | add |
| Big files | `AgentDetail.tsx` 1,892 · Billing 787 · SessionDetail 558 | decompose (see scope) |

**Two findings that change scope (verified 2026-06-26):**
- **`Agents.tsx` (509) + `AgentDetail.tsx` (1,892) are orphaned** — not imported
  or routed in `App.tsx`; only `client.ts` has the API calls. They're
  unreachable. Do **not** migrate them until their status is decided (below).
- **Terminal + logs are dark technical surfaces**, not paper UI
  (`Terminal.tsx:29` `background:'#0a0a0f'` + ANSI palette; `LogsPanel.tsx`).
  The brand is light, but these stay dark — an explicit exception (below).

## Target brand + the dashboard dialect

Brand source of truth: the marketing site (`opencomputer-site-v1`, a
`vite_react_shadcn_ts` project) + the Mintlify docs. Both are **light,
ink-on-paper, editorial**.

**Site base tokens** (from `opencomputer-site-v1/src/index.css`, shadcn HSL):
`--background 40 33% 97%` (paper ~#f8f6f1), `--foreground 45 8% 8%` (ink ~#131311),
`--primary 45 8% 8%`, `--muted/secondary/accent 0 0% 98%`,
`--muted-foreground 0 0% 53%`, `--destructive 0 84% 60%`, `--border 0 0% 91%`,
`--radius 0.375rem` (6px). Type: **Newsreader** (serif headings) / **Inter**
(body) / **Geist Mono** (signature). This replaces "Void Glass" (deep-black,
indigo glass, Outfit/DM Sans, 20px radii) — it is a replacement, not additive.

### Dashboard Brand Dialect (NEW — the doc's core correction)

The site is a sparse marketing page; the dashboard is a dense operational
console. **Do not copy site tokens verbatim.** Adopt this dialect:

- **Light paper/ink shell, product-first density.** Tighter spacing/type scale
  than the marketing site.
- **Type usage:** Inter for nearly all UI; **Newsreader only** for page titles /
  sparse section headings (not table cells, labels, or dense text). Geist Mono
  for ids, code, logs, terminal, metrics.
- **Dark technical surfaces are a sanctioned exception.** Terminal, log viewer,
  and code blocks stay dark (their own token set), even on the light shell.
- **Contrast is a gate, not a vibe.** The site's `--muted-foreground` (≈#878787)
  is only **~3.3:1** on paper — fails WCAG AA (4.5:1) for body/table text. The
  dashboard needs its own, darker text tokens (below).

### Product token layer (NEW — extends, not replaces, the base)

shadcn base tokens are too blunt for product UI. Add a dashboard layer with
**explicit contrast targets** (AA: ≥4.5:1 body, ≥3:1 large/UI/icons), verified
on every pair before merge:

| Token | Purpose | Target |
|---|---|---|
| `--text` (=foreground) | primary text | ≥12:1 |
| `--text-secondary` | labels, table body, metadata | **≥4.5:1** (≈`hsl 0 0% 40%`, NOT site's 53%) |
| `--text-tertiary` | de-emphasized, large only | ≥3:1 |
| `--panel`, `--panel-2` | card / nested surfaces on paper | borders, not just shadow |
| `--sidebar`, `--sidebar-active` | nav | — |
| `--row-hover`, `--row-selected` | table interaction | visible non-color cue too |
| `--focus-ring` | keyboard focus | ≥3:1 vs adjacent |
| `--disabled` / `--disabled-text` | disabled controls | — |
| `--code-bg/-fg`, `--terminal-bg/-fg` | dark technical surfaces | AA on dark |

### Semantic status palette (NEW — "monochrome + maybe green" is insufficient)

The console renders many states; define a restrained but real palette (each with
AA text-on-surface + a non-color cue: icon/label/shape):

- **Session lifecycle:** running, stopped, hibernated, error, starting/pending.
- **Connection (live):** connected / connecting / disconnected (terminal, SSE).
- **Billing:** ok / warning / past-due.
- **Logs by source** + **chart series:** a small ordered categorical ramp that
  reads on both paper and the dark log/terminal surfaces.
- **Terminal ANSI:** keep a real 16-color ANSI set (don't flatten to brand).

## Stack: mirror the site (but know it's not "latest")

The site already uses the exact stack and shares React 18 / RR6 / TanStack
Query 5 with the dashboard, so we mirror it for direct token + component reuse
and brand parity.

| Concern | Adopt (site parity) | Latest (deferred to Phase D) |
|---|---|---|
| CSS | **Tailwind 3.4** + animate + tailwind-merge + clsx (`cn()`) | Tailwind 4 |
| Components | **shadcn/ui** (Radix) | — |
| Icons | **lucide-react** | — |
| Forms | **react-hook-form + zod** | — |
| Toasts | **sonner** | — |
| Lint/format | **ESLint 9 flat** + typescript-eslint + react-hooks + **jsx-a11y**; **Prettier** | Biome (maybe) |
| Build/runtime | (stay on current Vite 6 for migration) | Vite 8, React 19, RR7, TS 6, plugin-react-swc |

**Explicit:** "mirror the site" ≠ "latest npm." The site is Tailwind 3 / Vite 5
era; latest is Tailwind 4 / Vite 8. We take site-parity now (reuse + brand),
and treat the latest-stack bump as a separate, last phase.

**Keep:** TanStack Query, recharts, xterm, posthog, the SPA shape.

## Component inventory (NEW — define the product system)

shadcn gives primitives; without named wrappers each agent will compose them
differently. Define and build these OC dashboard components (on shadcn/Radix):

`AppShell` (sidebar + topbar + org switcher), `PageHeader` (title/subtitle/
actions), `TableShell`/`ResourceTable` (**presentational** — sort affordance,
empty/loading/row-click; TanStack Table *behavior* is added in Track C, not
here), `StatusBadge` (session lifecycle variants), `ConnectionState` (live dot),
`EmptyState`, `DangerAction` (confirm dialog + destructive styling),
`MetricCard`, `CodeSurface` + `TerminalSurface` (the dark exception),
`OrgSwitcher`, toast helpers. Screens compose these, not raw Radix.

**Gallery (build it alongside the inventory):** a dev-only `/design-system` route
(or Ladle/Storybook) that renders every component across its states + the State
Fixture Matrix, captured by Playwright screenshots. Wrappers built in the
abstract drift — the gallery is where the system is reviewed and regression-tested.

## Decisions needed (review)

1. **Agents/AgentDetail** — orphaned (unrouted). Dead code to delete, hidden
   WIP to route, or future work to leave alone? **Blocks** any work on them.
   *Recommend: leave un-migrated; decide delete-vs-revive separately.*
2. **Default theme** — light (brand). Dark deferred (shadcn `darkMode:class`
   wired). *Recommend: light; dark later.*
3. **Status palette scope** — adopt the semantic palette above vs minimal.
   *Recommend: the restrained semantic palette (states are real).*
4. **Formatter** — Prettier (site parity) vs Biome. *Recommend: Prettier now.*
5. **shadcn ownership** — copies components into the repo (own but don't
   maintain). Site already accepts this. *Recommend: shadcn.*

## Plan — three tracks, separate PRs (NEW — reskin ≠ refactor)

The old plan conflated visual reskin with behavior/architecture changes. Split:

**Track A — Foundation (one PR, no visual change to unmigrated screens):**
- [ ] ESLint 9 flat + Prettier (+ **prettier-plugin-tailwindcss** for class order)
  + `jsx-a11y` + **@tanstack/eslint-plugin-query**; `@/*` alias; `lint`/`format` scripts.
- [ ] Tailwind 3.4 + base tokens + **product token layer** + **dialect** (fonts,
  dark surfaces) + `cn()`. **CSS coexistence (load-bearing — get this right):**
  `theme.css` keeps owning unmigrated screens; **disable Tailwind preflight**
  (`corePlugins.preflight:false`) during coexistence so the global reset doesn't
  reflow legacy screens; tokens live on `:root`; Tailwind utilities are **opt-in
  per screen**. Preflight is re-enabled only when `theme.css` is deleted (end of B).
- [ ] shadcn init + core primitives + lucide + `<Toaster/>`.
- [ ] Build the **component inventory** + the `/design-system` gallery.

**Track B — Visual migration (per-screen PRs, reskin only):**
- [ ] Pilot **`Sessions.tsx`** (table + filters + delete) as the reference.
- [ ] Then: Layout/shell → Dashboard → Checkpoints → APIKeys → Templates →
  Settings → Billing → SessionDetail (incl. **dark** logs/terminal surfaces).
- [ ] Each screen follows the **Migration Contract** (below). **Excludes**
  Agents/AgentDetail (gated on decision #1).
- [ ] **End of Track B:** delete `theme.css`, remove dead inline styles, and
  re-enable Tailwind preflight — done here, *before* the Track D upgrades.

**Track C — Behavior refactors (separate PRs, NOT "reskin"):**
- [ ] Forms → react-hook-form + zod (Settings/Billing/APIKeys).
- [ ] Tables → TanStack Table behavior (sort/filter/paginate).
- [ ] Decompose oversized components **only where they're live** (Billing,
  SessionDetail; AgentDetail only if revived).

**Track D — Last: core lib upgrades (separate PRs):** React 19 + RR7 together;
Vite 8 + plugin-react(-swc); TS 6; Tailwind 4 evaluation. (`theme.css` is already
gone — deleted at the end of Track B.)

## Migration Contract (NEW — per screen)

- Keep existing API calls + behavior **unless explicitly called out** in the PR.
- Inline `style={}` allowed **only** for data-driven geometry (chart dims,
  computed positions) or third-party bridges (xterm) — never for static styling.
- Every migrated screen must implement **loading, empty, error, disabled,
  destructive-confirm, and mobile/tablet** states.
- Per-screen PR includes before/after **screenshots** (desktop + mobile) and the
  Quality Gate results.

## Responsive behavior (NEW — "mobile/tablet states" made concrete)

- **Sidebar:** icon-rail < `lg`, drawer (vaul/Sheet) < `md`; remembers state.
- **Tables:** horizontal scroll with a **sticky first column + sticky action
  column**; never squash actions; card/list fallback < `sm` for the busiest
  tables (Sessions).
- **Terminal / log panels:** viewport-relative height with min/max, collapsible,
  scroll *within* the panel (not the page).
- **Actions:** overflow to a `…` menu when they don't fit; the primary stays visible.
- **Touch targets:** ≥ 44×44px on coarse pointers.

## State fixture matrix (NEW — test real states, not happy paths)

Each surface is built + screenshotted against its real states; these double as
the `/design-system` gallery fixtures and the Playwright cases:
first-run · loading-auth · unauth-redirect · sessions {empty, active, failed,
deleting} · billing {ok, halted, past-due, no-payment-method} · org {single,
multiple → switcher} · API key {created, secret-shown-once} · custom domain
{pending, failed, verified} · logs {streaming, disconnected (SSE drop)} ·
terminal {connected, WS failure, reconnecting}.

## Interaction feel (NEW — designed, not just themed)

- **Skeletons** for first-load layout; **spinners** only for in-place async
  (button-pending, refetch). No layout shift on load.
- **Toast taxonomy** (sonner, one place): success (auto-dismiss), error
  (sticky + action), info. No `alert()`.
- **Copy-to-clipboard:** inline check + "Copied" toast (ids, keys, URLs).
- **Destructive confirm copy:** name the object + the consequence ("Delete
  sandbox `x`? Stops it and removes preview URLs."); typed-confirm for the
  scariest.
- **Button pending:** disable + spinner, keep width (no reflow).
- **Motion:** 150–200ms ease-out for state transitions; honor
  `prefers-reduced-motion` (instant/crossfade fallback).

## Accessibility plan (NEW — "Radix + jsx-a11y" is not enough)

Explicit gates, checked per screen:
- Keyboard-only completion of every flow; sane **focus order**; visible focus ring.
- **DataTable** keyboard nav + row-click has a real button/link affordance (not a
  bare `onClick` div).
- **Terminal** focus management; **toasts/errors** announced (aria-live).
- **Charts** have text/table alternatives (recharts isn't accessible by default).
- **Contrast** verified on *all* token pairs (incl. status colors, dark surfaces).
- **Responsive overflow**: dense tables/cards don't break < tablet.
- Tooling: `eslint-plugin-jsx-a11y` + **axe** in a Playwright smoke pass.

## Serving + testing (NEW — two deploy paths)

`web/` ships **two ways**: bundled by the Go control plane (`web/dist` via
`serveDashboardUI`) **and** as `api-edge` Worker assets. Modernization must smoke
**both** modes:
- auth (login → WorkOS → callback), **logout** (Go + edge hosted-logout),
- **SSE logs** (`/sessions/:id` logs), **WebSocket terminal**,
- SPA fallback for client routes, static asset routing/caching.
(The prod-mirror dev edge — `.agents/reference/dev-edge-setup.md` — is where to
exercise the edge path.)

## Quality Gate (NEW — must pass per PR)

`npm run build` · `npm run lint` · `tsc` typecheck · Playwright smoke
(desktop + mobile) · keyboard-navigation pass · contrast pass · manual check of
`/sessions/:id` **logs (SSE)** + **terminal (WS)**.

## Success criteria

- Inline `style={}` ≈ 0 (except the contract's allowed cases); `theme.css` deleted.
- Brand tokens + product layer live; **every token pair meets its contrast target**.
- All overlays/menus/tables/toasts via the OC component inventory; no
  `confirm()`/`alert()`.
- Forms on RHF + zod; lists on TanStack Table.
- ESLint + Prettier + jsx-a11y + axe smoke green in CI, in **both** serving modes.
- Repo hygiene: no generated files tracked — `*.tsbuildinfo` (done) +
  `api-edge/assets/` are gitignored.
- Core libs current after Track D.

## References

- Dashboard: `web/` — `src/styles/theme.css`, `src/api/client.ts`, `src/pages/*`,
  `src/components/{Layout,Terminal,LogsPanel}.tsx`, `src/App.tsx` (routes).
- Brand + stack source: `opencomputer-site-v1/` — `src/index.css`,
  `tailwind.config.ts`, `components.json`, `eslint.config.js`, `package.json`.
- Docs brand: `opencomputer/docs/docs.json`, `opencomputer/docs/styles/custom.css`.
- Serving: `internal/api/router.go` (`serveDashboardUI`),
  `cloudflare-workers/api-edge/wrangler.toml`; dev edge:
  `.agents/reference/dev-edge-setup.md`.
