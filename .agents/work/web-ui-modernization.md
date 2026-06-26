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
rewrite (TanStack Query stays); **form behavior refactor (RHF/zod)** — a later
"form correctness" pass; TanStack Table behavior; decomposing oversized
components; **upgrade-only runtime work** (a
React/RR/Vite/TS bump with no driving reason — deferred to the end or skipped; a
new-lib requirement or bug *is* a reason); a Storybook/Ladle gallery; the
orphaned Agents screens. *(Adding new UI libs — Tailwind, shadcn, lucide, sonner
— at their latest is the point of this effort, not a non-goal.)*

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
  metrics.** Delete-vs-revive is a separate product decision (see Decisions) — it
  doesn't affect this pass.
- **Terminal + logs are dark technical surfaces** (`Terminal.tsx:29`
  `background:'#0a0a0f'` + ANSI), not paper UI — a sanctioned exception.

## Brand + dashboard dialect

Source of truth: the site (`opencomputer-site-v1`, already `vite_react_shadcn_ts`)
+ Mintlify docs — both light, ink-on-paper. Site base token *values* (HSL, from
the site's `src/index.css`; in our v4 setup these become CSS color vars under
`@theme inline` — see "Tailwind v4 + shadcn setup"): `--background 40 33% 97%` (paper), `--foreground 45 8% 8%`
(ink), `--primary` ink, `--destructive 0 84% 60%`, `--border 0 0% 91%`,
`--radius 6px`. Replaces "Void Glass" (not additive): the current dark tokens
(`--bg-void`, `--accent-indigo`, …) are **retired with `theme.css`, not
remapped** — dark survives only in the terminal/log/code surfaces.

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

## Stack

Chosen on its own merits: **Tailwind + shadcn/ui (Radix) + lucide** is the
current standard for an accessible, low-ownership React UI, and it pairs cleanly
with the TanStack Query data layer we keep. The marketing site happens to use the
same stack, so a few tokens/patterns can be borrowed — a convenience, **not the
rationale, and not a constraint** (we don't have to match the site's versions).

**Adopt now:** Tailwind (latest, v4) (+ tw-animate-css, tailwind-merge, clsx → `cn()`),
shadcn/ui (Radix), lucide-react, sonner (toasts), ESLint 9 flat
(+ typescript-eslint, react-hooks, **jsx-a11y**) + Prettier
(+ **prettier-plugin-tailwindcss**), `@/*` alias.

**Use the latest of the new libs** (Tailwind, shadcn, Radix, lucide, sonner). If
a new lib's latest *requires* a core-lib bump (a release that needs a newer Vite
or React), that bump is **in scope — the requirement is the reason.**

**Defer:**
- *New libs not yet earned* — react-hook-form + zod, TanStack Table,
  `@tanstack/eslint-plugin-query`. Add when a screen actually needs them. (Forms:
  this pass builds the **primitives** so RHF slots in later — see "Forms".)
