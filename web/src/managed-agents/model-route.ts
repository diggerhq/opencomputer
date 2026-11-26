import { managedAgentModelRoute, type ManagedAgentEvent } from './api'

// The model route in force at a render: the last one reported between it and
// the renders either side.
export function modelRouteForRender(
  events: ManagedAgentEvent[],
  renderEvent: ManagedAgentEvent,
) {
  const renderIndex = events.indexOf(renderEvent)
  if (renderIndex < 0) return undefined
  let previousRenderIndex = -1
  for (let index = renderIndex - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'agent.rendered') {
      previousRenderIndex = index
      break
    }
  }
  const nextRenderIndex = events.findIndex(
    (event, index) => index > renderIndex && event.type === 'agent.rendered',
  )
  const routes = events
    .slice(
      previousRenderIndex + 1,
      nextRenderIndex < 0 ? undefined : nextRenderIndex,
    )
    .map(managedAgentModelRoute)
    .filter((route) => route !== undefined)
  return routes[routes.length - 1]
}
