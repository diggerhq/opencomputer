# Web dashboard — known issues

Running log of known, unresolved UI bugs in `web/` (the dashboard). Add an entry when
something is reproducible but not yet fixed, with enough detail to resume cold.

---

## Dialog closes when interacting with a Select/dropdown inside it — RESOLVED

**Status:** resolved (PR #443) · **Filed:** 2026-06-28 · **Fixed:** 2026-06-29 · **Severity:** minor–moderate UX (lost in-progress form input)

**Symptom.** Open a Radix `Select` inside a `Dialog`, then click the trigger a *second*
time to close it — and the **whole Dialog closes** instead of just the menu. Generic to
every modal with a dropdown (first hit on the agent-create credential picker).

**Actual root cause (confirmed, not the original guess).** `Select` is hardcoded
`disableOutsidePointerEvents` (no `modal` opt-out). While open it sets
`pointer-events: none` outside its menu. The second trigger click closes the menu and the
**tail of that same gesture** (pointerup/click, after pointer-events are restored) retargets
onto the Dialog overlay → the Dialog reads it as an outside click and dismisses. The menu has
already left Radix's layer stack by then, so the native `DismissableLayer` shielding (which
*does* protect the common cases) can't cover it. Radix treats this as by-design and won't fix
it (primitives [#2961](https://github.com/radix-ui/primitives/issues/2961) closed not-planned;
[#2731](https://github.com/radix-ui/primitives/issues/2731) documents the "click twice"
behavior). **It was not a version-mismatch / duplicate-`dismissable-layer` bug** — the unified
`radix-ui` 1.6.0 already deduplicates that; the original `npm ls` / standalone-package leads
were dead ends.

**Why the earlier `[data-radix-popper-content-wrapper]` guard "didn't work."** Two missing
pieces, both required:
1. **Unwrap the native event.** Radix wraps it — `event.target` on the outside-event is the
   *layer node*, not the click target — so `target.closest(...)` checked the wrong element and
   silently never matched. Must read `event.detail.originalEvent.target`.
2. **Survive the whole gesture.** The retarget dismiss fires later in the same
   pointerdown→pointerup→click sequence; a guard that clears too early misses it.

**The fix (`web/src/components/ui/floating-layer.ts` + dialog/sheet/form/dropdown).** Use
Radix's intended override — `preventDefault()` on the Dialog/Sheet `onInteractOutside` /
`onPointerDownOutside` / `onFocusOutside` — gated by two signals: (1) the interaction's
*unwrapped* target is inside `[data-radix-popper-content-wrapper]` (Radix's own popper marker —
no custom tagging), or (2) a **gesture flag**: a popper's `onPointerDownOutside` marks the
current gesture, and the flag is cleared on the next document `pointerdown` (capture), so it
covers exactly the one retarget gesture and never a later genuine backdrop click.

**Verified** (headless Chrome, real hit-tested clicks via CDP): second trigger click keeps the
dialog open and closes the menu; a genuine backdrop click still dismisses the dialog. Disabling
the guard flips the second-click assertion to fail, confirming the test discriminates.

**Follow-up:** no automated browser test harness exists in `web/` yet — add a Playwright
regression covering both directions (second-click-keeps-open; backdrop-dismisses) when one is
set up, so this can't silently regress.
