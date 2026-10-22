// Static catalog for the CVE Swarm security onboarding (?security=1). These are
// UI defaults only — the real authorization boundary is the GitHub App install
// the user connects, and the code-owned safety rails live in the deployed
// cve-swarm template. Nothing here widens scope; it only prefills the payload.

// The deployable template the security flow installs. Must be a public repo the
// template-installation backend can inspect.
export const SECURITY_SWARM_TEMPLATE_REPOSITORY =
  'https://github.com/diggerhq/opencomputer-example-cve-swarm'

// Default model for the swarm. GLM via the org's model-access connection.
export const DEFAULT_SWARM_MODEL = 'GLM-5.3'

// The document-memory resource the swarm writes its verdicts to. Must match the
// `defineMemory` id in the template (agents/cve-swarm/memory/findings.ts); the
// launch binds a per-run document under it so the run can persist findings.
export const SECURITY_FINDINGS_RESOURCE = 'cve-findings'

// The attestation the operator must accept before a scan can launch. Recorded
// with the run; the scan stays passive in code regardless.
export const SCAN_DECLARATION =
  'I declare that I own this web application and I am authorized to perform this penetration test.'

export type SeedCve = {
  readonly id: string
  readonly product: string
  readonly severity: 'critical' | 'high' | 'medium' | 'low'
  readonly cvss: number
}

// This week's feed, mirroring the launch page and the template's feed.ts. The
// payload builder opens with all of these pre-selected so a first swarm runs
// with zero typing.
export const SEED_CVES: readonly SeedCve[] = [
  {
    id: 'CVE-2026-109618',
    product: 'PHP2Shell',
    severity: 'critical',
    cvss: 9.8,
  },
  {
    id: 'CVE-2026-110264',
    product: 'GitLab CE/EE',
    severity: 'critical',
    cvss: 9.6,
  },
  {
    id: 'CVE-2026-96951',
    product: 'Windows Shell',
    severity: 'high',
    cvss: 8.1,
  },
  {
    id: 'CVE-2026-21445',
    product: 'Oracle Access Manager',
    severity: 'critical',
    cvss: 10.0,
  },
  {
    id: 'CVE-2026-21446',
    product: 'Oracle SOA Suite',
    severity: 'critical',
    cvss: 10.0,
  },
  {
    id: 'CVE-2026-21447',
    product: 'Oracle E-Business Suite',
    severity: 'critical',
    cvss: 10.0,
  },
]

export type SwarmPayload = {
  readonly target: string
  readonly declarationAccepted: boolean
  readonly repositories: readonly string[]
  readonly cveIds: readonly string[]
  readonly model: string
}

// A single unit of swarm work: one repository checked against one CVE. The
// launch fans the payload's repository × CVE matrix into one cell per pair, and
// starts one bound session for each so they run in parallel and each writes its
// own findings document.
export type SwarmCell = {
  readonly repository: string
  readonly cveId: string
}

// A cell once its session has been started: the launch pairs each cell with the
// session id `startManagedAgentSession` returns, so the grid can poll that
// session's liveness directly instead of discovering it by label.
export type LaunchedCell = {
  readonly cell: SwarmCell
  readonly sessionId: string
}

// Expand the payload into the matrix of cells. Fan-out needs explicit
// repositories and CVEs — the "all connected repositories" / "full feed"
// shorthands only make sense for the single-session controller, so a caller
// that means to fan out must resolve those to concrete lists first.
export function swarmCells(payload: SwarmPayload): SwarmCell[] {
  const cells: SwarmCell[] = []
  for (const repository of payload.repositories) {
    for (const cveId of payload.cveIds) {
      cells.push({ repository, cveId })
    }
  }
  return cells
}

// Reduce a free-form identifier to the characters a memory document id and a
// label value share safely: lower-case alphanumerics and dashes. Keeps the
// id/label stable and collision-resistant without depending on slash handling.
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// The per-cell findings document id, unique within the run. Each worker binds
// this document read-write and saves the one finding it proves; the reducer
// reads them all back as a collection.
export function cellDocumentId(runId: string, cell: SwarmCell): string {
  return `${runId}__${slug(cell.repository)}__${slug(cell.cveId)}`
}

// The launch records what it started as a run manifest, persisted as its own
// document under the findings resource so the swarm page can rebuild the grid
// after navigation or a reload (the session ids live in the manifest, not in
// React state). The `manifest__` prefix keeps it clear of the cell findings
// documents, whose ids are `<runId>__<repo>__<cve>`.
export const SWARM_MANIFEST_PREFIX = 'manifest__'

