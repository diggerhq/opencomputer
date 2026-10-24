// Live vulnerability feeds and the discovery-angle model for the CVE Swarm.
//
// These are the real, public endpoints the swarm seeds from. Nothing here is a
// credential or a scope grant — they are read-only intelligence sources the
// cell agents can reach over the sandbox's open egress with a plain `curl`.
// The swarm uses them for two jobs:
//   1. Seed each cell with *current* vulnerability intelligence (what is being
//      exploited this week), so the hunt stays fresh without a code change.
//   2. Match a repository's dependency manifest to the CVEs that actually apply
//      to it, so a cell targets real exposure instead of guessing.
//
// Both feeds are agent-native: each publishes an `llms.txt` describing itself,
// and cve.now additionally runs an MCP server whose `check_stack` tool maps a
// lockfile to applicable advisories. We prefer the plain JSON endpoints for the
// payload because they work today with zero client dependencies; the MCP path
// is the precise upgrade once the template wires an MCP client.

export type VulnerabilityFeed = {
  readonly id: string
  readonly label: string
  // One line on what the feed is good for, surfaced in the payload so the agent
  // knows why it is being pointed at this source.
  readonly purpose: string
  // The zero-dependency JSON endpoint a cell can curl directly.
  readonly json: string
  // Human/RSS entry point, kept for the UI and for operators.
  readonly rss: string
}

// cve.now — merges CVE List, GHSA, OSV, NVD, CISA KEV, EPSS and Exploit-DB into
// one enriched entry per vulnerability. The enrichment (EPSS exploit
// probability, KEV known-exploited status) is what lets a cell prioritise.
export const CVE_NOW: VulnerabilityFeed = {
  id: 'cve.now',
  label: 'cve.now',
  purpose:
    'Enriched per-CVE intelligence (EPSS, CISA KEV, CWE) merged from CVE List, GHSA, OSV, NVD and Exploit-DB.',
  json: 'https://cve.now/feed?format=json',
  rss: 'https://cve.now/feed',
}

// pwn.watch — live incident tracker (Patch-now / Breaches / Supply-chain) with
// CVE ids, patch status and KEV flags. This is the "what is hot right now"
// pulse that keeps the swarm weighted toward active threats.
export const PWN_WATCH: VulnerabilityFeed = {
  id: 'pwn.watch',
  label: 'pwn.watch',
  purpose:
    'Live security-incident pulse: what is being exploited, patched or supply-chain-compromised this week.',
  json: 'https://pwn.watch/incidents.json',
  rss: 'https://pwn.watch/all/feed.xml',
}

export const SWARM_FEEDS: readonly VulnerabilityFeed[] = [CVE_NOW, PWN_WATCH]

// cve.now's newest-first entries endpoint (cursor-paginated). A cell curls this
// to pull the current feed slice for its angle, and the onboarding UI fetches it
// directly to present a live, severity-sorted list to pick from (the endpoint
// sends `access-control-allow-origin: *`, so the browser can call it).
export const CVE_NOW_ENTRIES_API = 'https://cve.now/api/v1/entries'

// One entry from the cve.now entries API, as the swarm consumes it. The upstream
// shape is wider; we read only the fields that drive severity ranking and the
// picker label.
export type FeedCve = {
  readonly id: string
  readonly title: string
  // CVSS base score 0–10 when the entry carries one, else null.
  readonly cvss: number | null
  // Qualitative band as stated upstream: 'low' | 'medium' | 'high' | 'critical'
  // (or null when unscored). Kept as the raw string; `severityRank` normalises.
  readonly statedSeverity: string | null
  // CISA Known-Exploited flag — the strongest "fix this now" signal there is.
  readonly kev: boolean
  // ISO timestamp the entry was first seen, newest-first in the feed.
  readonly firstSeenAt: string | null
}

// The qualitative bands, worst first, as a lookup for ranking and display.
const SEVERITY_BUCKET: Record<string, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
}

// A single comparable score so the picker can sort worst-first with one key.
// KEV dominates (a known-exploited CVE outranks anything not on the list),
// then CVSS, then the stated band as a tiebreak when CVSS is missing. Higher is
// more severe.
export function severityRank(cve: FeedCve): number {
  const kev = cve.kev ? 1000 : 0
  const cvss = typeof cve.cvss === 'number' ? cve.cvss * 10 : 0
  const bucket = cve.statedSeverity
    ? (SEVERITY_BUCKET[cve.statedSeverity.toLowerCase()] ?? 0)
    : 0
  return kev + cvss + bucket
}

// cve.now serves a fixed ~30 entries per page regardless of the `limit` we ask
// for, cursor-paginated via `nextCursor`. To offer a top-N picker larger than
// one page we follow the cursor until we have enough — bounded so a broken or
// endless feed can never loop without limit.
const MAX_FEED_PAGES = 20

// Validate one entries-API page: pull the well-formed CVE rows out and surface
// the cursor to the next page (null when the feed has no more). Malformed rows
// are dropped rather than failing the whole page.
function parseEntriesPage(body: unknown): {
  cves: FeedCve[]
  nextCursor: string | null
} {
  const obj =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const entries = Array.isArray(obj.entries) ? obj.entries : []
  const cves: FeedCve[] = []
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    if (typeof e.id !== 'string' || e.id.length === 0) continue
    cves.push({
      id: e.id,
      title: typeof e.title === 'string' ? e.title : e.id,
      cvss: typeof e.cvss === 'number' ? e.cvss : null,
      statedSeverity: typeof e.statedSeverity === 'string' ? e.statedSeverity : null,
      kev: e.kev === true,
      firstSeenAt: typeof e.firstSeenAt === 'string' ? e.firstSeenAt : null,
    })
  }
  const nextCursor =
    typeof obj.nextCursor === 'string' && obj.nextCursor.length > 0
      ? obj.nextCursor
      : null
  return { cves, nextCursor }
}

