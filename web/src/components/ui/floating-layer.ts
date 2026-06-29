const FLOATING_LAYER_ATTR = 'data-oc-floating-layer'
const FLOATING_LAYER_SELECTOR = `[${FLOATING_LAYER_ATTR}]`
const FLOATING_LAYER_OUTSIDE_INTERACTION_WINDOW_MS = 500
let lastFloatingLayerOutsideInteractionAt = 0

type OutsideEventDetail = {
  originalEvent?: Event
}

export const floatingLayerProps = {
  [FLOATING_LAYER_ATTR]: '',
} as const

function originalEventTarget(event: Event) {
  const originalEvent = (event as CustomEvent<OutsideEventDetail>).detail
    ?.originalEvent

  return originalEvent?.target ?? event.target
}

function ownerDocumentForEvent(event: Event) {
  const target = originalEventTarget(event)

  return target instanceof Node ? target.ownerDocument : globalThis.document
}

export function markFloatingLayerOutsideInteraction() {
  lastFloatingLayerOutsideInteractionAt = Date.now()
}

export function shouldKeepParentOpenForFloatingLayer(event: Event) {
  const target = originalEventTarget(event)
  const isRecentFloatingLayerOutsideInteraction =
    Date.now() - lastFloatingLayerOutsideInteractionAt <=
    FLOATING_LAYER_OUTSIDE_INTERACTION_WINDOW_MS

  return (
    isRecentFloatingLayerOutsideInteraction ||
    (target instanceof Element &&
      target.closest(FLOATING_LAYER_SELECTOR) !== null) ||
    ownerDocumentForEvent(event)?.querySelector(FLOATING_LAYER_SELECTOR) !== null
  )
}
