const FLOATING_LAYER_ATTR = 'data-oc-floating-layer'
const FLOATING_LAYER_SELECTOR = `[${FLOATING_LAYER_ATTR}]`

type OutsideEventDetail = {
  originalEvent?: Event
}

export const floatingLayerProps = {
  [FLOATING_LAYER_ATTR]: '',
} as const

export function isEventFromFloatingLayer(event: Event) {
  const originalEvent = (event as CustomEvent<OutsideEventDetail>).detail
    ?.originalEvent
  const target = originalEvent?.target ?? event.target

  return (
    target instanceof Element &&
    target.closest(FLOATING_LAYER_SELECTOR) !== null
  )
}
