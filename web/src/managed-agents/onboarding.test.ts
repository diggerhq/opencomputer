import { describe, expect, it } from 'vitest'
import {
  createStartCommand,
  linkProjectCommand,
  starterCommandBlock,
  starterCopyCommand,
  starterCommands,
} from './onboarding'

describe('managed-agent onboarding commands', () => {
  it('links the checkout to the cloud project before the first watched deployment', () => {
    expect(createStartCommand('hello-world')).toBe(
      'npx @opencomputer/cli init hello-world',
    )
    expect(linkProjectCommand('hello-world')).toBe(
      'npx @opencomputer/cli link --project hello-world',
    )
    expect(starterCommands('hello-world', 'hello-world')).toEqual([
      'npx @opencomputer/cli init hello-world',
      'cd hello-world',
      'npm install',
      'npx @opencomputer/cli link --project hello-world',
      'npm run deploy -- --watch',
    ])
  })

  it('quotes a directory and project that contain spaces', () => {
    expect(starterCommands('support agent', 'support agent')).toEqual([
      "npx @opencomputer/cli init 'support agent'",
      "cd 'support agent'",
      'npm install',
      "npx @opencomputer/cli link --project 'support agent'",
      'npm run deploy -- --watch',
    ])
  })

  it('renders the complete onboarding flow shown to the user', () => {
    expect(starterCommandBlock('hello-world', 'hello-world')).toBe(
      [
        'npx @opencomputer/cli init hello-world',
        'cd hello-world',
        'npm install',
        'npx @opencomputer/cli link --project hello-world',
        'npm run deploy -- --watch',
      ].join('\n'),
    )
  })

  it('copies the complete onboarding flow as one guarded shell command', () => {
    expect(starterCopyCommand('hello-world', 'hello-world')).toBe(
      'npx @opencomputer/cli init hello-world && cd hello-world && npm install && npx @opencomputer/cli link --project hello-world && npm run deploy -- --watch',
    )
  })
})
