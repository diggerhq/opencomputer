import { describe, expect, it } from 'vitest'
import { mockFetch } from './mock'
import {
  AgentListSchema,
  RepositoryAccessSchema,
  RepositorySourceInspectionSchema,
  SessionListSchema,
  SessionSourceListSchema,
  SessionTurnListSchema,
  TurnUsageSchema,
} from './schemas'

describe('preview API contracts', () => {
  it('keeps the repository review fixture valid against the live schema', () => {
    const response = mockFetch('/v3/github/deploy-app/inspect', {
      method: 'POST',
    })

    expect(() => RepositorySourceInspectionSchema.parse(response)).not.toThrow()
  })

  it('keeps repository access and source-detail fixtures valid', () => {
    expect(() =>
      RepositoryAccessSchema.parse(
        mockFetch('/v3/agents/agt_fedcba9876543210fedcba98/repository-access'),
      ),
    ).not.toThrow()
    expect(() =>
      SessionSourceListSchema.parse(
        mockFetch('/v3/sessions/ses_a1b2c3/sources'),
      ),
    ).not.toThrow()
  })

  it('keeps agent and canonical usage fixtures valid', () => {
    expect(() => AgentListSchema.parse(mockFetch('/v3/agents'))).not.toThrow()
    expect(() =>
      SessionListSchema.parse(mockFetch('/v3/sessions')),
    ).not.toThrow()
    expect(() =>
      SessionTurnListSchema.parse(mockFetch('/v3/sessions/ses_a1b2c3/turns')),
    ).not.toThrow()
  })

  it('accepts a reported turn whose total is an explicit lower bound', () => {
    expect(() =>
      TurnUsageSchema.parse({
        reported: true,
        complete: false,
        input_tokens: 10,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        tokens: 12,
      }),
    ).not.toThrow()
  })
})
