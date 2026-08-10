import { describe, expect, it } from 'vitest'
import { createStartCommand, starterCommands } from './onboarding'

describe('managed-agent onboarding commands', () => {
  it('uses the scoped npm initializer for a new account', () => {
    expect(createStartCommand('hello-world')).toBe(
      'npm create @opencomputer/start@latest hello-world',
    )
    expect(starterCommands('hello-world')).toEqual([
      'npm create @opencomputer/start@latest hello-world',
      'npm i',
      'npm run dev',
    ])
  })

  it('quotes a directory that contains spaces', () => {
    expect(starterCommands('support agent')).toEqual([
      "npm create @opencomputer/start@latest 'support agent'",
      'npm i',
      'npm run dev',
    ])
  })
})
