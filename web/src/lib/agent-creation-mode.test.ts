import { describe, expect, it } from 'vitest'
import { resolveAgentCreationMode } from './agent-creation-mode'

describe('agent creation mode', () => {
  it('fails a direct GitHub request over to manual until availability is true', () => {
    expect(resolveAgentCreationMode('github', false)).toBe('manual')
    expect(resolveAgentCreationMode(null, false)).toBe('manual')
  })

  it('keeps repository-first defaults for an allowed owner', () => {
    expect(resolveAgentCreationMode(null, true)).toBe('github')
    expect(resolveAgentCreationMode('github', true)).toBe('github')
    expect(resolveAgentCreationMode('manual', true)).toBe('manual')
  })
})
