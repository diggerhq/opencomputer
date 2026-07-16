import { describe, expect, it } from 'vitest'
import { mockFetch } from './mock'
import { RepositorySourceInspectionSchema } from './schemas'

describe('preview API contracts', () => {
  it('keeps the repository review fixture valid against the live schema', () => {
    const response = mockFetch('/v3/github/deploy-app/inspect', {
      method: 'POST',
    })

    expect(() => RepositorySourceInspectionSchema.parse(response)).not.toThrow()
  })
})
