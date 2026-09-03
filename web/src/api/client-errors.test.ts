import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiFetch } from './client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api errors', () => {
  it('preserves structured recovery details without weakening the typed error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            {
              error: {
                type: 'source_already_linked',
                message: 'this repository path is already linked to an agent',
                existing_agent: { id: 'agt_existing', name: 'Support triage' },
              },
            },
            { status: 409 },
          ),
        ),
      ),
    )

    const error = await apiFetch('/v3/agents/import').catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 409,
      type: 'source_already_linked',
      details: {
        existing_agent: { id: 'agt_existing', name: 'Support triage' },
      },
    })
  })

  it('accepts code as the typed discriminator for edge API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            {
              error: {
                code: 'template_manifest_missing',
                message: 'The root manifest is missing.',
              },
            },
            { status: 422 },
          ),
        ),
      ),
    )

    const error = await apiFetch('/managed-agents/template-inspections').catch(
      (caught: unknown) => caught,
    )
    expect(error).toMatchObject({
      status: 422,
      type: 'template_manifest_missing',
      message: 'The root manifest is missing.',
    })
  })
})