// Fetch the current cve.now feed and return it severity-sorted (worst first),
// ready for the onboarding top-N picker. Follows the cursor across pages until
// it has gathered `limit` entries or the feed runs out, de-duplicating ids. The
// first page failing throws so the UI can show a retry; a later page failing
// keeps what we already gathered rather than losing the whole list.
export async function fetchLiveCves(
  limit = 50,
  signal?: AbortSignal,
): Promise<FeedCve[]> {
  const cves: FeedCve[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  for (let page = 0; page < MAX_FEED_PAGES && cves.length < limit; page += 1) {
    const url = new URL(CVE_NOW_ENTRIES_API)
    url.searchParams.set('limit', String(limit))
    if (cursor) url.searchParams.set('cursor', cursor)
    let res: Response
    try {
      res = await fetch(url, { signal, headers: { accept: 'application/json' } })
    } catch (err) {
      if (page === 0) throw err
      break
    }
    if (!res.ok) {
      if (page === 0) throw new Error(`cve.now feed responded ${res.status}`)
      break
    }
    const { cves: pageCves, nextCursor } = parseEntriesPage(await res.json())
    for (const cve of pageCves) {
      if (seen.has(cve.id)) continue
      seen.add(cve.id)
      cves.push(cve)
    }
    cursor = nextCursor
    if (!cursor) break
  }
  return cves.sort((a, b) => severityRank(b) - severityRank(a)).slice(0, limit)
}

// cve.now's MCP server. `check_stack` matches a repository's lockfile against
// known advisories — the precise "which CVEs hit THIS repo" primitive. Referenced
// in the payload as the upgrade path; not required for the curl-only flow.
export const CVE_NOW_MCP = 'https://mcp.cve.now/mcp'

// A discovery angle: one lens a cell hunts the target through. Giving each cell
// a different angle is what makes a swarm of N agents *diverge* instead of
// converging on the same finding — diversity is the whole point of fanning out.
export type DiscoveryAngle = {
  readonly id: string
  readonly label: string
  // What this cell hunts for, in one imperative line dropped into its prompt.
  readonly focus: string
}

// The attack-surface lenses, ordered roughly by how commonly they turn up real
// exposure. `assignAngles` round-robins these across the cells so every swarm
// covers the surface broadly before it doubles up any one lens.
export const DISCOVERY_ANGLES: readonly DiscoveryAngle[] = [
  {
    id: 'auth-session',
    label: 'Authentication & session',
    focus:
      'Probe login, token issuance, session fixation, password reset and multi-factor flows for broken authentication.',
  },
  {
    id: 'access-control',
    label: 'Broken access control / IDOR',
    focus:
      'Enumerate object ids and privileged routes to find data or actions reachable without the right authorization.',
  },
  {
    id: 'injection',
    label: 'Injection',
    focus:
      'Test request parameters, headers and bodies for SQL, NoSQL, command and template injection reflected by the app.',
  },
  {
    id: 'ssrf-request',
    label: 'SSRF & request forgery',
    focus:
      'Hunt server-side request forgery, open redirects and CSRF in features that fetch URLs or act on behalf of a user.',
  },
  {
    id: 'client-side',
    label: 'Client-side & JS routes',
    focus:
      'Crawl the client bundle for hidden routes and API calls, then test for XSS and client-side trust failures.',
  },
  {
    id: 'business-logic',
    label: 'Business logic',
    focus:
      'Abuse multi-step workflows — pricing, quotas, state transitions — for logic flaws no scanner signature catches.',
  },
  {
    id: 'supply-chain',
    label: 'Dependency & supply-chain',
    focus:
      'Match the repository manifest against live advisories and prove whether a vulnerable dependency is actually served.',
  },
]

// Spread `count` cells across the angle catalog, round-robin. Returns one angle
// per cell, so the launcher can hand each fanned-out session a distinct lens.
// With more cells than angles the lenses repeat in order, which is intended —
// a second pass on the same angle from a fresh agent still finds different
// things. `count <= 0` yields an empty assignment.
export function assignAngles(count: number): DiscoveryAngle[] {
  const assigned: DiscoveryAngle[] = []
  for (let i = 0; i < count; i += 1) {
    assigned.push(DISCOVERY_ANGLES[i % DISCOVERY_ANGLES.length])
  }
  return assigned
}

// The feed-seeding steps, as prompt lines shared by the cell and launch prompts
// so there is one source of truth for how a cell pulls live intelligence. Kept
// curl-first (works today over open egress); the MCP path is named as the
// precise upgrade, not a requirement.
export function feedSeedingLines(): string[] {
  return [
    'Seed the hunt from live intelligence before touching the target:',
    `- Pull the current feed from ${CVE_NOW.json} and ${PWN_WATCH.json} (plain JSON over egress) to see what is being exploited now.`,
    `- Match this repository's dependency manifest against applicable advisories — cve.now's check_stack (MCP at ${CVE_NOW_MCP}) is the precise path; fall back to ${CVE_NOW_ENTRIES_API} by product if MCP is unavailable.`,
    '- Weight the hunt toward CISA KEV / high-EPSS entries that line up with the routes this repository actually exposes.',
  ]
}
