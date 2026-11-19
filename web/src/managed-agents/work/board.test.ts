import { describe, expect, it } from 'vitest'
import {
  attentionLabel,
  closedShown,
  indexIsOld,
  inProgress,
  matches,
  presentBody,
  pullLabel,
  readyToClose,
  repositoryProblem,
  resolveAgainst,
  staleDays,
} from './board'
import { makeItem, minutesAgo, NOW } from './fixtures'

const DAY = 24 * 60

describe('board columns', () => {
  it('splits open items by the readiness the API gives', () => {
    const items = [
      makeItem({ number: 1 }),
      makeItem({ number: 2, readyToClose: true }),
      makeItem({ number: 3, stage: 'closed', closedAt: minutesAgo(10) }),
    ]
    expect(inProgress(items).map((i) => i.number)).toEqual([1])
    expect(readyToClose(items).map((i) => i.number)).toEqual([2])
  })

  it('puts the cards that need you first, then the latest change', () => {
    const items = [
      makeItem({ number: 1, updatedAt: minutesAgo(5) }),
      makeItem({
        number: 2,
        updatedAt: minutesAgo(500),
        attention: { state: 'needs_you', name: null, since: minutesAgo(500) },
      }),
      makeItem({
        number: 3,
        updatedAt: minutesAgo(1),
        attention: { state: 'waiting_on', name: 'Maya', since: minutesAgo(1) },
      }),
    ]
    expect(inProgress(items).map((i) => i.number)).toEqual([2, 3, 1])
  })

  it('puts an item with no known change last within its group', () => {
    const needsYou = {
      state: 'needs_you' as const,
      name: null,
      since: minutesAgo(1),
    }
    const items = [
      makeItem({ number: 1, updatedAt: null }),
      makeItem({ number: 2, updatedAt: minutesAgo(500) }),
      makeItem({ number: 3, updatedAt: null, attention: needsYou }),
      makeItem({ number: 4, updatedAt: minutesAgo(5), attention: needsYou }),
      makeItem({ number: 5, updatedAt: minutesAgo(1) }),
    ]
    expect(inProgress(items).map((i) => i.number)).toEqual([4, 3, 5, 2, 1])
  })

  it('shows closed items of the last seven days unless older are asked for', () => {
    const items = [
      makeItem({ number: 1, stage: 'closed', closedAt: minutesAgo(2 * DAY) }),
      makeItem({ number: 2, stage: 'closed', closedAt: minutesAgo(9 * DAY) }),
      makeItem({ number: 3, stage: 'closed', closedAt: null }),
    ]
    expect(closedShown(items, false, NOW).map((i) => i.number)).toEqual([1])
    expect(closedShown(items, true, NOW).map((i) => i.number)).toEqual([
      1, 2, 3,
    ])
  })
})

describe('filters', () => {
  const item = makeItem({
    title: 'Usage billing',
    stateLine: 'Price table left',
    tags: ['billing'],
    mine: true,
  })
  it('keeps Mine to what the API marks mine', () => {
    expect(matches(item, { tab: 'mine', q: '', tag: null })).toBe(true)
    expect(
      matches({ ...item, mine: false }, { tab: 'mine', q: '', tag: null }),
    ).toBe(false)
    expect(
      matches({ ...item, mine: false }, { tab: 'everyone', q: '', tag: null }),
    ).toBe(true)
  })
  it('matches text in the title or state line, and the tag exactly', () => {
    const f = { tab: 'everyone' as const, tag: null }
    expect(matches(item, { ...f, q: 'PRICE' })).toBe(true)
    expect(matches(item, { ...f, q: 'nothing' })).toBe(false)
    expect(matches(item, { ...f, q: '', tag: 'billing' })).toBe(true)
    expect(matches(item, { ...f, q: '', tag: 'bill' })).toBe(false)
  })
})

describe('card wording', () => {
  it('colours only "needs you"', () => {
    const ago = () => '3h'
    expect(
      attentionLabel(
        makeItem({
          attention: { state: 'needs_you', name: null, since: minutesAgo(1) },
        }),
        ago,
      ),
    ).toEqual({ text: 'needs you', needsYou: true })
    expect(
      attentionLabel(
        makeItem({
          attention: {
            state: 'waiting_on',
            name: 'Maya',
            since: minutesAgo(1),
          },
        }),
        ago,
      ),
    ).toEqual({ text: 'waiting on Maya · 3h', needsYou: false })
    expect(attentionLabel(makeItem(), ago)).toBeNull()
  })

  it('marks an open card stale after two weeks without a change', () => {
    expect(staleDays(makeItem({ updatedAt: minutesAgo(20 * DAY) }), NOW)).toBe(
      20,
    )
    expect(staleDays(makeItem({ updatedAt: minutesAgo(DAY) }), NOW)).toBeNull()
    expect(staleDays(makeItem({ updatedAt: null }), NOW)).toBeNull()
  })

  it('names a pull request by its number', () => {
    expect(
      pullLabel({
        url: 'https://github.com/acme/app/pull/412',
        state: 'open',
        title: null,
      }),
    ).toBe('#412')
  })

  it('says the index is old only after a few minutes', () => {
    expect(indexIsOld(null, NOW)).toBe(false)
    expect(indexIsOld(minutesAgo(1), NOW)).toBe(false)
    expect(indexIsOld(minutesAgo(30), NOW)).toBe(true)
  })
})

describe('repository problem', () => {
  const r = {
    installationId: '1',
    owner: 'acme',
    name: 'knowledge',
    branch: 'main',
  }
  it('prefers the server sentence, then words for a known code', () => {
    expect(repositoryProblem({ ...r, problem: null })).toBeNull()
    expect(
      repositoryProblem({
        ...r,
        problem: 'access_denied',
        problemMessage: 'GitHub said no.',
      }),
    ).toBe('GitHub said no.')
    expect(repositoryProblem({ ...r, problem: 'repository_not_found' })).toBe(
      'The repository does not exist, or the GitHub installation no longer grants it.',
    )
    const unknown = repositoryProblem({ ...r, problem: 'something_new' })
    expect(unknown).toBeTruthy()
    expect(unknown).not.toContain('something_new')
  })
})

describe('the doc as shown', () => {
  it('drops the frontmatter and the leading title', () => {
    expect(
      presentBody('---\nnumber: 1\ntitle: X\n---\n\n# X\n\n## Why\n\nBecause.'),
    ).toBe('## Why\n\nBecause.')
    expect(presentBody('Just text.')).toBe('Just text.')
  })

  it('resolves relative links against the doc on GitHub', () => {
    const base = 'https://github.com/acme/knowledge/blob/main/work/001-x.md'
    expect(resolveAgainst('../design/a.md', base)).toBe(
      'https://github.com/acme/knowledge/blob/main/design/a.md',
    )
    expect(resolveAgainst('https://example.com', base)).toBe(
      'https://example.com',
    )
    expect(resolveAgainst('#why', base)).toBe('#why')
  })
})
