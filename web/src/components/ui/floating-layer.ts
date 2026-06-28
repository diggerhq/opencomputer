const FLOATING_LAYER_ATTR = 'data-oc-floating-layer'
const FLOATING_LAYER_SELECTOR = `[${FLOATING_LAYER_ATTR}]`
let floatingLayerOutsideInteractionDepth = 0

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
  floatingLayerOutsideInteractionDepth += 1
  globalThis.setTimeout(() => {
    floatingLayerOutsideInteractionDepth = Math.max(
      0,
      floatingLayerOutsideInteractionDepth - 1,
    )
  }, 0)
}

export function shouldKeepParentOpenForFloatingLayer(event: Event) {
  const target = originalEventTarget(event)

  return (
    floatingLayerOutsideInteractionDepth > 0 ||
    (target instanceof Element &&
      target.closest(FLOATING_LAYER_SELECTOR) !== null) ||
    ownerDocumentForEvent(event)?.querySelector(FLOATING_LAYER_SELECTOR) !== null
  )
}
