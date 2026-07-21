import { describe, expect, it } from 'vitest'
import { mockFetch } from './mock'
import {
  RepositoryAccessSchema,
  RepositorySourceInspectionSchema,
  SessionSourceListSchema,
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
        mockFetch('/v3/agents/agt_flue_import/repository-access'),
      ),
    ).not.toThrow()
    expect(() =>
      SessionSourceListSchema.parse(
        mockFetch('/v3/sessions/ses_a1b2c3/sources'),
      ),
    ).not.toThrow()
  })
})
