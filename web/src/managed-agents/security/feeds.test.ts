import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DISCOVERY_ANGLES,
  SWARM_FEEDS,
  assignAngles,
  fetchLiveCves,
  feedSeedingLines,
} from './feeds'

describe('discovery angles', () => {
  it('round-robins angles across cells so a swarm diverges', () => {
    const three = assignAngles(3).map((a) => a.id)
    expect(three).toEqual(DISCOVERY_ANGLES.slice(0, 3).map((a) => a.id))
    expect(new Set(three).size).toBe(3)
  })

  it('wraps back to the first angle once the catalog is exhausted', () => {
    const count = DISCOVERY_ANGLES.length + 2
    const assigned = assignAngles(count)
    expect(assigned).toHaveLength(count)
    expect(assigned[DISCOVERY_ANGLES.length].id).toBe(DISCOVERY_ANGLES[0].id)
    expect(assigned[DISCOVERY_ANGLES.length + 1].id).toBe(DISCOVERY_ANGLES[1].id)
  })

  it('is empty for a non-positive count', () => {
    expect(assignAngles(0)).toEqual([])
    expect(assignAngles(-3)).toEqual([])
  })

  it('every angle carries an id, label and focus line', () => {
    for (const angle of DISCOVERY_ANGLES) {
      expect(angle.id).toMatch(/^[a-z-]+$/)
      expect(angle.label.length).toBeGreaterThan(0)
      expect(angle.focus.length).toBeGreaterThan(0)
    }
  })
})

describe('feed seeding', () => {
  it('names both live feeds with reachable JSON endpoints', () => {
    const ids = SWARM_FEEDS.map((f) => f.id)
    expect(ids).toContain('cve.now')
    expect(ids).toContain('pwn.watch')
    for (const feed of SWARM_FEEDS) {
      expect(feed.json).toMatch(/^https:\/\//)
    }
  })

  it('points the agent at live feeds and the lockfile match', () => {
    const text = feedSeedingLines().join('\n')
    expect(text).toContain('cve.now')
    expect(text).toContain('pwn.watch')
    expect(text).toContain('check_stack')
  })
})

describe('fetchLiveCves', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // One page of the entries API: `count` entries numbered from `start`, plus the
  // cursor to the following page (null for the last page). Not async — returning
  // a resolved promise keeps eslint's require-await happy.
  const page = (start: number, count: number, nextCursor: string | null) => {
    const entries = Array.from({ length: count }, (_, i) => ({
      id: `CVE-2026-${start + i}`,
      title: `Entry ${start + i}`,
      cvss: 5,
      statedSeverity: 'medium',
      kev: false,
      firstSeenAt: '2026-10-24T00:00:00Z',
    }))
    return { ok: true, json: () => Promise.resolve({ entries, nextCursor }) }
  }

  it('follows the cursor across pages until it reaches the limit', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(0, 30, 'c1'))
      .mockResolvedValueOnce(page(30, 30, 'c2'))
      .mockResolvedValueOnce(page(60, 30, 'c3'))
    vi.stubGlobal('fetch', fetchMock)
    const cves = await fetchLiveCves(80)
    expect(cves).toHaveLength(80)
    // Second call carries the first page's cursor.
    const secondUrl = String(fetchMock.mock.calls[1][0])
    expect(secondUrl).toContain('cursor=c1')
  })

  it('stops when the feed runs out before the limit', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(0, 30, 'c1'))
      .mockResolvedValueOnce(page(30, 10, null))
    vi.stubGlobal('fetch', fetchMock)
    const cves = await fetchLiveCves(100)
    expect(cves).toHaveLength(40)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('de-duplicates ids that repeat across pages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(0, 30, 'c1'))
      // Overlaps the first page by ten ids.
      .mockResolvedValueOnce(page(20, 30, null))
    vi.stubGlobal('fetch', fetchMock)
    const cves = await fetchLiveCves(100)
    expect(cves).toHaveLength(50)
    expect(new Set(cves.map((c) => c.id)).size).toBe(50)
  })

  it('throws when the first page fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 })
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchLiveCves(50)).rejects.toThrow('503')
  })

  it('keeps gathered entries when a later page fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(0, 30, 'c1'))
      .mockResolvedValueOnce({ ok: false, status: 500 })
    vi.stubGlobal('fetch', fetchMock)
    const cves = await fetchLiveCves(100)
    expect(cves).toHaveLength(30)
  })
})
