import { describe, expect, it } from 'vitest'
import {
  createStartCommand,
  starterCommandBlock,
  starterCopyCommand,
  starterCommands,
} from './onboarding'

describe('managed-agent onboarding commands', () => {
  it('uses the CLI initializer and watched cloud deployment for a new account', () => {
    expect(createStartCommand('hello-world')).toBe(
      'npx @opencomputer/cli init hello-world',
    )
    expect(starterCommands('hello-world')).toEqual([
      'npx @opencomputer/cli init hello-world',
      'cd hello-world',
      'npm install',
      'npm run deploy -- --watch',
    ])
  })

  it('quotes a directory that contains spaces', () => {
    expect(starterCommands('support agent')).toEqual([
      "npx @opencomputer/cli init 'support agent'",
      "cd 'support agent'",
      'npm install',
      'npm run deploy -- --watch',
    ])
  })

  it('renders the complete onboarding flow shown to the user', () => {
    expect(starterCommandBlock('hello-world')).toBe(
      [
        'npx @opencomputer/cli init hello-world',
        'cd hello-world',
        'npm install',
        'npm run deploy -- --watch',
      ].join('\n'),
    )
  })

  it('copies the complete onboarding flow as one guarded shell command', () => {
    expect(starterCopyCommand('hello-world')).toBe(
      'npx @opencomputer/cli init hello-world && cd hello-world && npm install && npm run deploy -- --watch',
    )
  })
})
