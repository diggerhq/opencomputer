import { describe, expect, it } from 'vitest'
import {
  buildRunReport,
  cellDocumentId,
  composeCellPrompt,
  latestManifestId,
  parseCellFinding,
  parseRunManifest,
  runManifestDocumentId,
  runReportDocumentId,
  serializeRunManifest,
  swarmCells,
  type ReportCell,
  type SwarmPayload,
  type SwarmRunManifest,
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

describe('run manifest', () => {
  const manifest: SwarmRunManifest = {
    runId: 'run-abc',
    model: 'GLM-5.3',
    target: 'https://app.example.com',
    cells: [
      { cell: { repository: 'acme/web', cveId: 'CVE-2026-1' }, sessionId: 's1' },
      { cell: { repository: 'acme/api', cveId: 'CVE-2026-1' }, sessionId: 's2' },
    ],
  }

  it('keeps the manifest document clear of cell findings documents', () => {
    expect(runManifestDocumentId('run-abc')).toBe('manifest__run-abc')
    expect(runManifestDocumentId('run-abc')).not.toBe(
      cellDocumentId('run-abc', { repository: 'acme/web', cveId: 'CVE-2026-1' }),
    )
  })

  it('round-trips through serialize and parse', () => {
    expect(parseRunManifest(serializeRunManifest(manifest))).toEqual(manifest)
  })

  it('rejects malformed or empty manifests', () => {
    expect(parseRunManifest('not json')).toBeNull()
    expect(parseRunManifest('{}')).toBeNull()
    expect(parseRunManifest(JSON.stringify({ runId: 'r', cells: [] }))).toBeNull()
    expect(
      parseRunManifest(
        JSON.stringify({ runId: 'r', cells: [{ cell: { repository: 'a/b' } }] }),
      ),
    ).toBeNull()
  })

  it('picks the most recently updated manifest, ignoring findings docs', () => {
    const latest = latestManifestId([
      { id: 'run-old__acme-web__cve-2026-1', updatedAt: '2026-10-22T10:00:00Z' },
      { id: 'manifest__run-old', updatedAt: '2026-10-22T09:00:00Z' },
      { id: 'manifest__run-new', updatedAt: '2026-10-22T12:00:00Z' },
    ])
    expect(latest).toBe('manifest__run-new')
  })

  it('returns null when no manifest has been written', () => {
    expect(
      latestManifestId([
        { id: 'run-x__acme-web__cve-1', updatedAt: '2026-10-22T10:00:00Z' },
      ]),
    ).toBeNull()
  })
})

describe('run report', () => {
  const cells: ReportCell[] = [
    { repository: 'acme/web', cveId: 'CVE-2026-9', disposition: 'not-exposed' },
    {
      repository: 'acme/api',
      cveId: 'CVE-2026-2',
      disposition: 'exposed',
      reasoning: 'vulnerable version in lockfile',
      pullRequest: 'https://github.com/acme/api/pull/7',
    },
    { repository: 'acme/db', cveId: 'CVE-2026-5', disposition: 'failed' },
    { repository: 'acme/ui', cveId: 'CVE-2026-3', disposition: 'needs-review' },
  ]
  const meta = {
    runId: 'run-abc',
    target: 'https://app.example.com',
    model: 'GLM-5.3',
    generatedAt: '2026-10-22T12:00:00Z',
  }

  it('keeps the report document clear of manifests and findings', () => {
    expect(runReportDocumentId('run-abc')).toBe('report__run-abc')
    expect(runReportDocumentId('run-abc')).not.toBe(
      runManifestDocumentId('run-abc'),
    )
  })

  it('derives counts from the cells', () => {
    const report = buildRunReport(meta, cells)
    expect(report.counts).toEqual({
      exposed: 1,
      notExposed: 1,
      needsReview: 1,
      failed: 1,
      fixPrs: 1,
      total: 4,
    })
  })

  it('ranks cells exposed → needs-review → failed → not-exposed', () => {
    const report = buildRunReport(meta, cells)
    expect(report.cells.map((c) => c.disposition)).toEqual([
      'exposed',
      'needs-review',
      'failed',
      'not-exposed',
    ])
  })

  it('carries the run metadata through', () => {
    const report = buildRunReport(meta, cells)
    expect(report.runId).toBe('run-abc')
    expect(report.target).toBe('https://app.example.com')
    expect(report.model).toBe('GLM-5.3')
    expect(report.generatedAt).toBe('2026-10-22T12:00:00Z')
  })
})
