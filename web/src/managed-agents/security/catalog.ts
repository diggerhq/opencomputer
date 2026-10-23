// Static catalog for the CVE Swarm security onboarding (?security=1). These are
// UI defaults only — the real authorization boundary is the GitHub App install
// the user connects, and the code-owned safety rails live in the deployed
// cve-swarm template. Nothing here widens scope; it only prefills the payload.

import { assignAngles, feedSeedingLines } from './feeds'

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

export type SwarmPayload = {
  readonly target: string
  readonly declarationAccepted: boolean
  readonly repositories: readonly string[]
  readonly cveIds: readonly string[]
  readonly model: string
  // Authenticated discovery. These two are non-secret: a flag that a login is
  // required, and the page to log in on. The throwaway account's actual username
  // and password NEVER travel in the payload — they would land in the cell
  // prompt and the run manifest, both of which are stored. They go to the
  // project's encrypted runtime variables instead (SWARM_LOGIN_*), and the cell
  // reads them from its environment at run time.
  readonly authenticated?: boolean
  readonly loginUrl?: string
}

// Encrypted runtime-variable names the onboarding writes and every cell reads
// from its environment to log in. Shared here so the writer and the prompt that
// tells the agent to read them can never drift apart.
export const SWARM_LOGIN_USERNAME_VAR = 'SWARM_LOGIN_USERNAME'
export const SWARM_LOGIN_PASSWORD_VAR = 'SWARM_LOGIN_PASSWORD'

// A single unit of swarm work: one agent hunting one CVE against the target,
// with every connected repository available to it as evidence. The launch starts
// one bound session per CVE so they run in parallel and each writes its own
// findings document. Repos are shared context, not a fan-out dimension — a cell
// carries the full list, not a single repo.
export type SwarmCell = {
  readonly cveId: string
  readonly repositories: readonly string[]
}

// Where a cell is in the launch itself, before any agent work. The launch writes
// the manifest instantly with every cell `starting`, navigates, then boots the
// sandboxes in the background and flips each to `started` (with its session id)
// or `failed` as it resolves. So the run page is reachable in one write instead
// of blocking on every sandbox.
export type CellLaunchStatus = 'starting' | 'started' | 'failed'

// A cell in the run manifest: paired with the session id
// `startManagedAgentSession` returns once it is booted, so the grid can poll that
// session's liveness directly instead of discovering it by label. `sessionId` is
// empty until the cell reaches `started`.
export type LaunchedCell = {
  readonly cell: SwarmCell
  readonly sessionId: string
  readonly launch: CellLaunchStatus
}

// One cell per CVE, each carrying all the repos as shared evidence. Fan-out needs
// an explicit CVE list — the "full feed" shorthand only makes sense for the
// single-session controller, so a caller that means to fan out must resolve it to
// a concrete list first. Repos ride along as context and no longer multiply the
// count, so the cell total is exactly the number of CVEs.
export function swarmCells(payload: SwarmPayload): SwarmCell[] {
  return payload.cveIds.map((cveId) => ({
    cveId,
    repositories: payload.repositories,
  }))
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
  return `${runId}__${slug(cell.cveId)}`
}

