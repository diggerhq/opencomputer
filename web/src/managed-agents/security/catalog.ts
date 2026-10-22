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
// starts one bound, labelled session for each so they run in parallel and each
// writes its own findings document.
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
