import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SourceChip } from '@/pages/AgentDetail'

describe('agent source status', () => {
  it('makes a changed Flue source visible from the normal overview header', () => {
    const html = renderToStaticMarkup(
      createElement(SourceChip, {
        source: {
          full_name: 'example/support',
          path: 'agents/support',
          production_ref: 'main',
          status: 'source_profile_changed',
        },
      }),
    )

    expect(html).toContain('example/support@main')
    expect(html).toContain('Source needs attention')
    expect(html).toContain('text-status-error')
  })
})
