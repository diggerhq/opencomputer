import { describe, expect, it } from 'vitest'
import { canConfirmProjectDeletion } from './project-settings'

describe('canConfirmProjectDeletion', () => {
  it('requires the exact project name', () => {
    expect(canConfirmProjectDeletion('Incident Agent', 'Incident Agent')).toBe(
      true,
    )
    expect(canConfirmProjectDeletion('incident agent', 'Incident Agent')).toBe(
      false,
    )
    expect(canConfirmProjectDeletion('Incident Agent ', 'Incident Agent')).toBe(
      false,
    )
  })
})
