import type { UIMessage } from 'ai'
import type { ManagedAgentEvent } from './api'

/**
 * Where a playground turn is while the agent has not produced output yet.
 *
 * - `session`: creating the durable session (first message only).
 * - `runtime`: the runtime is booting or waking from suspension. This is a
 *   one-time cost per session start, not something every reply pays.
 * - `model`: the runtime is connected; the turn is waiting on the model.
 */
export type StartupPhase = 'session' | 'runtime' | 'model'

export const STARTUP_PHASE_PART_TYPE = 'data-startup-phase' as const

export interface StartupPhaseData {
  phase: StartupPhase
}

export function initialStartupPhase(hasSession: boolean): StartupPhase {
  return hasSession ? 'model' : 'session'
}

export function nextStartupPhase(
  current: StartupPhase,
  event: ManagedAgentEvent,
): StartupPhase {
  switch (event.type) {
    case 'session.created':
    case 'runtime.resumed':
      return 'runtime'
    case 'session.status_changed':
      return event.data.to === 'connecting' || event.data.to === 'resuming'
        ? 'runtime'
        : current
    case 'runtime.connected':
    case 'turn.started':
      return 'model'
    default:
      return current
  }
}

export function startupPhaseLabel(phase: StartupPhase | undefined) {
  switch (phase) {
    case 'session':
      return 'Creating a session…'
    case 'runtime':
      return 'Starting the runtime… (one-time setup for this session)'
    case 'model':
      return 'Waiting for the agent to respond…'
    default:
      return 'Starting the agent…'
  }
}

export function startupPhaseHint(phase: StartupPhase | undefined) {
  if (phase === 'runtime')
    return 'Later messages in this session skip this step.'
  return undefined
}

export function messageStartupPhase(
  message: UIMessage,
): StartupPhase | undefined {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index]
    if (part.type !== STARTUP_PHASE_PART_TYPE) continue
    const { data } = part
    if (data && typeof data === 'object' && 'phase' in data) {
      const { phase } = data
      if (phase === 'session' || phase === 'runtime' || phase === 'model')
        return phase
    }
  }
  return undefined
}