export function runManifestDocumentId(runId: string): string {
  return `${SWARM_MANIFEST_PREFIX}${runId}`
}

export type SwarmRunManifest = {
  readonly runId: string
  readonly model: string
  readonly target: string
  readonly cells: readonly LaunchedCell[]
}

export function serializeRunManifest(manifest: SwarmRunManifest): string {
  return JSON.stringify(manifest)
}

// Rebuild a manifest from its stored text. Returns null for anything that is
// not a well-formed manifest with at least one launched cell, so the swarm page
// can fall back to its empty state rather than render a broken grid.
export function parseRunManifest(text: string): SwarmRunManifest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.runId !== 'string' || !Array.isArray(obj.cells)) return null
  const cells: LaunchedCell[] = []
  for (const entry of obj.cells) {
    if (!entry || typeof entry !== 'object') return null
    const e = entry as Record<string, unknown>
    const cell = e.cell as Record<string, unknown> | undefined
    if (
      !cell ||
      typeof cell.repository !== 'string' ||
      typeof cell.cveId !== 'string' ||
      typeof e.sessionId !== 'string'
    ) {
      return null
    }
    cells.push({
      cell: { repository: cell.repository, cveId: cell.cveId },
      sessionId: e.sessionId,
    })
  }
  if (cells.length === 0) return null
  return {
    runId: obj.runId,
    model: typeof obj.model === 'string' ? obj.model : '',
    target: typeof obj.target === 'string' ? obj.target : '',
    cells,
  }
}

// From a page of findings-resource documents, the id of the most recently
// updated run manifest — the run the swarm page shows by default. Null when no
// swarm has run in the project yet.
export function latestManifestId(
  docs: readonly { id: string; updatedAt: string }[],
): string | null {
  const manifests = docs
    .filter((doc) => doc.id.startsWith(SWARM_MANIFEST_PREFIX))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return manifests[0]?.id ?? null
}

// One cell's first-run input: a single repository checked against a single CVE.
// The worker agent already collapses to a 1×1 matrix when the payload names one
// of each, so this is the launch prompt narrowed to the cell.
export function composeCellPrompt(payload: SwarmPayload, cell: SwarmCell): string {
  const lines = [
    'Launch a CVE swarm cell against my own assets.',
    '',
    `Declaration: ${SCAN_DECLARATION}`,
    payload.target
      ? `Target endpoint (passive scan only): ${payload.target}`
      : null,
    `Repository: ${cell.repository}`,
    `CVE: ${cell.cveId}`,
    `Model: ${payload.model}`,
    '',
    payload.target
      ? 'Run scan_surface on the target once to fingerprint it passively, then prove whether this CVE is reachable in this repository by reading the clone, then save the one finding with memory_save.'
      : 'Prove whether this CVE is reachable in this repository by reading the clone, then save the one finding with memory_save.',
    'If the verdict is EXPOSED, open_fix_pull_request (dependency-only, single pin). Honor PUBLISH_ENABLED — dry run unless it is enabled.',
  ].filter((line): line is string => line !== null)
  return lines.join('\n')
}

export type CveDisposition = 'exposed' | 'not-exposed' | 'needs-review'

export type CellFinding = {
  readonly disposition: CveDisposition
  readonly reasoning?: string
  readonly pullRequest?: string
}

// Read the one finding a cell worker saved to its findings document. The worker
// writes { summary, findings: [...] }; a 1×1 cell has a single finding, which
// is the cell's verdict. Returns null while the document is still the empty
// placeholder (the worker has not saved yet) or if the text is not the expected
// shape — the grid treats both as "no verdict yet".
export function parseCellFinding(text: string): CellFinding | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const findings = (parsed as { findings?: unknown }).findings
  if (!Array.isArray(findings) || findings.length === 0) return null
  const first: unknown = (findings as unknown[])[0]
  if (!first || typeof first !== 'object') return null
  const disposition = (first as { disposition?: unknown }).disposition
  if (
    disposition !== 'exposed' &&
    disposition !== 'not-exposed' &&
    disposition !== 'needs-review'
  ) {
    return null
  }
  const reasoning = (first as { reasoning?: unknown }).reasoning
  const pullRequest = (first as { pullRequest?: unknown }).pullRequest
  return {
    disposition,
    ...(typeof reasoning === 'string' ? { reasoning } : {}),
    ...(typeof pullRequest === 'string' && pullRequest ? { pullRequest } : {}),
  }
}

