import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  canSessionChangeFlueSources,
  isFlueSession,
  sessionSourcesRefetchInterval,
} from '@/lib/session-source-polling'
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
            status: 'resolved',
            path: '/workspace/sources/app',
            sha: 'a'.repeat(40),
            resolved_sha: 'b'.repeat(40),
          },
          {
            name: 'docs',
            repo_id: 'repo_2',
            full_name: 'acme/docs',
            requested_ref: 'main',
            status: 'materializing',
            path: '/workspace/sources/docs',
            sha: 'c'.repeat(40),
          },
          {
            name: 'pending',
            status: 'pending',
            path: '/workspace/sources/pending',
            sha: 'd'.repeat(40),
          },
          {
            name: 'failed',
            status: 'failed',
            path: '/workspace/sources/failed',
            sha: 'e'.repeat(40),
          },
          {
            name: 'unavailable',
            status: 'unavailable',
            path: '/workspace/sources/unavailable',
            sha: 'f'.repeat(40),
          },
          {
            name: 'auth',
            status: 'auth_required',
            path: '/workspace/sources/auth',
            sha: '0'.repeat(40),
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
    expect(html).toContain('Resolved')
    expect(html).toContain('Materializing')
    expect(html).toContain('Pending')
    expect(html).toContain('Failed')
    expect(html).toContain('Unavailable')
    expect(html).toContain('Auth required')
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

  it('watches for new sources and accelerates while materialization is active', () => {
    expect(sessionSourcesRefetchInterval([])).toBe(5_000)
    expect(
      sessionSourcesRefetchInterval([
        {
          name: 'app',
          status: 'pending',
          path: '/workspace/sources/app',
          sha: 'a'.repeat(40),
        },
      ]),
    ).toBe(1_500)
    expect(
      sessionSourcesRefetchInterval([
        {
          name: 'app',
          status: 'materializing',
          path: '/workspace/sources/app',
          sha: 'a'.repeat(40),
        },
      ]),
    ).toBe(1_500)
    expect(
      sessionSourcesRefetchInterval([
        {
          name: 'app',
          status: 'resolved',
          path: '/workspace/sources/app',
          sha: 'a'.repeat(40),
          resolved_sha: 'a'.repeat(40),
        },
      ]),
    ).toBe(5_000)
  })

  it('loads only Flue sources and polls only while the session can change', () => {
    for (const status of ['queued', 'running', 'awaiting_input', 'idle']) {
      const session = {
        status,
        agent_snapshot: { runtime: 'flue' },
      }
      expect(isFlueSession(session)).toBe(true)
      expect(canSessionChangeFlueSources(session)).toBe(true)
    }
    expect(isFlueSession(undefined)).toBe(false)
    expect(canSessionChangeFlueSources(undefined)).toBe(false)
    const builtIn = {
      status: 'running',
      agent_snapshot: { runtime: 'claude' },
    }
    expect(isFlueSession(builtIn)).toBe(false)
    expect(canSessionChangeFlueSources(builtIn)).toBe(false)
    for (const status of ['failed', 'archived']) {
      const terminalFlue = {
        status,
        agent_snapshot: { runtime: 'flue' },
      }
      expect(isFlueSession(terminalFlue)).toBe(true)
      expect(canSessionChangeFlueSources(terminalFlue)).toBe(false)
    }
  })
})
