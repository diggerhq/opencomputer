/**
 * Keep a parent Dialog/Sheet open when the user interacts with a Radix
 * Select / DropdownMenu rendered inside it.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Radix portals Select/DropdownMenu content to <body>, so the menu is a DOM
 * sibling of the dialog, not a descendant. Radix's DismissableLayer normally
 * shields the dialog while a menu is open (nested layers share a context, and a
 * child layer's interaction is not treated as "outside" the parent). That
 * shielding holds for the ordinary cases — but NOT for one specific, by-design
 * Radix behavior that produces the bug we actually hit:
 *
 *   `Select` is hardcoded `disableOutsidePointerEvents` and exposes no `modal`
 *   opt-out. While open it sets `pointer-events: none` on everything outside its
 *   menu. When you click the trigger a SECOND time to close the menu, that
 *   pointer-down hits the now-non-interactive trigger, closes the menu, and the
 *   TAIL of the same gesture (the pointerup/click, once pointer-events are
 *   restored) retargets onto the dialog overlay. The dialog reads that as an
 *   outside click and dismisses — even though the user only meant to close the
 *   menu. The menu has already left the layer stack by then, so Radix's native
 *   shielding can't catch it.
 *
 * Radix considers this intended and won't change it (primitives #2961 closed as
 * not-planned; #2731 documents the "you have to click twice" behavior of
 * `disableOutsidePointerEvents`). The blessed escape hatch is exactly what we
 * use: Dialog/Sheet forward `onInteractOutside` / `onPointerDownOutside` /
 * `onFocusOutside` into DismissableLayer, and we `preventDefault()` when an
 * "outside" interaction is really part of a menu interaction.
 *
 * ── TWO SIGNALS (the two failure modes look different to the dialog) ─────────
 *  1. ELEMENT — the interaction's target is inside a portaled popper, i.e. the
 *     user clicked into the menu itself. We match Radix's own marker
 *     `[data-radix-popper-content-wrapper]`, which Radix stamps on every popper
 *     layer (Select, DropdownMenu, Popover, …), so new floating components are
 *     covered for free without us tagging each one.
 *  2. GESTURE — the second-click retarget above. Here the dialog's handler sees
 *     the dialog OVERLAY as the target (the menu is already gone), so signal (1)
 *     can't catch it. When a popper dismisses from a pointer interaction it calls
 *     `markFloatingLayerPointerDismiss()`, and we then swallow the dialog's
 *     dismiss for the rest of THAT single pointer gesture.
 *
 * ── WHY A GESTURE FLAG, NOT A TIMER ─────────────────────────────────────────
 * An earlier version used a 500ms wall-clock window plus "is any popper mounted
 * anywhere in the document". Both are too broad: they also swallow genuine
 * backdrop clicks for 500ms after using a menu, and disable outside-dismiss
 * entirely whenever any unrelated dropdown is mounted. The precise fact we want
 * is "this is the same physical gesture that just closed a menu" — so we set a
 * flag on the menu's pointer-dismiss and clear it at the very start of the next
 * gesture (a fresh document `pointerdown`, capture phase, before Radix's own
 * handlers run). The flag therefore survives exactly one gesture's
 * pointerdown → pointerup → click and never a later, genuine outside click.
 *
 * ── A SHARP EDGE THAT WASTED EARLIER ATTEMPTS ───────────────────────────────
 * Radix wraps the native event: `event.target` on the synthetic outside-event is
 * the layer node, NOT the click target. The element check must read
 * `event.detail.originalEvent.target`. Missing this is why prior tries at the
 * `data-radix-popper-content-wrapper` guard silently did nothing.
 */

// Radix's built-in marker on every portaled popper layer. Keying off Radix's own
// attribute (rather than a tag we add) means future floating components are
// covered automatically.
const POPPER_WRAPPER_SELECTOR = '[data-radix-popper-content-wrapper]'

type OutsideEventDetail = {
  originalEvent?: Event
}

// True only between a popper's pointer-dismiss and the start of the next pointer
// gesture — i.e. for the single gesture whose retargeted tail would otherwise
// close the parent dialog.
let swallowDialogDismissForGesture = false

// Clear the flag at the very start of every new gesture. Capture phase + a
// module-load registration means this runs before Radix's per-layer pointerdown
// handlers (which register later, when a menu opens), so the flag set during a
// gesture is never cleared within that same gesture — only at the next one.
if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    () => {
      swallowDialogDismissForGesture = false
    },
    true,
  )
}

function originalEventTarget(event: Event): EventTarget | null {
  const originalEvent = (event as CustomEvent<OutsideEventDetail>).detail
    ?.originalEvent

  return originalEvent?.target ?? event.target
}

/**
 * Call from a Select/DropdownMenu `onPointerDownOutside`. The pointer gesture
 * that dismissed the menu is the one whose tail can retarget onto and close the
 * parent dialog; this marks that gesture so the dialog ignores the resulting
 * dismiss. (Item clicks and keyboard selection don't need this — they don't
 * retarget outside the menu.)
 */
export function markFloatingLayerPointerDismiss(): void {
  swallowDialogDismissForGesture = true
}

/**
 * True when a Dialog/Sheet outside-dismiss should be suppressed because it is
 * really a menu interaction — either a click into a portaled popper (element
 * signal) or the tail of the gesture that just dismissed one (gesture signal).
 */
export function shouldKeepParentOpenForFloatingLayer(event: Event): boolean {
  if (swallowDialogDismissForGesture) return true

  const target = originalEventTarget(event)
  return (
    target instanceof Element &&
    target.closest(POPPER_WRAPPER_SELECTOR) !== null
  )
}
