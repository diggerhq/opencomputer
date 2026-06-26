# Web dashboard UI modernization

Bring the OpenComputer dashboard (`web/`) in line with modern frontend
practice and the OpenComputer brand. Three things drive this: we own far
too much hand-rolled UI code, we have no styling/component/forms/lint
foundation, and the dashboard's look ("Void Glass" dark indigo) is off-brand
versus the marketing site and docs (light ink-on-paper, serif headings).

The plan: adopt the **same stack the site already uses** (Tailwind + shadcn/ui
+ lucide + react-hook-form/zod + ESLint flat), reskin to the brand tokens, and
do the core library version bumps **last** — only after the styling/components/
forms/lint foundation is in. Status: **draft for review**, not yet started.

## Goal / non-goals

**Goals**
- Stop hand-writing styling, modals, dropdowns, forms, icons.
- A real, enforced design system that matches the OC site + docs brand.
- A linter/formatter so a multi-person codebase stays consistent.
- Reduce owned code and align with current best practice.

**Non-goals (for this effort)**
- No framework migration. This is a client-rendered dashboard served as static
  assets behind the `api-edge` Worker (see `internal/api/router.go`
  `serveDashboardUI` and `cloudflare-workers/api-edge`). A SPA is the right
  shape — we are **not** moving to Next/Remix.
- No rewrite of the data layer. TanStack Query is already used well and stays.
- Not a product/IA redesign. First pass is a 1:1 reskin of existing screens;
  layout/UX redesigns are a separate effort.

## Current state (assessment)

Measured from `web/src` (~8,035 LOC across 19 files):

| Area | Today | Verdict |
|---|---|---|
| Build | Vite 6.4 + `@vitejs/plugin-react` 4.7 | OK; 2 majors behind (Vite 8) |
| Language | TypeScript 5.6 | 1 major behind (TS 6) |
| UI runtime | React 18.3 | 1 major behind (React 19) |
| Routing | react-router-dom 6.30 | 1 major behind (RR7) |
| **Data fetching** | **TanStack Query 5.90** (48 `useQuery`, 28 `useMutation`, optimistic updates) | **Keep — modern, idiomatic** |
| Charts | recharts 3.7 | Current major |
| Terminal | `@xterm` 6 | Current |
| Styling | hand-rolled `theme.css` (448 LOC) + **633 inline `style={{}}`** vs 141 `className` | Replace |
| Components | **none** — modals/dropdowns/tables/badges all hand-rolled (`position:fixed` overlays in Billing/Agents/Layout) | Replace |
| Forms | **none** — 90 `useState`, hand-rolled validation | Replace |
| Icons | **none** — 26 inline `<svg>` | Replace |
| Lint/format | **none** — no ESLint/Prettier/Biome | Add |
| Destructive UX | native `confirm()`/`alert()` + inline error `<div>`s | Replace w/ dialog + toast |
| Big components | `AgentDetail.tsx` **1,892 LOC**, Billing 787, SessionDetail 558 | Decompose (falls out of primitives) |

The root cause of most of this is the **inline-style-everything** pattern: there
are CSS-variable tokens in `theme.css`, but they're consumed inline
(`style={{ background: 'var(--bg-card)' }}`) rather than through classes or
components — so there's no reuse, no `:hover`/`:focus`/responsive, and constant
drift.

## Target: the OpenComputer brand

The brand source of truth is the marketing site
(`opencomputer-site-v1`, a `vite_react_shadcn_ts` project) and the Mintlify docs
(`opencomputer/docs`). Both are **light, editorial, ink-on-paper**, the inverse
of the dashboard's dark glassmorphism.

**Brand tokens** (verbatim from `opencomputer-site-v1/src/index.css`,
shadcn HSL convention):

| Token | Value (HSL) | Meaning |
|---|---|---|
| `--background` | `40 33% 97%` | paper (~`#f8f6f1`) |
| `--foreground` | `45 8% 8%` | ink (~`#131311`) |
| `--card` / `--popover` | `40 33% 97%` | paper |
| `--primary` | `45 8% 8%` | ink |
| `--primary-foreground` | `40 33% 97%` | paper |
| `--muted` / `--secondary` / `--accent` | `0 0% 98%` | near-white surface |
| `--muted-foreground` | `0 0% 53%` | mid gray |
| `--destructive` | `0 84.2% 60.2%` | red |
| `--border` / `--input` | `0 0% 91%` | hairline gray |
| `--ring` | `45 8% 8%` | ink focus ring |
| `--radius` | `0.375rem` | **6px brand radius** |

**Type** (from `docs/docs.json` + site `index.css` + `docs/styles/custom.css`):
- Headings: **Newsreader** (serif, 600) — `.font-heading`
- Body / UI: **Inter** (400)
- Mono (signature texture): **Geist Mono** — `.font-mono-brand`
- Wordmark: `opencomputer` in Geist Mono, 500, lowercase, `-0.025em`
- `::selection`: inverted ink-on-paper