// The run report: the swarm's one artifact, rolled up from every cell's verdict
// once the grid has settled. It is computed client-side from the findings the
// cells already saved (Tier 1 — no reducer agent), then persisted as its own
// document so a scheduled run leaves something behind and the aggregator view
// has a real source. The `report__` prefix keeps it clear of manifests
// (`manifest__`) and cell findings (`<runId>__<repo>__<cve>`).
export const SWARM_REPORT_PREFIX = 'report__'

export function runReportDocumentId(runId: string): string {
  return `${SWARM_REPORT_PREFIX}${runId}`
}

// A cell as it appears in the report: its verdict resolved, including `failed`
// for a cell whose session stopped without saving one.
export type ReportDisposition = CveDisposition | 'failed'

export type ReportCell = {
  readonly repository: string
  readonly cveId: string
  readonly disposition: ReportDisposition
  readonly reasoning?: string
  readonly pullRequest?: string
}

export type SwarmReportCounts = {
  readonly exposed: number
  readonly notExposed: number
  readonly needsReview: number
  readonly failed: number
  readonly fixPrs: number
  readonly total: number
}

export type SwarmRunReport = {
  readonly runId: string
  readonly target: string
  readonly model: string
  readonly generatedAt: string
  readonly counts: SwarmReportCounts
  // Ordered most-actionable first: exposed, needs-review, failed, not-exposed.
  readonly cells: readonly ReportCell[]
}

const REPORT_ORDER: Record<ReportDisposition, number> = {
  exposed: 0,
  'needs-review': 1,
  failed: 2,
  'not-exposed': 3,
}

// Roll resolved cells into a report. Counts are derived here so a caller cannot
// desync them from the cells; cells are sorted most-actionable first.
export function buildRunReport(
  meta: { runId: string; target: string; model: string; generatedAt: string },
  cells: readonly ReportCell[],
): SwarmRunReport {
  const counts: SwarmReportCounts = {
    exposed: cells.filter((c) => c.disposition === 'exposed').length,
    notExposed: cells.filter((c) => c.disposition === 'not-exposed').length,
    needsReview: cells.filter((c) => c.disposition === 'needs-review').length,
    failed: cells.filter((c) => c.disposition === 'failed').length,
    fixPrs: cells.filter((c) => Boolean(c.pullRequest)).length,
    total: cells.length,
  }
  const sorted = [...cells].sort(
    (a, b) =>
      REPORT_ORDER[a.disposition] - REPORT_ORDER[b.disposition] ||
      a.repository.localeCompare(b.repository) ||
      a.cveId.localeCompare(b.cveId),
  )
  return { ...meta, counts, cells: sorted }
}

export function serializeRunReport(report: SwarmRunReport): string {
  return JSON.stringify(report)
}

// Compose the controller's first-run input from the payload. This is exactly
// what the swarm agent receives as its opening instruction when the session
// starts — the scan → prove → report pipeline, with fixes gated by the
// template's PUBLISH_ENABLED (dry run by default).
export function composeLaunchPrompt(payload: SwarmPayload): string {
  const repos =
    payload.repositories.length > 0
      ? payload.repositories.join(', ')
      : 'all connected repositories'
  const cves =
    payload.cveIds.length > 0
      ? payload.cveIds.join(', ')
      : "this week's full feed"
  const lines = [
    'Launch a CVE swarm against my own assets.',
    '',
    `Declaration: ${SCAN_DECLARATION}`,
    payload.target
      ? `Target endpoint (passive scan only): ${payload.target}`
      : null,
    `Repositories: ${repos}`,
    `CVEs: ${cves}`,
    `Model: ${payload.model}`,
    '',
    payload.target
      ? 'Run scan_surface on the target to fingerprint it passively, then prove reachability across the repository × CVE matrix by reading each clone, then save the findings once with memory_save.'
      : 'Prove reachability across the repository × CVE matrix by reading each clone, then save the findings once with memory_save.',
    'For any EXPOSED verdict, open_fix_pull_request (dependency-only, single pin). Honor PUBLISH_ENABLED — dry run unless it is enabled.',
  ].filter((line): line is string => line !== null)
  return lines.join('\n')
}
