import { describe, expect, it } from 'vitest'
import {
  cellDocumentId,
  composeCellPrompt,
  parseCellFinding,
  swarmCells,
  type SwarmPayload,
} from './catalog'

const payload: SwarmPayload = {
  target: 'https://app.example.com',
  declarationAccepted: true,
  repositories: ['acme/web', 'acme/api'],
  cveIds: ['CVE-2026-1', 'CVE-2026-2'],
  model: 'GLM-5.3',
}

describe('swarm fan-out', () => {
  it('expands the repository × CVE matrix into one cell per pair', () => {
    expect(swarmCells(payload)).toEqual([
      { repository: 'acme/web', cveId: 'CVE-2026-1' },
      { repository: 'acme/web', cveId: 'CVE-2026-2' },
      { repository: 'acme/api', cveId: 'CVE-2026-1' },
      { repository: 'acme/api', cveId: 'CVE-2026-2' },
    ])
  })

  it('is empty when either dimension is empty', () => {
    expect(swarmCells({ ...payload, repositories: [] })).toEqual([])
    expect(swarmCells({ ...payload, cveIds: [] })).toEqual([])
  })

  it('builds a stable, slash-free document id unique per cell', () => {
    const run = 'run-abc'
    const first = cellDocumentId(run, { repository: 'acme/web', cveId: 'CVE-2026-1' })
    const second = cellDocumentId(run, { repository: 'acme/api', cveId: 'CVE-2026-1' })
    expect(first).toBe('run-abc__acme-web__cve-2026-1')
    expect(first).not.toContain('/')
    expect(first).not.toBe(second)
  })

  it('narrows the prompt to a single repository and CVE', () => {
    const prompt = composeCellPrompt(payload, {
      repository: 'acme/web',
      cveId: 'CVE-2026-1',
    })
    expect(prompt).toContain('Repository: acme/web')
    expect(prompt).toContain('CVE: CVE-2026-1')
    expect(prompt).toContain('scan_surface')
    expect(prompt).not.toContain('acme/api')
  })
})

describe('parseCellFinding', () => {
  it('returns null for the empty placeholder', () => {
    expect(parseCellFinding('{}')).toBeNull()
    expect(parseCellFinding('')).toBeNull()
    expect(parseCellFinding('not json')).toBeNull()
  })

  it('reads the first finding as the cell verdict', () => {
    const text = JSON.stringify({
      summary: { exposed: 1, notExposed: 0, needsReview: 0 },
      findings: [
        {
          repository: 'acme/web',
          cve: 'CVE-2026-1',
          disposition: 'exposed',
          reasoning: 'Pinned in lockfile and served.',
          pullRequest: 'https://github.com/acme/web/pull/7',
        },
      ],
    })
    expect(parseCellFinding(text)).toEqual({
      disposition: 'exposed',
      reasoning: 'Pinned in lockfile and served.',
      pullRequest: 'https://github.com/acme/web/pull/7',
    })
  })

  it('rejects an unknown disposition', () => {
    const text = JSON.stringify({ findings: [{ disposition: 'maybe' }] })
    expect(parseCellFinding(text)).toBeNull()
  })

  it('omits an empty pull request', () => {
    const text = JSON.stringify({
      findings: [{ disposition: 'not-exposed', reasoning: 'Not installed.' }],
    })
    expect(parseCellFinding(text)).toEqual({
      disposition: 'not-exposed',
      reasoning: 'Not installed.',
    })
  })
})
