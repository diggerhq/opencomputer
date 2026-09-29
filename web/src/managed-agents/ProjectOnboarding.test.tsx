import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ProjectOnboarding, {
  CREATE_AGENT_PROMPT,
  INSTALL_CLI_COMMAND,
  LOGIN_COMMAND,
} from './ProjectOnboarding'

describe('project onboarding', () => {
  it('offers prompt-first and command-first paths, defaulting to the prompt', () => {
    const markup = renderToStaticMarkup(<ProjectOnboarding />)

    expect(markup).toContain('Create your first agent')
    expect(markup).toContain('Use your coding agent')
    expect(markup).toContain('Run the commands')
    expect(markup).toContain('Claude Code, Codex, or OpenCode')
    expect(markup).toContain(CREATE_AGENT_PROMPT)
    expect(CREATE_AGENT_PROMPT).toContain(INSTALL_CLI_COMMAND)
    expect(CREATE_AGENT_PROMPT).toContain(LOGIN_COMMAND)
    expect(markup).not.toContain('repository URL')
  })
})
