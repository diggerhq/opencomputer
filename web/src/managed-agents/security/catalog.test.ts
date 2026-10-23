import { describe, expect, it } from 'vitest'
import {
  buildRunReport,
  cellDocumentId,
  composeCellPrompt,
  latestManifestId,
  listManifestDocs,
  manifestSettling,
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
  it('expands into one cell per CVE, every repo shared as evidence', () => {
    expect(swarmCells(payload)).toEqual([
      { cveId: 'CVE-2026-1', repositories: ['acme/web', 'acme/api'] },
      { cveId: 'CVE-2026-2', repositories: ['acme/web', 'acme/api'] },
    ])
  })

  it('is empty only when there are no CVEs to hunt', () => {
    expect(swarmCells({ ...payload, cveIds: [] })).toEqual([])
    // No repos is still a swarm — the CVEs just have no evidence to lean on.
    expect(swarmCells({ ...payload, repositories: [] })).toEqual([
      { cveId: 'CVE-2026-1', repositories: [] },
      { cveId: 'CVE-2026-2', repositories: [] },
    ])
  })

  it('builds a stable, slash-free document id unique per CVE', () => {
    const run = 'run-abc'
    const first = cellDocumentId(run, {
      cveId: 'CVE-2026-1',
      repositories: ['acme/web'],
    })
    const second = cellDocumentId(run, {
      cveId: 'CVE-2026-2',
      repositories: ['acme/api'],
    })
    expect(first).toBe('run-abc__cve-2026-1')
    expect(first).not.toContain('/')
    expect(first).not.toBe(second)
  })

  it('names the cell CVE and every repo as shared evidence', () => {
    const prompt = composeCellPrompt(payload, {
      cveId: 'CVE-2026-1',
      repositories: ['acme/web', 'acme/api'],
    })
    expect(prompt).toContain('Your CVE to hunt: CVE-2026-1')
    expect(prompt).toContain('acme/web')
    // Every repo is shared evidence now, not a per-cell narrowing.
    expect(prompt).toContain('acme/api')
    expect(prompt).toContain('scan_surface')
  })

  it('seeds the cell with live feeds and keeps probing scoped to the target', () => {
    const prompt = composeCellPrompt(payload, {
      cveId: 'CVE-2026-1',
      repositories: ['acme/web'],
    })
    expect(prompt).toContain('cve.now')
    expect(prompt).toContain('pwn.watch')
    expect(prompt).toContain('/workspace')
    // Probing is pinned to the attested host, named explicitly.
    expect(prompt).toContain('Stay on https://app.example.com')
    // The cell is told the preinstalled browser exists, not left to discover it.
    expect(prompt).toContain('headless Chromium is preinstalled')
    expect(prompt).toContain('playwright')
  })

  it('drops target-only discovery steps when no target is given', () => {
    const prompt = composeCellPrompt(
      { ...payload, target: '' },
      { cveId: 'CVE-2026-1', repositories: ['acme/web'] },
    )
    expect(prompt).not.toContain('scan_surface')
    expect(prompt).toContain('reachable in your code')
  })

  it('tells the cell to log in when the scan is authenticated', () => {
    const prompt = composeCellPrompt(
      { ...payload, authenticated: true, loginUrl: 'https://app.example.com/login' },
      { cveId: 'CVE-2026-1', repositories: ['acme/web'] },
    )
    // Reads the creds from the environment, never carries them.
    expect(prompt).toContain('SWARM_LOGIN_USERNAME')
    expect(prompt).toContain('SWARM_LOGIN_PASSWORD')
    expect(prompt).toContain('https://app.example.com/login')
    expect(prompt).toContain('--no-sandbox')
  })

  it('says nothing about logging in for an unauthenticated scan', () => {
    const prompt = composeCellPrompt(payload, {
      cveId: 'CVE-2026-1',
      repositories: ['acme/web'],
    })
    expect(prompt).not.toContain('SWARM_LOGIN_USERNAME')
    expect(prompt).not.toContain('log in')
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
      {
        cell: { cveId: 'CVE-2026-1', repositories: ['acme/web', 'acme/api'] },
        sessionId: 's1',
        launch: 'started',
      },
      {
        cell: { cveId: 'CVE-2026-2', repositories: ['acme/web', 'acme/api'] },
        sessionId: 's2',
        launch: 'started',
      },
    ],
  }

  it('keeps the manifest document clear of cell findings documents', () => {
    expect(runManifestDocumentId('run-abc')).toBe('manifest__run-abc')
    expect(runManifestDocumentId('run-abc')).not.toBe(
      cellDocumentId('run-abc', {
        cveId: 'CVE-2026-1',
        repositories: ['acme/web'],
      }),
    )
  })

  it('round-trips through serialize and parse', () => {
    expect(parseRunManifest(serializeRunManifest(manifest))).toEqual(manifest)
  })

  it('defaults launch for a pre-incremental manifest: started with an id, else starting', () => {
    const parsed = parseRunManifest(
      JSON.stringify({
        runId: 'run-old',
        cells: [
          { cell: { repository: 'a/b', cveId: 'CVE-1' }, sessionId: 's1' },
          { cell: { repository: 'a/c', cveId: 'CVE-1' }, sessionId: '' },
        ],
      }),
    )
    expect(parsed?.cells.map((c) => c.launch)).toEqual(['started', 'starting'])
  })

  it('is settling while any cell is still starting, and not once all have an outcome', () => {
    const starting: SwarmRunManifest = {
      ...manifest,
      cells: [
        { ...manifest.cells[0], sessionId: '', launch: 'starting' },
        manifest.cells[1],
      ],
    }
    expect(manifestSettling(starting)).toBe(true)
    expect(manifestSettling(manifest)).toBe(false)
    expect(
      manifestSettling({
        ...manifest,
        cells: [
          { ...manifest.cells[0], sessionId: '', launch: 'failed' },
          manifest.cells[1],
        ],
      }),
    ).toBe(false)
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

  it('lists every manifest newest first, ignoring findings and report docs', () => {
    const docs = [
      { id: 'run-a__acme-web__cve-1', updatedAt: '2026-10-22T13:00:00Z' },
      { id: 'manifest__run-a', updatedAt: '2026-10-22T09:00:00Z' },
      { id: 'report__run-a', updatedAt: '2026-10-22T14:00:00Z' },
      { id: 'manifest__run-b', updatedAt: '2026-10-22T12:00:00Z' },
    ]
    expect(listManifestDocs(docs).map((d) => d.id)).toEqual([
      'manifest__run-b',
      'manifest__run-a',
    ])
  })
})

describe('run report', () => {
  const cells: ReportCell[] = [
    { cveId: 'CVE-2026-9', disposition: 'not-exposed' },
    {
      cveId: 'CVE-2026-2',
      disposition: 'exposed',
      reasoning: 'vulnerable version in lockfile',
      pullRequest: 'https://github.com/acme/api/pull/7',
    },
    { cveId: 'CVE-2026-5', disposition: 'failed' },
    { cveId: 'CVE-2026-3', disposition: 'needs-review' },
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
