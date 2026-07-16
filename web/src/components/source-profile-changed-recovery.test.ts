import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SourceProfileChangedRecovery } from '@/components/source-profile-changed-recovery'
import { sourceChangesUrl } from '@/lib/source-profile-recovery'

describe('source profile change recovery', () => {
  it('links only a bounded GitHub repository and exact commit', () => {
    expect(
      sourceChangesUrl({
        full_name: 'example/support agent',
        latest_seen_sha: 'a'.repeat(40),
      }),
    ).toBe(
      `https://github.com/example/support%20agent/commit/${'a'.repeat(40)}`,
    )
    expect(
      sourceChangesUrl({
        full_name: 'not/a/repository',
        latest_seen_sha: 'a'.repeat(40),
      }),
    ).toBeUndefined()
    expect(
      sourceChangesUrl({
        full_name: 'example/support',
        latest_seen_sha: 'branch-name',
      }),
    ).toBe('https://github.com/example/support')
  })

  it('renders the durable restore-or-unlink contract', () => {
    const html = renderToStaticMarkup(
      createElement(SourceProfileChangedRecovery, {
        source: {
          agent_id: 'agt_test',
          repo_id: 'repo_0123456789abcdef01234567',
          path: 'agents/support',
          production_ref: 'main',
          status: 'source_profile_changed',
          latest_seen_sha: 'a'.repeat(40),
          active_deployed_sha: 'b'.repeat(40),
          full_name: 'example/support',
          source_profile: 'flue-app-v1',
          source_profile_version: 1,
          review_fingerprint: `sha256:${'c'.repeat(64)}`,
        },
        pending: false,
        onUnlink: () => {},
      }),
    )

    expect(html).toContain(
      'This repository no longer matches the agent type it was imported as',
    )
    expect(html).toContain(
      'its current active revision and sessions remain available.',
    )
    expect(html).toContain('View source changes')
    expect(html).toContain('Unlink source')
  })
})
