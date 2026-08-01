import { describe, expect, it } from 'vitest'
import { displayManagedAgentName } from './api'

describe('displayManagedAgentName', () => {
  it('hides UUID-shaped legacy names without hiding readable stable names', () => {
    expect(
      displayManagedAgentName({
        id: '8d25ba55-d9de-4345-bedd-92ac5a3f1485',
        name: '8d25ba55-d9de-4345-bedd-92ac5a3f1485',
      }),
    ).toBe('Untitled project')
    expect(
      displayManagedAgentName({ id: 'email-triage', name: 'email-triage' }),
    ).toBe('email-triage')
    expect(
      displayManagedAgentName({ id: 'stable-id', name: 'Gentle Falcon' }),
    ).toBe('Gentle Falcon')
  })
})