// The launch records what it started as a run manifest, persisted as its own
// document under the findings resource so the swarm page can rebuild the grid
// after navigation or a reload (the session ids live in the manifest, not in
// React state). The `manifest__` prefix keeps it clear of the cell findings
// documents, whose ids are `<runId>__<cve>`.
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
    if (!cell || typeof cell.cveId !== 'string' || typeof e.sessionId !== 'string') {
      return null
    }
    // Repos are shared context on the cell. Back-compat: a manifest from the old
    // repo×CVE model carried a single `repository` string instead of a list.
    const repositories = Array.isArray(cell.repositories)
      ? cell.repositories.filter((r): r is string => typeof r === 'string')
      : typeof cell.repository === 'string'
        ? [cell.repository]
        : []
    // Back-compat: a manifest written before incremental launch has no `launch`
    // field — a cell there with a session id is already `started`.
    const launch: CellLaunchStatus =
      e.launch === 'starting' || e.launch === 'started' || e.launch === 'failed'
        ? e.launch
        : e.sessionId
          ? 'started'
          : 'starting'
    cells.push({
      cell: { cveId: cell.cveId, repositories },
      sessionId: e.sessionId,
      launch,
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

// True while any cell is still booting its sandbox — the run page keeps polling
// the manifest until every cell has started or failed, so session ids appear as
// they come up.
export function manifestSettling(manifest: SwarmRunManifest): boolean {
  return manifest.cells.some((c) => c.launch === 'starting')
}

// From a page of findings-resource documents, the id of the most recently
// updated run manifest — the run the swarm page shows by default. Null when no
// swarm has run in the project yet.
export function latestManifestId(
  docs: readonly { id: string; updatedAt: string }[],
): string | null {
  return listManifestDocs(docs)[0]?.id ?? null
}

// Every run manifest in a page of findings-resource documents, newest first.
// The Swarms index reads one row per manifest; cell findings and report docs
// (which share the resource) are filtered out by prefix.
export function listManifestDocs(
  docs: readonly { id: string; updatedAt: string }[],
): { id: string; updatedAt: string }[] {
  return docs
    .filter((doc) => doc.id.startsWith(SWARM_MANIFEST_PREFIX))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

// How a cell turns the repository into a live hunt once it has fingerprinted the
// target. Shared by the cell and launch prompts so "derive routes, probe, keep
// evidence" reads identically everywhere. Scoped hard to the attested host — the
// authorization boundary is the operator's ownership declaration, so probing
// must never leave that one target.
export function discoveryLines(target: string): string[] {
  if (!target) {
    return [
      'Read the repository clones to prove whether this CVE is reachable in your code, then save the finding with memory_save.',
    ]
  }
  return [
    'Discover, do not just read:',
    '- Read the repository clones to derive their real routes, parameters and auth flows — that map is what you probe.',
    `- Fingerprint ${target} with scan_surface, then exercise the mapped routes on that host to prove whether the exposure is actually reachable. Stay on ${target}; never touch another host.`,
    '- A headless Chromium is preinstalled in the sandbox: `npm i playwright` (the browser is already downloaded), then drive it to load pages, reach client-side routes and capture screenshots.',
    '- Record evidence into /workspace as you go (request/response logs, screenshots, a finding.md) so the proof outlives the session.',
    '- Save the finding with memory_save.',
  ]
}

// One cell's first-run input. Each cell owns one CVE and hunts it against the
// target with every connected repository available as evidence: pull live feed
// intelligence, derive the repos' routes, probe the attested target, and keep
// evidence.
// When the operator supplied a throwaway test account, tell the cell to log in
// first and scan behind the auth wall. The credentials themselves are NOT here —
// they are in the environment as encrypted runtime variables; the prompt only
// names them so the agent reads them itself. Empty when the scan is unauthenticated.
function authenticatedLoginLines(payload: SwarmPayload): string[] {
  if (!payload.authenticated) return []
  const where = payload.loginUrl
    ? `the login page ${payload.loginUrl}`
    : "the target's login page"
  return [
    `This target requires a login, and a throwaway test account has been provisioned for you. Its credentials are in the environment variables ${SWARM_LOGIN_USERNAME_VAR} and ${SWARM_LOGIN_PASSWORD_VAR}. Before anything else, drive the preinstalled headless browser (Playwright, launched with --no-sandbox) to ${where}, sign in with those credentials, and save the authenticated session (storageState / cookies). Reuse that session for every page load, API call and scanner request so all discovery runs as the logged-in account. Treat the account as disposable and in-scope: exercise the app and its API to find vulnerabilities, but stay within this host. Never print the credentials or copy them into findings, logs or a pull request.`,
    '',
  ]
}

export function composeCellPrompt(payload: SwarmPayload, cell: SwarmCell): string {
  const lines = [
    'Launch a CVE swarm cell against my own assets.',
    '',
    `Declaration: ${SCAN_DECLARATION}`,
    payload.target
      ? `Target (authorized discovery within this host only): ${payload.target}`
      : null,
    `Your CVE to hunt: ${cell.cveId}`,
    cell.repositories.length > 0
      ? `Repositories available as evidence (investigate across all of them): ${cell.repositories.join(', ')}`
      : null,
    `Model: ${payload.model}`,
    '',
    ...feedSeedingLines(),
    '',
    ...authenticatedLoginLines(payload),
    ...discoveryLines(payload.target),
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
// (`manifest__`) and cell findings (`<runId>__<cve>`).
export const SWARM_REPORT_PREFIX = 'report__'

export function runReportDocumentId(runId: string): string {
  return `${SWARM_REPORT_PREFIX}${runId}`
}

// A cell as it appears in the report: its verdict resolved, including `failed`
// for a cell whose session stopped without saving one.
export type ReportDisposition = CveDisposition | 'failed'

export type ReportCell = {
  readonly cveId: string
  readonly disposition: ReportDisposition
  readonly reasoning?: string
  readonly pullRequest?: string
  // The cell's session, carried so a persisted report can still link each row
  // (especially a failed one) back to what the agent did.
  readonly sessionId?: string
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
      a.cveId.localeCompare(b.cveId),
  )
  return { ...meta, counts, cells: sorted }
}

export function serializeRunReport(report: SwarmRunReport): string {
  return JSON.stringify(report)
}

const REPORT_DISPOSITIONS: readonly ReportDisposition[] = [
  'exposed',
  'not-exposed',
  'needs-review',
  'failed',
]

// Read a persisted report back. Returns null for anything malformed so the
// caller falls back to recomputing the run live. A valid report lets the run
// page render without polling every cell's session (which would wake each one).
export function parseRunReport(text: string): SwarmRunReport | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.runId !== 'string' || !Array.isArray(obj.cells)) return null
  const cells: ReportCell[] = []
  for (const entry of obj.cells) {
    if (!entry || typeof entry !== 'object') return null
    const e = entry as Record<string, unknown>
    if (
      typeof e.cveId !== 'string' ||
      typeof e.disposition !== 'string' ||
      !REPORT_DISPOSITIONS.includes(e.disposition as ReportDisposition)
    ) {
      return null
    }
    cells.push({
      cveId: e.cveId,
      disposition: e.disposition as ReportDisposition,
      ...(typeof e.reasoning === 'string' ? { reasoning: e.reasoning } : {}),
      ...(typeof e.pullRequest === 'string'
        ? { pullRequest: e.pullRequest }
        : {}),
      ...(typeof e.sessionId === 'string' ? { sessionId: e.sessionId } : {}),
    })
  }
  if (cells.length === 0) return null
  return buildRunReport(
    {
      runId: obj.runId,
      target: typeof obj.target === 'string' ? obj.target : '',
      model: typeof obj.model === 'string' ? obj.model : '',
      generatedAt:
        typeof obj.generatedAt === 'string' ? obj.generatedAt : '',
    },
    cells,
  )
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
  const angles = assignAngles(Math.max(payload.repositories.length, 1))
    .map((a) => a.label)
    .join(', ')
  const lines = [
    'Launch a CVE swarm against my own assets.',
    '',
    `Declaration: ${SCAN_DECLARATION}`,
    payload.target
      ? `Target (authorized discovery within this host only): ${payload.target}`
      : null,
    `Repositories: ${repos}`,
    `CVE seeds: ${cves}`,
    `Discovery angles to spread across the swarm: ${angles}`,
    `Model: ${payload.model}`,
    '',
    ...feedSeedingLines(),
    '',
    ...discoveryLines(payload.target),
    'For any EXPOSED verdict, open_fix_pull_request (dependency-only, single pin). Honor PUBLISH_ENABLED — dry run unless it is enabled.',
  ].filter((line): line is string => line !== null)
  return lines.join('\n')
}
