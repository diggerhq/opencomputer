import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SessionSourcesPanel } from './SessionDetail'

describe('session working sources', () => {
  it('shows stable identity, requested ref, pinned SHA, status, and path', () => {
    const html = renderToStaticMarkup(
      <SessionSourcesPanel
        sources={[
          {
            name: 'app',
            repo_id: 'repo_1',
            full_name: 'acme/app',
            requested_ref: 'main',
            status: 'ready',
            path: '/workspace/sources/app',
            sha: 'a'.repeat(40),
            resolved_sha: 'b'.repeat(40),
          },
        ]}
        loading={false}
        error={false}
        onRetry={() => {}}
      />,
    )
    expect(html).toContain('acme/app')
    expect(html).toContain('main · aaaaaaaa')
    expect(html).toContain('observed bbbbbbbb')
    expect(html).toContain(`title="Pinned commit ${'a'.repeat(40)}"`)
    expect(html).toContain('Ready')
    expect(html).toContain('/workspace/sources/app')
  })

  it('stays absent when the session has no sources', () => {
    expect(
      renderToStaticMarkup(
        <SessionSourcesPanel
          sources={[]}
          loading={false}
          error={false}
          onRetry={() => {}}
        />,
      ),
    ).toBe('')
  })
})