- *Upgrade-only work* — bumping React / react-router / Vite / TS **just to be
  current**, with no driving reason, waits until the very end (or is skipped).
  Adding new UI libraries is the point; gratuitous runtime upgrades aren't. A
  real reason — a new-lib requirement, a bug, a needed feature — flips it back in
  scope. Whether the current Tailwind/shadcn/Radix run on our React 18 / Vite 6
  is **confirmed by the Phase A spike** (shadcn's v4 docs default to React 19 —
  verify, don't assume); if a bump is forced, that's an in-scope reason.

**Keep:** TanStack Query, recharts, xterm, posthog, the SPA shape.

Tailwind is **net-new** here (zero Tailwind today — just `theme.css` + inline
styles), so adopting it *is* the work. Use the **latest (v4)** and whatever its
setup needs.

## Tailwind v4 + shadcn setup (don't mix v3 patterns)

Follow the **current** shadcn "Vite" + Tailwind v4 docs — not v3 muscle memory.
An implementer can easily build a half-v3/half-v4 CSS system; the v4 specifics:

- Vite plugin **`@tailwindcss/vite`** (no PostCSS pipeline, no JS color config in
  a `tailwind.config.js theme.extend`).
- **CSS-first tokens:** declare design tokens as CSS color vars
  (`:root { --background: …; --foreground: … }`) and expose them with
  **`@theme inline`** — that's the brand + product token layer.
- Animations: **`tw-animate-css`** (shadcn's v4 choice), **not** `tailwindcss-animate`.
- `components.json` with `cssVariables: true`; the `@/*` alias (added in Phase A).
- **Imports / Preflight (coexistence):** the bundled `@import "tailwindcss";`
  *includes* Preflight — so **don't use it while `theme.css` is live.** Import the
  layers explicitly: `@import "tailwindcss/theme.css"` + `…/utilities.css`,
  **omitting** `…/preflight.css`. With Preflight off, Tailwind's `border-*`
  utilities render invisibly (no `border-style`), so add the **minimal base reset**
  shadcn assumes: `@layer base { *,::before,::after { box-sizing:border-box;
  border-width:0; border-style:solid; border-color:var(--border) } }`.
- **Final state (end of Phase B):** swap to the bundled `@import "tailwindcss";`
  (Preflight on) and drop the manual reset.

## Minimal component set (build only what the shell + pilot need)

Build now, on shadcn/Radix: `Button`, `Panel`, `PageHeader`, `StatusBadge`
(lifecycle), `ConfirmDialog` (destructive — replaces the **10 `confirm()`** calls
in live screens), `EmptyState`, `Input` + the plain-props form primitives
(`Field`/`Label`/`FieldError`/`FieldDescription`, RHF-agnostic — see Forms),
`ResourceTable` (**presentational** —
rows, empty/loading, actions, an explicit **Open** link per row, *not* a
row-click div; **no sort UI** until real sorting exists, which is deferred),
`DropdownMenu` (the org switcher is a hand-rolled abs-positioned dropdown today),
`Sheet` (the AppShell mobile drawer), `AppShell` (desktop sidebar + mobile drawer
+ topbar), `<Toaster/>` (sonner). `Dialog` lands with APIKeys (its "create" form
is a fake modal — see breakdown). Filter pills (Sessions) are a simple `Button`
group for v1 (`ToggleGroup` later).

**Build on demand (in the first commit that needs it):** `MetricCard`,
`CodeSurface` + `TerminalSurface` (when SessionDetail migrates), `OrgSwitcher`,
richer toast helpers, TanStack-Table behavior in `ResourceTable`. The
**screen-specific shadcn primitives** the breakdown calls for — `pagination`
(Checkpoints), `checkbox` (Checkpoints), `alert` (Checkpoints/Billing), etc. —
are likewise `shadcn add`-ed in the commit that first needs them, not upfront.

**Forms — defer behavior, build the seam now.** This is a visual pass: keep each
form's existing submit / validation / local-state semantics. **RHF + zod come
later**, in a dedicated "form correctness" pass (likely starting with Billing).
But build the form **primitives now with a plain-props, RHF-agnostic API** so that
later pass slots in without re-touching the visual system:

- `Field` (label + control + error/description), `Label`, `Input`, `Textarea`
  (if needed), `FieldError`, `FieldDescription` — driven by plain props. **Don't**
  use shadcn's RHF-bound `Form`/`FormField`.

```tsx
<Field label="Domain" error={domainError}>
  <Input value={domain} onChange={…} />
</Field>
```

Then the later pass wires RHF into these (or swaps to shadcn `Form`) without
changing markup. So inputs are built **once**; only their wiring changes later.

## Decisions (settled)

No open decisions — these are locked for this effort:

1. **Default theme = light** (the OpenComputer brand). Dark is deferred (shadcn
   `darkMode:class` is wired, so it's addable later).
2. **Formatter = Prettier** (+ prettier-plugin-tailwindcss).
3. **Agents/AgentDetail = out of scope.** They're orphaned (unrouted), so this
   pass does **not** touch them and they're excluded from all metrics. Whether to
   **delete or revive** them is a separate product decision tracked elsewhere — it
   does not block or affect this work, so it's not an open item here.

## Plan — one PR, two phases

It all lands in the **single open PR** (`feat/web-ui-dev`, #426), built up as
ordered commits — not split into multiple PRs.

**Phase A — Foundation:**
- [ ] **Spike first (de-risk the runtime).** Install Tailwind v4 + shadcn; run
  `shadcn init` with **deterministic choices** — npm; style **new-york** (current
  shadcn default; the site's old `default` is deprecated); base color **neutral**
  (our token layer overrides it); `cssVariables: true`; aliases `@/components`,
  `@/components/ui`, `@/lib/utils`, `@/hooks`. Then `shadcn add button dialog
  dropdown-menu sheet sonner` and **`build` + `typecheck`** — proving current
  shadcn/Tailwind v4 runs on our React 18 / Vite 6 *before* any screen work. (A
  forced runtime bump here is an in-scope reason per Stack.)
- [ ] ESLint 9 flat + Prettier (+ prettier-plugin-tailwindcss) + jsx-a11y; `@/*`
  alias; `lint`/`format`/`typecheck` (`tsc -b`) scripts.
- [ ] Token layer + CSS wiring per the **"Tailwind v4 + shadcn setup"** block:
  base + product tokens + dark-surface tokens via `@theme inline`; explicit layer
  imports with **Preflight off + the minimal border reset** while `theme.css` is
  live; tokens on `:root`; utilities opt-in per screen. **Decision (not a
  "revisit"):** at the end of Phase B, when `theme.css` is gone, swap to the
  bundled `@import "tailwindcss";` (Preflight back on) and drop the manual reset.
- [ ] Finish the **minimal component set**: `shadcn add input badge separator
  skeleton table`, then build `AppShell` + the OC wrappers; lucide + `<Toaster/>`.

**Phase B — Visual migration (one screen per commit, reskin only):**
- [ ] Pilot **`Sessions.tsx`** (table + filters + delete) — the reference pattern.
- [ ] Then the live screens, lightest-first (see the breakdown): Layout/shell →
  Templates → Checkpoints → APIKeys → Dashboard → Settings → SessionDetail
  (builds the dark Code/TerminalSurface) → **Billing last** (heaviest).
  **Excludes** Agents/AgentDetail.
- [ ] **End of Phase B:** delete `theme.css` + remove dead inline styles, and
  **enable Tailwind's preflight** (the permanent app reset) now that no legacy CSS remains.

## Foundation findings (from the code survey, 2026-06-26)

Concrete things Phase A must handle (verified against the code):
- **No `@/*` alias** — add to `tsconfig.json` (`paths`) + `vite.config.ts`
  (`resolve.alias`); shadcn needs it.
- **Fonts:** the `<link>` loaders live in **`web/index.html`** (Outfit / DM Sans /
  JetBrains Mono) — *not* `theme.css`. Phase A **edits `index.html`** to load
  **Inter + Geist Mono** and drop the old three; the `--font-*` tokens move into
  the new Tailwind theme.
- **Tokens are replaced, not remapped** — the dark `:root` set (`--bg-void`,
  `--accent-indigo`, …) goes; define the light brand + product tokens fresh.
- **Providers** (`main.tsx`): QueryClientProvider + PostHog + BrowserRouter;
  (`App.tsx`) AuthProvider → ProtectedRoute → Layout. `theme.css` is imported in
  `main.tsx`; `<Toaster/>` slots in there.
- **`theme.css` also carries** global resets, a `body::before` dot-grid texture
  (drop it — off-brand), scrollbar styling, and **recharts element-selector
  overrides** (`.recharts-*`) — re-home the recharts bits when `theme.css` is
  deleted (end of Phase B).
- **z-index:** today maxes at ~50 (sidebar), no overlay strategy — define a scale
  (dropdown < sticky < modal < toast < tooltip) before adding Radix overlays.
- **Replacement-target classes** (coupling counts): `.btn-*` (35+), `.glass-card`
  (30), `.data-table` (6), plus `.badge-*`, `.filter-btn`, `.input`,
  `.loading-spinner`, `.page-title`/`.section-title`, `.animate-in`/`.stagger`,
  `.stat-card`, `.metric-value` → OC wrappers / Tailwind utilities.
- **Preflight stays off** during coexistence — confirmed `theme.css` sets global
  `*`/body resets Tailwind preflight would fight.

## Per-screen breakdown (from the survey)

`style={}` counts are per-file (systematic grep) and drive sequencing. Live
screens only — **Agents (44) + AgentDetail (159) are orphaned and excluded.**

| Screen | `style=` | Hand-rolled → target | States to cover | Specific risk / finding |
|---|---|---|---|---|
| **Sessions** (pilot) | 30 | `.data-table`→`ResourceTable`; filter pills→simple `Button` group (ToggleGroup later); `confirm()`→`ConfirmDialog`; `StatusBadge`; hover-mutate row→CSS | loading, empty, delete-error, deleting | **ActivityChart = hand-built positioned divs (not recharts). Decision: keep its data-driven inline geometry for v1** (the contract's allowed exception); recharts rebuild is a follow-up |
| **Layout/shell** | 24 | sidebar/nav; **org switcher (manual abs dropdown)→`DropdownMenu`**; logout; HaltBanner | (shell) | no responsive today → desktop sidebar + mobile drawer; HaltBanner polls autumn 30s (keep); swap brand fonts/logo |
| **Templates** | ~8 | `.data-table`→`ResourceTable`; `StatusBadge`; `confirm()` | loading, empty | lowest complexity — good 2nd after the pilot |
| **Checkpoints** | 27 | `.data-table`→`ResourceTable`; manual pagination→`Pagination`; checkbox filter→`Checkbox`; RGBA badges→`StatusBadge`; error box→`Alert`; `confirm()` | loading, empty, failed-error, deleting, paged | manual pagination + per-type RGBA badge math |
| **APIKeys** | 15 | **fake-modal create→real `Dialog`**; `.input`→`Input`; 3 svg→lucide; copy; `confirm()` | loading, empty, **key-shown-once**, copied | the "modal" is a `.glass-card` (no backdrop/focus-trap) — a real defect to fix; inline "Copied", not a toast |
| **Dashboard** | 50 | `.data-table`→`ResourceTable`; stat cards→`MetricCard`; copy/reveal | first-run onboarding, loading, empty, create-error | **first-run flow + auto-create-API-key-on-mount (useRef guard)** must be preserved |
| **Settings** | 72 | `.input`→`Input`; **2×`confirm()`→`AlertDialog`**; domain branching; status badge | loading, empty(members), domain {pending/failed/verified}, saved | forms are trivial single inputs → **`Field`/`Input` primitives, behavior unchanged** (no RHF this pass); `hasDomain`/`!hasDomain` branching; team + invitations lists |
| **SessionDetail** | 49 | header/actions; 9 svg→lucide; **3×`confirm()`→`AlertDialog`**; `StatCard`→`MetricCard`; preview-URL copy; **builds `Code`/`TerminalSurface`** | loading, not-found, reboot/power-cycle/delete (pending+error), live stats | embeds Terminal (WS) + LogsPanel (SSE); stats poll 5s |
| **Billing** (last) | 112 | **`ConfirmModal`→`Dialog` (non-dismissible while pending)**; invoices `.data-table`→`ResourceTable`; usage grid; 3 forms; 3 svg→lucide | loading, empty, error, halted/past-due, free-trial-exhausted, promo-applied, no-payment-method | **biggest.** Stripe `window.location.href` redirects **stay untouched**; Stripe-vs-Autumn branching; **3 forms (promo/top-up/auto-topup)** reskinned with the `Field`/`Input` primitives, **keeping current local-state behavior** (RHF+zod = the later form pass) |
| **Terminal** (dark) | 15 | reskin chrome only; status→tokens | connected / connecting / disconnected / error | **preserve:** xterm ANSI theme + `#0a0a0f` bg + **binary WS** + resize. Inline sizing is the *allowed* third-party-bridge exception; `@xterm/xterm/css/xterm.css` coexists |
| **LogsPanel** (dark) | 20 | source chips, search, status dot→tokens | streaming, empty, error, disconnected, paused | **preserve:** dark `--bg-deep`, SSE lifecycle, **auto-scroll/sticky-bottom**, `color-mix` chips, mono font. Reskin chrome only — complex internals |

## Migration Contract (per screen)

- Keep existing API calls + behavior unless explicitly called out.
- Inline `style={}` only for data-driven geometry (chart dims, computed
  positions) or third-party bridges (xterm) — never for static styling.
- Cover the states **that screen actually has** — at minimum loading, empty,
  error, and destructive-confirm where relevant (see the matrix as a checklist).
- Each screen's **commit** includes before/after **screenshots** (desktop;
  mobile only if the screen has meaningful mobile behavior).

## State coverage (guidance, not a blocking matrix)

Reference list — each screen covers **only the states it actually has**:
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
  (axe / Playwright) **once the UI settles** — not a blocker for early commits.

## Serving + testing

`web/` ships two ways — Go control plane (`web/dist` via `serveDashboardUI`) and
`api-edge` Worker assets. Smoke **both modes after Foundation and before
release** (not per screen): auth, logout (Go + edge), SSE logs, WS terminal, SPA
fallback, asset routing. Per-screen commits run in one mode. (Exercise the edge via
`.agents/reference/dev-edge-setup.md`.) Manual logs/terminal checks are required
only for SessionDetail / LogsPanel / Terminal / shell CSS, and at release.

## Quality gate (per screen / commit — lean)

`npm run build` · `npm run lint` · `npm run typecheck` (`tsc -b`) · before/after screenshots · manual
keyboard + contrast pass for the screen's used token pairs. (Logs/terminal manual
check only when the commit touches them.)

## Success criteria

- Inline `style={}` ≈ 0 (except the contract's allowed cases); `theme.css` deleted.
- Brand + product tokens live; contrast met on **used** pairs.
- Overlays/menus/confirms via the component set; **no `confirm()`/`alert()` in
  live routed screens** (orphaned Agents/AgentDetail are excluded).
- ESLint + Prettier + jsx-a11y green; both-serving-mode smoke green at release.
- Repo hygiene: no generated files tracked (`*.tsbuildinfo` done, `api-edge/assets/`).
- **Agents/AgentDetail excluded** from all metrics until deleted or routed.

## Follow-ups (separate efforts — explicitly out of this pass)

**Form behavior pass (RHF + zod)** · TanStack Table behavior · decomposing
oversized live components (Billing, SessionDetail) ·
`MetricCard`/`OrgSwitcher`/richer toasts ·
a `/design-system` gallery (or Ladle/Storybook) if wrapper drift becomes real ·
axe/Playwright automation · full semantic palette (logs/chart/billing/ANSI) ·
Newsreader for sparse titles · sticky table columns / mobile card fallback /
icon-rail · **upgrade-only** runtime bumps if nothing forces them sooner
(React 19 + RR7, Vite 8 + plugin, TS 6).

## References

- Dashboard: `web/` — `src/styles/theme.css`, `src/api/client.ts`, `src/pages/*`,
  `src/components/{Layout,Terminal,LogsPanel}.tsx`, `src/App.tsx` (routes).
- Brand + stack source: `opencomputer-site-v1/` — `src/index.css`,
  `tailwind.config.ts`, `components.json`, `eslint.config.js`, `package.json`.
- Docs brand: `opencomputer/docs/docs.json`, `opencomputer/docs/styles/custom.css`.
- Serving: `internal/api/router.go` (`serveDashboardUI`),
  `cloudflare-workers/api-edge/wrangler.toml`; dev edge:
  `.agents/reference/dev-edge-setup.md`.
