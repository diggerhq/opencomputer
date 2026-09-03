import { describe, expect, it } from 'vitest'
import {
  projectCloneCommand,
  installedTemplateAgentId,
  templateFirstRunPrompt,
  templatePlaygroundPath,
} from './template-continuation'

describe('template local continuation', () => {
  it('clones the existing OpenComputer project', () => {
    expect(projectCloneCommand('prj_example')).toBe(
      "npx --package @opencomputer/cli opencomputer project clone 'prj_example'",
    )
  })

  it('opens the installed agent in its project Debug playground', () => {
    expect(
      templatePlaygroundPath({
        projectId: 'prj/example',
        projectAgentId: 'review agent',
      }),
    ).toBe('/projects/prj%2Fexample/playground/review%20agent')
  })

  it('maps the template first-run agent to its installed project agent', () => {
    expect(
      installedTemplateAgentId({
        projectAgentId: 'cloud-primary',
        localAgentId: 'reviewer',
        primaryLocalAgentId: 'triage',
      }),
    ).toBe('cloud-primary--reviewer')
    expect(
      installedTemplateAgentId({
        projectAgentId: 'cloud-primary',
        localAgentId: 'triage',
        primaryLocalAgentId: 'triage',
      }),
    ).toBe('cloud-primary')
  })

  it('only consumes a non-empty first-run prompt from navigation state', () => {
    expect(
      templateFirstRunPrompt({ templateFirstRunPrompt: 'Review this PR' }),
    ).toBe('Review this PR')
    expect(
      templateFirstRunPrompt({ templateFirstRunPrompt: '' }),
    ).toBeUndefined()
    expect(templateFirstRunPrompt(null)).toBeUndefined()
  })
})
