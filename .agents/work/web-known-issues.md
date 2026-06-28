# Web dashboard — known issues

Running log of known, unresolved UI bugs in `web/` (the dashboard). Add an entry when
something is reproducible but not yet fixed, with enough detail to resume cold.

---

## Dialog closes when interacting with a Select/dropdown inside it

**Status:** open · **Severity:** minor–moderate UX (loses in-progress form input) · **Filed:** 2026-06-28

**Symptom.** Open a Radix `Select` (or any dropdown) rendered *inside* a `Dialog`, then
click an item — notably opening the dropdown a second time and clicking again — and the
**whole Dialog closes** instead of just the dropdown. Confirmed **generic to every modal
with a dropdown**, not specific to one screen (first reported on the agent-create dialog's
credential picker; reproduced elsewhere).

**Environment.** `radix-ui ^1.6.0` (the unified package), React 19, vite dev on `:3000`,
`web/`. Affected primitives: `web/src/components/ui/dialog.tsx` (Dialog) +
`web/src/components/form.tsx` (`Select`, `position="popper"`). Surfaces: any dialog with a
`Select` — e.g. `pages/Agents.tsx` (model + credential pickers), `pages/Credentials.tsx`
(provider).

**Suspected cause.** A Radix `Select` portals its menu *outside* the dialog DOM. Normally
the Select's `DismissableLayer` registers as a nested "branch" of the Dialog's layer (via
React context, which crosses portals), so interacting with the menu is NOT treated as
"outside" the dialog. Here that shielding appears to fail — the menu interaction reaches the
Dialog's dismiss path and closes it. Likely a layer/context nesting bug in the unified
`radix-ui` build (or duplicate copies of `@radix-ui/react-dismissable-layer` /
`react-focus-scope` breaking the shared context).

**What was tried (and did NOT fix it)** — all reverted to keep `DialogContent` clean:
- `onInteractOutside` guard on `DialogContent` that `preventDefault`s when the event target
  is inside a popper (`[data-radix-popper-content-wrapper]` / `[role=listbox]`).
- Broadened guard across **all three** outside-dismiss callbacks
  (`onPointerDownOutside`, `onFocusOutside`, `onInteractOutside`) that also `preventDefault`s
  whenever a dropdown is open anywhere in the DOM (`[data-radix-select-viewport]` /
  `[role=menu]`).
- `modal={false}` on the shared `Select` — **not typed** in this `radix-ui` version (tsc
  rejects the prop); abandoned.

None stopped the close. That strongly implies the dismissal is **not** going through the
standard `DismissableLayer` outside-interaction callbacks (or HMR on the shared component
masked testing — but a hard reload didn't help either).

**Next things to try (resume here):**
1. **Confirm the actual path first.** Temporarily log in the Dialog's `onOpenChange`
   (or wrap with `onEscapeKeyDown` / `onPointerDownOutside` / `onFocusOutside` loggers) to
   capture *what* fires the close — we never proved it's outside-interaction vs. focus-scope
   vs. something else. Everything below is guesswork until this is known.
2. `npm ls @radix-ui/react-dismissable-layer @radix-ui/react-focus-scope` — if there are
   multiple copies, the Select/Dialog don't share the layer context → branch registration
   fails. Dedupe / pin to fix.
3. Try the standalone `@radix-ui/react-select` + `@radix-ui/react-dialog` (not the unified
   `radix-ui`) for the affected dialogs, or bump `radix-ui`.
4. Last resort: disable outside-click-to-close on the *form* dialogs only (per-dialog
   `onInteractOutside={(e) => e.preventDefault()}` + rely on X/Cancel/Escape) — acceptable
   for forms, but only worth it once #1 confirms outside-interaction is even the trigger.

**Workaround for users today:** reopen the dialog (it's closed, not crashed).
