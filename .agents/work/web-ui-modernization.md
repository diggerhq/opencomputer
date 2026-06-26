# Web dashboard UI modernization

Bring the OpenComputer dashboard (`web/`) up to modern practice and the brand —
**a first high-quality, product-grade visual pass**, deliberately scoped. The
lean shape: **foundation + minimal component wrappers → migrate the live screens
visually → delete `theme.css` → final smoke.** Everything else (forms refactor,
table behavior, decomposition, core-lib upgrades, a component gallery) is an
explicit **follow-up**, pulled in only when a screen actually needs it.

Drivers: 633 inline styles, no components/forms/lint, and an off-brand look
("Void Glass" dark indigo) vs the site + docs (light ink-on-paper). Status:
**draft for review**, not started.

> Measured **2026-06-26** at `feat/web-ui-dev`. Counts:
> `grep -rao 'style={' web/src | wc -l` (633), `… 'className='` (141),
> `find web/src -name '*.tsx' -o -name '*.ts' | xargs wc -l` → **7,587** (TS/TSX;
> ~8,035 incl. `theme.css`). Versions: `cd web && npm outdated`. Re-run before
> trusting the numbers.

## Goal / non-goals

**Goal:** stop hand-writing styling/modals/dropdowns/icons; a real, enforced,
brand-aligned, accessible dashboard design system; a linter — for the **live**
screens, in one focused effort.

**Not this effort (follow-ups):** framework migration (stays a SPA); data-layer
rewrite (TanStack Query stays); forms refactor (RHF/zod); TanStack Table
behavior; decomposing oversized components; core-lib upgrades (React 19 / RR7 /
Vite 8 / TS 6 / Tailwind 4); a Storybook/Ladle gallery; the orphaned Agents
screens.

## Current state (assessment)

| Area | Today | Verdict |
|---|---|---|
| Build / lang | Vite 6.4, TS 5.6, React 18.3, RR 6.30 | fine for this pass (upgrades = follow-up) |
| **Data** | **TanStack Query 5.90** (used well) | **keep** |
| Charts / term | recharts 3.7 / `@xterm` 6 | keep |
| Styling | `theme.css` + **633 inline `style={{}}`** vs 141 `className` | replace |
| Components / forms / icons / lint | none / none / 26 inline svg / none | add |

