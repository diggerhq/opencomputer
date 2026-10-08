import { describe, expect, it } from 'vitest'
import { projectAgentPreviewReady } from './preview-state'

describe('projectAgentPreviewReady', () => {
  it('accepts a ready project preview when an unchanged agent reused a development deployment', () => {
    expect(
      projectAgentPreviewReady({
        alias: 'pr-1',
        agentId: 'summarizer',
        deployments: [{ agentId: 'summarizer', alias: 'development' }],
        previews: [{ alias: 'pr-1', state: 'ready' }],
      }),
    ).toBe(true)
  })

  it('does not advertise a preview while its build is incomplete', () => {
    expect(
      projectAgentPreviewReady({
        alias: 'pr-1',
        agentId: 'summarizer',
        deployments: [{ agentId: 'summarizer', alias: 'development' }],
        previews: [{ alias: 'pr-1', state: 'building' }],
      }),
    ).toBe(false)
  })

  it('keeps supporting an alias represented directly by a deployment row', () => {
    expect(
      projectAgentPreviewReady({
        alias: 'pr-2',
        agentId: 'coder',
        deployments: [{ agentId: 'coder', alias: 'pr-2' }],
        previews: [],
      }),
    ).toBe(true)
  })
})
