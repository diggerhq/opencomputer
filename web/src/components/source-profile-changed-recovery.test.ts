import { describe, expect, it } from 'vitest'
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
})
