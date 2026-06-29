/**
 * Keep a parent Dialog/Sheet open when a Radix Select/DropdownMenu inside it is
 * dismissed.
 *
 * Bug: Select hardcodes `disableOutsidePointerEvents` (no `modal` opt-out), so a
 * second click on its trigger closes the menu and that same gesture's tail
 * retargets onto the dialog overlay → the dialog dismisses. The menu has left
 * Radix's layer stack by then, so its native shielding can't catch it, and Radix
 * considers this by-design (primitives #2961, #2731). Fix = Radix's intended
 * override, preventDefault() on the dialog's outside handlers, when the "outside"
 * event is really a menu interaction — detected two ways:
 *   1. target is inside Radix's own `[data-radix-popper-content-wrapper]` (clicked
 *      into the menu). Read detail.originalEvent.target, NOT event.target: Radix
 *      wraps the event so event.target is the layer node — missing this silently
 *      no-ops the guard, which is why earlier attempts failed.
 *   2. the retarget, where target is the overlay that (1) can't see: the popper
 *      flags its dismissing gesture (below); we honor it until the next pointerdown.
 */

const POPPER_WRAPPER_SELECTOR = '[data-radix-popper-content-wrapper]'

type OutsideEventDetail = {
  originalEvent?: Event
}

// Set while a popper's dismissing gesture is in flight (signal 2). Cleared at the
// start of each gesture — capture phase, registered at module load, so it runs
// before Radix's per-menu handlers and the flag spans exactly one gesture
// (pointerdown→pointerup→click), never a later genuine backdrop click. A timer or
// "any popper mounted" check would instead swallow real outside clicks too.
let swallowDialogDismissForGesture = false

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

// Call from a popper's onPointerDownOutside — the gesture whose tail can retarget
// onto and close the parent dialog. (Item clicks / keyboard don't retarget out.)
export function markFloatingLayerPointerDismiss(): void {
  swallowDialogDismissForGesture = true
}

export function shouldKeepParentOpenForFloatingLayer(event: Event): boolean {
  if (swallowDialogDismissForGesture) return true

  const target = originalEventTarget(event)
  return (
    target instanceof Element &&
    target.closest(POPPER_WRAPPER_SELECTOR) !== null
  )
}