This is a hard departure from `theme.css`'s "Void Glass" (deep-black surfaces,
indigo `#818cf8`/violet glassmorphism, Outfit/DM Sans/JetBrains Mono, radii up
to 20px). The reskin **replaces** that theme; it is not additive.

### Void Glass → brand mapping (for the migration)

| Void Glass (`theme.css`) | Brand replacement |
|---|---|
| `--bg-void #08080c` / `--bg-card` glass | `--background` paper / `--card` |
| `--text-primary #ededf0` | `--foreground` ink |
| `--text-secondary/tertiary` grays | `--muted-foreground` |
| `--accent-indigo #818cf8` (primary accent) | `--primary` ink (monochrome) + optional functional green |
| `--gradient-primary`, `--shadow-glow`, dot-grid `body::before` | dropped (off-brand) |
| `--radius-xl 20px` | `--radius` 6px (and `-2/-4px` steps) |
| Outfit / DM Sans / JetBrains Mono | Newsreader / Inter / Geist Mono |

## Stack decision: mirror the site

The site (`opencomputer-site-v1`) **already** uses the exact stack we'd choose,
and already shares React 18 / react-router 6 / TanStack Query 5 with the
dashboard. So we mirror it — same tooling, same tokens, reuse component patterns,
automatic brand consistency:

