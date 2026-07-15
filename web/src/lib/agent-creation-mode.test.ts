import { describe, expect, it } from 'vitest'
import { resolveAgentCreationMode } from './agent-creation-mode'

describe('agent creation mode', () => {
  it('defaults to repository import and preserves an explicit manual choice', () => {
    expect(resolveAgentCreationMode(null)).toBe('github')
    expect(resolveAgentCreationMode('github')).toBe('github')
    expect(resolveAgentCreationMode('manual')).toBe('manual')
  })
})
