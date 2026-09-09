import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ProjectOnboarding, {
  CREATE_AGENT_PROMPT,
  INSTALL_CLI_COMMAND,
  LOGIN_COMMAND,
} from './ProjectOnboarding'

describe('project onboarding', () => {
  it('presents the CLI-only three-step flow', () => {
    const markup = renderToStaticMarkup(<ProjectOnboarding />)

    expect(markup).toContain('Create your first agent')
    expect(markup).toContain('Install the OpenComputer CLI')
    expect(markup).toContain(INSTALL_CLI_COMMAND)
    expect(markup).toContain('Sign in to OpenComputer')
    expect(markup).toContain(LOGIN_COMMAND)
    expect(markup).toContain('Codex, Claude Code, or OpenCode')
    expect(markup).toContain(CREATE_AGENT_PROMPT)
    expect(markup).not.toContain('template')
    expect(markup).not.toContain('repository URL')
  })
})
