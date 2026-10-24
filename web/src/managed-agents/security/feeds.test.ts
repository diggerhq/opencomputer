import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DISCOVERY_ANGLES,
  SWARM_FEEDS,
  assignAngles,
  fetchLiveCves,
  feedSeedingLines,
} from './feeds'

// A page of the cve.now entries API: `count` synthetic entries with descending
// CVSS so order is observable, plus the next cursor (null ends the walk).
function page(start: number, count: number, nextCursor: string | null) {
  const entries = Array.from({ length: count }, (_, i) => {
    const n = start + i
    return {
      id: `CVE-2026-${1000 + n}`,
      title: `Synthetic ${n}`,
      cvss: Math.max(0, 9 - n * 0.1),
      statedSeverity: null,
      kev: false,
      firstSeenAt: '2026-10-23T00:00:00.000Z',
    }
  })
  return { ok: true, json: () => Promise.resolve({ entries, nextCursor }) }
}

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

  it('follows nextCursor across pages to reach the requested limit', async () => {
    // Each page serves only 30, so a top-50 pull must walk two pages.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(0, 30, 'cursor-1'))
      .mockResolvedValueOnce(page(30, 30, 'cursor-2'))
    vi.stubGlobal('fetch', fetchMock)

    const cves = await fetchLiveCves(50)

    expect(cves).toHaveLength(50)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The second request carries the first page's cursor.
    expect(String(fetchMock.mock.calls[1][0])).toContain('cursor=cursor-1')
  })

  it('stops when the feed runs out before the limit', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(0, 30, 'cursor-1'))
      .mockResolvedValueOnce(page(30, 10, null))
    vi.stubGlobal('fetch', fetchMock)

    const cves = await fetchLiveCves(100)

    expect(cves).toHaveLength(40)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('de-duplicates ids that repeat across pages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(0, 30, 'cursor-1'))
      // Same slice again, then the walk ends — the overlap must not double-count.
      .mockResolvedValueOnce(page(0, 30, null))
    vi.stubGlobal('fetch', fetchMock)

    const cves = await fetchLiveCves(100)

    expect(cves).toHaveLength(30)
    expect(new Set(cves.map((c) => c.id)).size).toBe(30)
  })

  it('throws when the first page fails so the UI can retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    await expect(fetchLiveCves(50)).rejects.toThrow('503')
  })

  it('keeps the entries gathered so far when a later page fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(0, 30, 'cursor-1'))
      .mockResolvedValueOnce({ ok: false, status: 500 })
    vi.stubGlobal('fetch', fetchMock)

    const cves = await fetchLiveCves(100)

    expect(cves).toHaveLength(30)
  })
})