**Two findings that shape scope (verified 2026-06-26):**
- **`Agents.tsx` (509) + `AgentDetail.tsx` (1,892) are orphaned** — not imported
  or routed in `App.tsx`. **Excluded from this effort and from all success
  metrics** until someone deletes or routes them (decision #1).
- **Terminal + logs are dark technical surfaces** (`Terminal.tsx:29`
  `background:'#0a0a0f'` + ANSI), not paper UI — a sanctioned exception.

## Brand + dashboard dialect

Source of truth: the site (`opencomputer-site-v1`, already `vite_react_shadcn_ts`)
+ Mintlify docs — both light, ink-on-paper. Site base tokens (shadcn HSL, from
`src/index.css`): `--background 40 33% 97%` (paper), `--foreground 45 8% 8%`
(ink), `--primary` ink, `--destructive 0 84% 60%`, `--border 0 0% 91%`,
`--radius 6px`. Replaces "Void Glass" (not additive).

**Dialect (a dense console, not a marketing page):**
- **Type: Inter (UI) + Geist Mono (ids/code/logs/terminal/metrics).** Newsreader
  is **deferred** — not worth the font/perceptual cost for dense UI now (maybe a
  sparse title later).
- **Dark technical surfaces** (terminal/log/code) stay dark even on the light
  shell — their own tokens.
- **Contrast is a gate.** The site's `--muted-foreground` (~#878787) is only
  **~3.3:1** on paper — fails AA. The dashboard needs its own darker text tokens.

**Product token layer** (extends the base; **contrast targets AA ≥4.5:1 body,
≥3:1 large/UI**, verified on the **pairs actually used** by migrated screens):
`--text` (primary), `--text-secondary` (≥4.5:1, ≈`hsl 0 0% 40%` — NOT site's
53%), `--text-tertiary` (large only), `--panel`/`--panel-2`, `--sidebar`,
`--row-hover`/`--row-selected`, `--focus-ring`, `--disabled`, and the dark
`--code/terminal` set.

**Status colors:** define **session lifecycle** (running / stopped / hibernated /
error / pending) + **destructive** now. Logs-by-source, chart series, billing,
and ANSI palettes are added **when those screens migrate**, not upfront. Every
status has a non-color cue (icon/label).

## Stack: mirror the site

The site already uses this exact stack and shares React 18 / RR6 / TanStack
Query 5 with the dashboard, so we mirror it for direct token + component reuse.

**Adopt now:** Tailwind 3.4 (+ animate, tailwind-merge, clsx → `cn()`),
shadcn/ui (Radix), lucide-react, sonner (toasts), ESLint 9 flat
(+ typescript-eslint, react-hooks, **jsx-a11y**) + Prettier
(+ **prettier-plugin-tailwindcss**), `@/*` alias.

**Later (don't add the deps until a screen earns them):** react-hook-form + zod,
TanStack Table, `@tanstack/eslint-plugin-query`, the Tailwind 4 / React 19 / RR7
/ Vite 8 / TS 6 upgrades.

**Keep:** TanStack Query, recharts, xterm, posthog, the SPA shape.

## Minimal component set (build only what the shell + pilot need)

Build now, on shadcn/Radix: `Button`, `Panel`, `PageHeader`, `StatusBadge`
(lifecycle), `ConfirmDialog` (destructive — replaces `confirm()`), `EmptyState`,
`ResourceTable` (**presentational** — sort affordance, empty/loading, an explicit
**Open** link per row, *not* a row-click div), `AppShell` (desktop sidebar +
mobile drawer + topbar), and a basic `<Toaster/>` (sonner).

**Build on demand (when a screen needs it):** `MetricCard`, `CodeSurface` +
`TerminalSurface` (when SessionDetail migrates), `OrgSwitcher`, richer toast
helpers, TanStack-Table behavior in `ResourceTable`.

## Decisions needed (review)

1. **Agents/AgentDetail** — orphaned. Delete, route, or leave? Until then,
   excluded from work + metrics. *Recommend: leave; decide delete-vs-revive later.*
2. **Default theme** — light (brand); dark deferred. *Recommend: light.*
3. **Formatter** — Prettier (site parity). *Recommend: yes.*

## Plan — two tracks

**Track A — Foundation (one PR):**
- [ ] ESLint 9 flat + Prettier (+ prettier-plugin-tailwindcss) + jsx-a11y; `@/*`
  alias; `lint`/`format` scripts.
- [ ] Tailwind 3.4 + base tokens + **product token layer** + dark-surface tokens
  + `cn()`. **CSS coexistence:** `theme.css` keeps owning unmigrated screens;
  **Tailwind preflight stays disabled** (`corePlugins.preflight:false`) so the
  global reset never reflows legacy screens; tokens on `:root`; utilities opt-in
  per screen. (No disable/re-enable dance — preflight stays off through the
  migration; revisit once only if needed after `theme.css` is gone.)
- [ ] shadcn init + core primitives + lucide + `<Toaster/>`.
- [ ] Build the **minimal component set** + `AppShell`.

**Track B — Visual migration (per-screen PRs, reskin only):**
- [ ] Pilot **`Sessions.tsx`** (table + filters + delete) — the reference pattern.
- [ ] Then the live screens: Layout/shell → Dashboard → Checkpoints → APIKeys →
  Templates → Settings → Billing → SessionDetail (builds Code/TerminalSurface).
  **Excludes** Agents/AgentDetail.
- [ ] **End of Track B:** delete `theme.css` + remove dead inline styles.

## Migration Contract (per screen)

- Keep existing API calls + behavior unless explicitly called out.
- Inline `style={}` only for data-driven geometry (chart dims, computed
  positions) or third-party bridges (xterm) — never for static styling.
- Cover the states **that screen actually has** — at minimum loading, empty,
  error, and destructive-confirm where relevant (see the matrix as a checklist).
- PR includes before/after **screenshots** (desktop; mobile only if the screen
  has meaningful mobile behavior).

## State coverage (guidance, not a blocking matrix)

Reference list — each PR fixtures **only the states its screen touches**:
sessions {empty, active, failed, deleting} · billing {ok, halted, past-due,
no-payment-method} · org {single, multiple} · API key {secret-shown-once} ·
custom domain {pending, failed, verified} · logs {streaming, disconnected} ·
terminal {connected, WS failure}. (Auth/first-run are shell-level, covered once.)

## Responsive (keep it simple)

- **Sidebar:** desktop sidebar; **drawer** below tablet. No icon-rail, no
  persisted state for v1.
- **Tables:** horizontal scroll + always-visible actions. **No sticky columns**
  and **no card/list fallback** in v1 (an ops table is fine scrolled); add only
  if a screen proves it needs them.
- **Terminal/log panels:** viewport-relative height (min/max), scroll within.
- **Touch targets:** ≥ 44×44px on coarse pointers.

## Interaction feel

- **Skeletons** for first-load layout; **spinners** only for in-place async
  (button-pending, refetch). No layout shift.
- **Toasts** (sonner) for errors + cross-page outcomes; **copy-to-clipboard uses
  inline "Copied"**, not a toast.
- **Destructive confirm:** `AlertDialog` naming the object + consequence ("Delete
  sandbox `x`? Stops it and removes preview URLs."). No typed-confirm until a
  genuinely irreversible action exists.
- **Button pending:** disable + spinner, keep width.
- **Motion:** 150–200ms ease-out; honor `prefers-reduced-motion`.

## Accessibility

- Keyboard-completable flows; visible focus ring; sane focus order.
- **Explicit `Open` links/buttons**, not row-click divs (cleaner than grid
  keyboard nav, which we don't build).
- Toasts/errors announced (aria-live).
- Charts: an accessible **text summary** is enough for the simple activity charts
  (full data-table alternative is a follow-up).
- Contrast verified on the **token pairs actually used** (incl. status colors +
  dark surfaces) — not all combinatorial pairs.
- First pass: **manual** keyboard + contrast checks + screenshots. Automate
  (axe / Playwright) **once the UI settles** — not a blocker for early PRs.

## Serving + testing

`web/` ships two ways — Go control plane (`web/dist` via `serveDashboardUI`) and
`api-edge` Worker assets. Smoke **both modes after Foundation and before
release** (not per screen): auth, logout (Go + edge), SSE logs, WS terminal, SPA
fallback, asset routing. Per-screen PRs run in one mode. (Exercise the edge via
`.agents/reference/dev-edge-setup.md`.) Manual logs/terminal checks are required
only for SessionDetail / LogsPanel / Terminal / shell CSS, and at release.

## Quality gate (per PR — lean)

`npm run build` · `npm run lint` · `tsc` · before/after screenshots · manual
keyboard + contrast pass for the screen's used token pairs. (Logs/terminal manual
check only when the PR touches them.)

## Success criteria

- Inline `style={}` ≈ 0 (except the contract's allowed cases); `theme.css` deleted.
- Brand + product tokens live; contrast met on **used** pairs.
- Overlays/menus/confirms via the component set; **no `confirm()`/`alert()`**.
- ESLint + Prettier + jsx-a11y green; both-serving-mode smoke green at release.
- Repo hygiene: no generated files tracked (`*.tsbuildinfo` done, `api-edge/assets/`).
- **Agents/AgentDetail excluded** from all metrics until deleted or routed.

## Follow-ups (separate efforts — explicitly out of this pass)

Forms (RHF + zod) · TanStack Table behavior · decomposing oversized live
components (Billing, SessionDetail) · `MetricCard`/`OrgSwitcher`/richer toasts ·
a `/design-system` gallery (or Ladle/Storybook) if wrapper drift becomes real ·
axe/Playwright automation · full semantic palette (logs/chart/billing/ANSI) ·
Newsreader for sparse titles · sticky table columns / mobile card fallback /
icon-rail · core-lib upgrades (React 19 + RR7, Vite 8 + plugin, TS 6, Tailwind 4).

## References

- Dashboard: `web/` — `src/styles/theme.css`, `src/api/client.ts`, `src/pages/*`,
  `src/components/{Layout,Terminal,LogsPanel}.tsx`, `src/App.tsx` (routes).
- Brand + stack source: `opencomputer-site-v1/` — `src/index.css`,
  `tailwind.config.ts`, `components.json`, `eslint.config.js`, `package.json`.
- Docs brand: `opencomputer/docs/docs.json`, `opencomputer/docs/styles/custom.css`.
- Serving: `internal/api/router.go` (`serveDashboardUI`),
  `cloudflare-workers/api-edge/wrangler.toml`; dev edge:
  `.agents/reference/dev-edge-setup.md`.