| Concern | Adopt | Why |
|---|---|---|
| Styling | **Tailwind CSS 3.4** + `tailwindcss-animate` + `tailwind-merge` + `clsx` (`cn()` util) | Site is on 3.4; lets us copy its `tailwind.config.ts` + `index.css` tokens and shadcn components verbatim. (Tailwind v4 deferred — don't diverge from the site.) |
| Components | **shadcn/ui** (Radix primitives, `components.json` style "default") | Site uses it; accessible Dialog/Dropdown/Select/Tabs/Tooltip/Table/Toast; brandable via tokens |
| Icons | **lucide-react** | Site uses it; tree-shakeable; pairs with shadcn |
| Forms | **react-hook-form + zod** | Site uses it; kills the 90-`useState` sprawl; zod can also validate API responses |
| Toasts | **sonner** | Site uses it; replaces `alert()`/inline errors |
| Lint | **ESLint 9 flat** + `typescript-eslint` + `eslint-plugin-react-hooks` + `react-refresh` (+ add `jsx-a11y`) | Mirror the site's `eslint.config.js` |
| Format | **Prettier** (or Biome) | See decision below |
| Path alias | `@/*` → `src/*` (shadcn convention) | Required by shadcn; matches site `components.json` aliases |

**Keep as-is:** TanStack Query (data), recharts (charts), xterm (terminal),
posthog (analytics), the pages/components/hooks/api-client architecture, the SPA
shape.

## Decisions needed (for review)

1. **Default theme** — match brand = **light** by default. Dashboards are often
   dark, but brand wins; shadcn's `darkMode: ["class"]` is wired so we can add a
   dark token set later. *Recommend: light default, dark deferred.*
2. **Accent color** — the site is essentially **monochrome** (ink primary, no
   colored accent). Keep monochrome + `--destructive` red, and optionally one
   functional green (`#3f7d5e`, used on the manifest pages) for success/active
   states only? *Recommend: monochrome + red + a single green for status.*
3. **Formatter** — ESLint 9 flat (mirror site) is decided; pair with **Prettier**
   or use **Biome** (one fast tool for lint+format). *Recommend: ESLint flat +
   Prettier to mirror the site exactly; revisit Biome later.*
4. **shadcn ownership** — shadcn copies components into `web/src/components/ui`
   (we "own" them but don't maintain the logic). The site already accepts this.
   Confirm OK vs a zero-ownership lib (Mantine) — which would be harder to brand.
   *Recommend: shadcn, for parity with the site.*
5. **Reskin vs redesign** — first pass = 1:1 reskin of existing screens.
   *Recommend: reskin first; redesigns later, per-screen.*
6. **Shared UI later?** — the site and dashboard are separate repos. For now we
   copy/mirror. A shared `@opencomputer/ui` package is a possible future step;
   out of scope here.

## Plan (phased; version bumps LAST)

Ordered so the foundation lands before any risky upgrade. Everything is
incremental — Tailwind/shadcn coexist with the current `theme.css` + inline
styles, so we migrate page-by-page with a green build throughout.

- [ ] **Phase 0 — Tooling.** ESLint 9 flat config (mirror site's
  `eslint.config.js`, add `jsx-a11y`) + Prettier. Wire `@/*` path alias in
  `tsconfig.json` + `vite.config.ts`. Add `lint`/`format` npm scripts. Fix the
  initial lint fallout. *No visual change.*
- [ ] **Phase 1 — Tailwind + tokens.** Add Tailwind 3.4 + `tailwindcss-animate`
  + `tailwind-merge` + `clsx`. Copy the site's `tailwind.config.ts` and the
  `:root` token block from its `index.css`. Load Inter / Newsreader / Geist Mono.
  Add `src/lib/utils.ts` (`cn()`). Tailwind coexists with `theme.css`.
- [ ] **Phase 2 — shadcn + icons.** `shadcn init` (style "default", baseColor
  slate, cssVariables). Generate the core set: `button card dialog
  alert-dialog dropdown-menu select tabs table tooltip input label badge
  separator sonner skeleton`. Add `lucide-react`. Stand up `<Toaster />` +
  theme provider in `main.tsx`/`App.tsx`.
- [ ] **Phase 3 — Migrate screens (reskin).** Pilot **`Sessions.tsx`** (table +
  filters + delete confirm) as the reference pattern. Then roll through the rest,
  replacing inline styles → utility classes/components, hand-rolled overlays →
  `Dialog`/`DropdownMenu`, `confirm()`/`alert()` → `AlertDialog` + `sonner`,
  inline `<svg>` → lucide. Suggested order by leverage: Sessions → Layout/shell →
  Dashboard → Checkpoints → APIKeys → Templates → Settings → Billing →
  SessionDetail → Agents → **AgentDetail (1,892 LOC, decompose while migrating)**.
- [ ] **Phase 4 — Forms.** Convert Settings / Billing / APIKeys / app-registration
  to react-hook-form + zod schemas.
- [ ] **Phase 5 — Tables.** Introduce TanStack Table where lists need
  sort/filter/pagination (Sessions, Checkpoints, Agents).
- [ ] **Phase 6 — Retire Void Glass.** Delete `theme.css` + any remaining inline
  styles once all screens are migrated.
- [ ] **Phase 7 — Core library upgrades (LAST, separate PRs).**
  - React 19 + react-router 7 **together** (RR7 supports React 19; codemods
    exist). Update `@types/react`/`@types/react-dom` to 19.
  - Vite 8 + `@vitejs/plugin-react` 6 (consider switching to
    `@vitejs/plugin-react-swc` to match the site).
  - TypeScript 6.
  - Bump `@tanstack/react-query`, recharts, posthog to latest minors (low risk).

## Per-concern detail

**Styling.** Tokens become Tailwind theme colors (`bg-background`,
`text-foreground`, `border-border`, `bg-card`, `text-muted-foreground`, etc.),
radius via `rounded-lg/md/sm` → `--radius`. The 633 inline `style={{}}` go to
zero. `:hover`/`:focus`/responsive become trivial (utility variants) instead of
impossible (inline).

**Components.** Each hand-rolled pattern maps to a shadcn primitive:
overlay → `Dialog`/`AlertDialog` (focus trap, ESC, ARIA for free), menus →
`DropdownMenu`, `<table className="data-table">` → shadcn `Table` (then TanStack
Table for behavior), badges → `Badge`, filter buttons → `ToggleGroup`/`Tabs`,
status pills → `Badge` variants.

**Forms.** `useState`-per-field → `useForm` + zod resolver; field errors and
submit state come from RHF. zod schemas double as runtime validation for the
`client.ts` API layer if we want it.

**Icons.** 26 inline `<svg>` → named lucide imports.

**Linter.** Catches hooks-rule violations, a11y issues (`jsx-a11y`), unused
vars, and enforces formatting — none of which we check today.

## Risks & mitigations

- **Big visual flip (dark → light).** Mitigate: 1:1 reskin (no layout changes),
  pilot one screen, review before rolling out. The evergreen branch (PR #426)
  keeps it reviewable.
- **a11y regressions in hand-rolled bits.** Mitigate: shadcn/Radix primitives are
  accessible by construction; `jsx-a11y` lint backstops.
- **Scope creep into redesign.** Mitigate: reskin-only this pass; redesigns are
  separate.
- **AgentDetail (1,892 LOC).** Highest-effort screen; decompose into sub-
  components as part of its migration, last in the order.
- **Upgrades destabilizing the reskin.** Mitigate: version bumps are Phase 7,
  after the foundation is proven; done as isolated PRs.

## Success criteria

- Inline `style={{}}` count ≈ 0; styling via Tailwind/tokens.
- `theme.css` deleted; brand tokens (paper/ink, Newsreader/Inter/Geist Mono, 6px
  radius) live and visually consistent with site + docs.
- All overlays/menus/tables/toasts via shadcn; no `confirm()`/`alert()`.
- Forms on react-hook-form + zod.
- ESLint + Prettier pass in CI; `jsx-a11y` clean.
- Net LOC down materially (esp. AgentDetail/Billing) despite added config.
- Core libs current (React 19 / RR7 / Vite 8 / TS 6) after Phase 7.

## References

- Dashboard: `web/` — `src/styles/theme.css`, `src/api/client.ts`,
  `src/pages/*`, `src/components/*`, `vite.config.ts`, `tsconfig.json`
- Site (brand + stack source): `opencomputer-site-v1/` —
  `tailwind.config.ts`, `src/index.css`, `components.json`, `eslint.config.js`,
  `package.json`
- Docs brand: `opencomputer/docs/docs.json`, `opencomputer/docs/styles/custom.css`
- Serving model: `internal/api/router.go` (`serveDashboardUI`),
  `cloudflare-workers/api-edge/wrangler.toml`
