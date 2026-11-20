// Preview data for the Work routes (tech design 3.10): the board, an item and
// its history. Invented people and work only.
//
// `?work=` picks a scenario: no-github (GitHub not connected, so no
// repository), none (no repository set), empty (a repository with nothing
// tracked), mine-empty (nothing owned by the viewer), building
// (the first read of the repository), problem (the repository cannot be
// read), missing (the routes answer 404, as before the service ships).

import { ApiError } from './errors'

const PREFIX = '/managed-agents/computer/work'
const MIN = 60_000
const ago = (min: number) => new Date(Date.now() - min * MIN).toISOString()
const H = 60
const D = 24 * H

type Json = Record<string, unknown>

const igor = { email: 'igor@digger.dev', name: 'Igor', id: 'usr_igor' }
const maya = { email: 'maya@example.com', name: 'Maya Chen', id: 'usr_maya' }
const sam = { email: 'sam@example.com', name: 'Sam Okafor', id: 'usr_sam' }
const priya = { email: 'priya@example.com', name: 'Priya Raman', id: null }

// An owner the doc declares (`owner:`), or one derived from the author of the
// doc's latest change that was not a bulk edit.
type Who = { email: string; name: string | null; id: string | null }
const declared = (p: Who) => ({ ...p, source: 'declared' })
const derived = (p: Who) => ({ ...p, source: 'derived' })

// The first seeded sessions in mock-computer-sessions.ts, so links open.
const S1 = 'cs_000000000001'
const S2 = 'cs_000000000002'
const S3 = 'cs_000000000003'

const repo = {
  installationId: '1',
  owner: 'acme',
  name: 'knowledge',
  branch: 'main',
  problem: null as string | null,
  problemMessage: null as string | null,
}
let repository: typeof repo | null = repo

// What the preview's GitHub installations grant (the computer mock's acme and
// acme-labs), most recently pushed first as the server sends them.
const granted = (
  owner: string,
  list: [name: string, isPrivate: boolean, pushed: number | null][],
) =>
  list.map(([name, isPrivate, pushed], i) => ({
    id: (owner === 'acme' ? 1000 : 2000) + i,
    owner,
    name,
    private: isPrivate,
    defaultBranch: name === 'legacy-site' ? 'master' : 'main',
    pushedAt: pushed === null ? null : ago(pushed),
  }))
const granting = [
  {
    id: '1',
    accountLogin: 'acme',
    accountType: 'Organization',
    settingsUrl:
      'https://github.com/organizations/acme/settings/installations/41000001',
    repositories: granted('acme', [
      ['app', true, 12],
      ['knowledge', true, 3 * H],
      ['infra', true, 26 * H],
      ['docs', false, 3 * D],
      ['design-system', false, 9 * D],
      ['mobile', true, 21 * D],
      ['legacy-site', false, 140 * D],
      ['scratch', true, null],
    ]),
    truncated: false,
    problem: null,
    problemMessage: null,
  },
  {
    id: '2',
    accountLogin: 'acme-labs',
    accountType: 'Organization',
    settingsUrl:
      'https://github.com/organizations/acme-labs/settings/installations/41000002',
    repositories: granted('acme-labs', [
      ['experiments', true, 2 * D],
      ['notes', false, 30 * D],
    ]),
    truncated: false,
    problem: null,
    problemMessage: null,
  },
]

const pr = (n: number, state: string | null, title: string) => ({
  url: `https://github.com/acme/app/pull/${n}`,
  state,
  title,
})

function item(
  number: number,
  title: string,
  // `activity`: minutes since the latest change that was not a bulk edit
  // (default `updated`; null for none read).
  over: Partial<Json> & { updated: number; activity?: number | null },
): Json {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  const path = `work/${String(number).padStart(3, '0')}-${slug}.md`
  const { updated, activity = updated, ...rest } = over
  const attention = (over.attention as Json | null | undefined) ?? null
  return {
    number,
    stage: 'open',
    path,
    url: `https://github.com/acme/knowledge/blob/main/${path}`,
    title,
    stateLine: null,
    tags: [],
    owner: null,
    author: igor,
    mine: false,
    left: 1,
    readyToClose: false,
    warnings: [],
    pullRequests: [],
    attention: null,
    sessions: [],
    unpublished: false,
    updatedAt: ago(updated),
    lastActivityAt: activity === null ? null : ago(activity),
    // The server's rule: changed in the last 14 days, or a session is
    // working or waiting.
    active: (activity !== null && activity < 14 * D) || attention !== null,
    createdAt: ago(updated + 5 * D),
    closedAt: null,
    closedBy: null,
    ...rest,
  }
}

const open: Json[] = [
  item(12, 'Usage-based billing for sessions', {
    updated: 40,
    stateLine:
      'Metering ships behind the invoice preview; the price table needs a decision.',
    tags: ['billing', 'pricing', 'invoices'],
    owner: declared(igor),
    mine: true,
    left: 3,
    warnings: ['The "Left" section has an item with no checkbox.'],
    pullRequests: [
      pr(4175, 'merged', 'Usage table'),
      pr(4182, 'open', 'Meter session minutes'),
      pr(4190, 'draft', 'Invoice preview'),
    ],
    attention: { state: 'needs_you', name: null, since: ago(25) },
    sessions: [
      {
        id: S1,
        title: 'Meter session minutes',
        ownerName: 'Igor',
        status: 'waiting',
      },
      {
        id: S2,
        title: 'Draft the price table',
        ownerName: 'Maya Chen',
        status: 'idle',
      },
    ],
    unpublished: true,
  }),
  item(17, 'Rotate staging credentials quarterly', {
    updated: 3 * H,
    stateLine: 'Database done; the queue and object store keys are left.',
    tags: ['security', 'infra'],
    owner: derived(igor),
    mine: true,
    left: 2,
    attention: { state: 'waiting_on', name: 'Maya', since: ago(3 * H) },
    sessions: [
      {
        id: S3,
        title: 'Rotate the queue keys',
        ownerName: 'Igor',
        status: 'idle',
      },
    ],
  }),
  item(21, 'Pick a chart library for the usage page', {
    updated: 15,
    stateLine:
      'Comparing three libraries on bundle size, dark theme and how they draw a gap in the data; Recharts leads, but its tooltips need work before it can ship.',
    tags: ['frontend'],
    owner: derived(igor),
    mine: true,
    left: 4,
    attention: { state: 'working', name: null, since: ago(15) },
    sessions: [
      {
        id: S2,
        title: 'Pick a chart library',
        ownerName: 'Igor',
        status: 'running',
      },
    ],
  }),
  item(9, 'Move the docs site to the new theme', {
    updated: 20 * D,
    stateLine: 'Half the pages are moved; search is not wired up.',
    tags: ['docs'],
    owner: declared(igor),
    mine: true,
    left: 5,
    pullRequests: [pr(3920, 'closed', 'Docs theme, first pass')],
  }),
  item(24, 'Slack thread replies lose formatting', {
    updated: 2 * H,
    stateLine: 'Reproduced with nested lists; the fix is in review.',
    tags: ['slack', 'bug'],
    owner: derived(maya),
    left: 1,
    pullRequests: [pr(4201, 'open', 'Keep nested lists in Slack replies')],
    attention: { state: 'needs_you', name: null, since: ago(50) },
    sessions: [
      {
        id: S1,
        title: 'Fix Slack lists',
        ownerName: 'Maya Chen',
        status: 'waiting',
      },
    ],
  }),
  item(
    26,
    'Faster cold start for sandboxes restored from a snapshot on a busy worker',
    {
      updated: 6 * H,
      stateLine: 'Snapshot restore is 40% faster in staging; measuring prod.',
      tags: ['infra', 'performance', 'sandboxes', 'workers'],
      owner: declared(sam),
      left: 2,
      attention: { state: 'waiting_on', name: 'Sam', since: ago(6 * H) },
      warnings: ['The "Left" section has an item with no checkbox.'],
    },
  ),
  item(27, 'Onboarding checklist for new organizations', {
    updated: D + 4 * H,
    stateLine: null,
    tags: ['onboarding'],
    owner: derived(priya),
    author: priya,
    left: 6,
  }),
  // The index has not read its commits yet: no time and no owner on the
  // card, but a session is working on it, so it is active.
  item(31, 'Look into the flaky end-to-end test', {
    updated: 2 * D,
    activity: null,
    updatedAt: null,
    stateLine: null,
    owner: null,
    author: null,
    left: 1,
    attention: { state: 'working', name: null, since: ago(4) },
    sessions: [
      {
        id: S3,
        title: 'Bisect the flaky test',
        ownerName: 'Sam Okafor',
        status: 'running',
      },
    ],
  }),
  item(29, 'Audit log export', {
    updated: 3 * D,
    stateLine: 'The CSV shape is agreed; the API route is next.',
    tags: ['security'],
    owner: declared(priya),
    author: priya,
    left: 2,
    pullRequests: [pr(4150, null, 'Audit log export')],
  }),
  item(15, 'Webhook retries with backoff', {
    updated: 5 * H,
    stateLine: 'Shipped in #4170; nothing left in the doc.',
    tags: ['api'],
    owner: derived(igor),
    mine: true,
    left: 0,
    readyToClose: true,
    pullRequests: [pr(4170, 'merged', 'Retry webhooks with backoff')],
    attention: { state: 'needs_you', name: null, since: ago(5 * H) },
  }),
  item(19, 'Rename "projects" to "apps" in the CLI', {
    updated: D + 2 * H,
    stateLine: 'Merged and released in 0.31.',
    tags: ['cli'],
    owner: derived(sam),
    left: 0,
    readyToClose: true,
    pullRequests: [pr(4160, 'merged', 'Rename projects to apps')],
  }),
  // Dormant: no change of its own in 14 days and no session at work.
  item(5, 'Retire the v1 webhooks endpoint', {
    // A bulk edit touched it yesterday; its own last change is older.
    updated: D,
    activity: 41 * D,
    stateLine: 'Two customers still call v1; both have been told.',
    tags: ['api'],
    owner: derived(sam),
    left: 2,
  }),
  item(6, 'Single sign-on with Okta', {
    updated: 33 * D,
    stateLine: 'SAML works against a test tenant; SCIM is not started.',
    tags: ['security', 'enterprise'],
    owner: declared(maya),
    left: 4,
    pullRequests: [pr(3990, 'draft', 'SAML login')],
  }),
  item(11, 'Per-team usage caps', {
    updated: 26 * D,
    stateLine: 'Waiting for usage-based billing to land.',
    tags: ['billing'],
    owner: derived(igor),
    mine: true,
    left: 3,
    sessions: [
      {
        id: S2,
        title: 'Sketch team caps',
        ownerName: 'Igor',
        status: 'idle',
      },
    ],
  }),
  item(7, 'Document the rate limits', {
    updated: 52 * D,
    stateLine: null,
    tags: ['docs', 'api'],
    owner: derived(priya),
    left: 1,
  }),
  // No commit of its own in the index's reach: no derived owner.
  item(3, 'Dark mode for the status page', {
    updated: 70 * D,
    activity: null,
    stateLine: null,
    tags: ['frontend'],
    owner: null,
    author: null,
    left: 2,
  }),
  item(10, 'Remove the beta banner', {
    updated: 18 * D,
    stateLine: 'Removed everywhere; nothing left in the doc.',
    tags: ['frontend'],
    owner: derived(igor),
    mine: true,
    left: 0,
    readyToClose: true,
    pullRequests: [pr(3980, 'merged', 'Drop the beta banner')],
  }),
]

const closed: Json[] = [
  item(23, 'Fix the 502s on api-edge', {
    updated: 2 * D,
    stage: 'closed',
    stateLine: 'A cold Durable Object; fixed by warming it on deploy.',
    tags: ['infra', 'bug'],
    owner: declared(igor),
    mine: true,
    left: 0,
    pullRequests: [pr(4171, 'merged', 'Warm the edge object on deploy')],
    closedAt: ago(2 * D),
    closedBy: 'Igor',
  }),
  item(20, 'Draft the launch post for Sessions', {
    updated: 4 * D,
    stage: 'closed',
    stateLine: 'Published on the blog.',
    tags: ['marketing'],
    owner: derived(maya),
    left: 0,
    closedAt: ago(4 * D),
    closedBy: 'Maya Chen',
  }),
  item(14, 'Upgrade React Router to v7', {
    updated: 12 * D,
    stage: 'closed',
    stateLine: 'All routes load and tests pass.',
    tags: ['frontend'],
    owner: derived(igor),
    mine: true,
    left: 0,
    pullRequests: [pr(4100, 'merged', 'React Router 7')],
    closedAt: ago(12 * D),
    closedBy: 'Igor',
  }),
  item(8, 'Self-serve plan downgrades', {
    updated: 30 * D,
    stage: 'closed',
    stateLine: null,
    tags: ['billing'],
    owner: declared(sam),
    left: 0,
    // Closed, but when and by whom is not known yet: just "Closed".
    closedAt: null,
    closedBy: null,
  }),
]

// Only a declared owner is in the doc.
const ownerLine = (it: Json) => {
  const o = it.owner as { email: string; source: string } | null
  return o?.source === 'declared' ? o.email : ''
}

const body = (it: Json) => `---
number: ${String(it.number)}
title: ${String(it.title)}
owner: ${ownerLine(it)}
tags: [${(it.tags as string[]).join(', ')}]
---

# ${String(it.title)}

## Why

Customers on long sessions pay the same as short ones, and finance cannot
forecast compute. We want each session billed by the minutes it actually runs,
with the price shown before anyone commits.

## State

${(it.stateLine as string | null) ?? 'Just started.'}

- Metering records minutes per session in the usage table.
- The invoice preview renders from those records; see [the design](../design/billing.md).

## Left

- [ ] Decide the price per minute for the Pro plan
- [ ] Ship the invoice preview to everyone
- [x] Meter session minutes

## Decisions

| When | What | Who |
| --- | --- | --- |
| Monday | Round up to the minute | Maya |
| Last week | No charge for idle time | Igor |

\`\`\`sql
select session_id, sum(minutes) from usage group by 1;
\`\`\`
`

const revisions = (it: Json) => [
  {
    sha: '9f2c1a7e4b3d2c1a0f9e8d7c6b5a4f3e2d1c0b9a',
    url: 'https://github.com/acme/knowledge/commit/9f2c1a7',
    at: (it.updatedAt as string | null) ?? ago(H),
    authorName: 'Computer for Igor',
    summary: 'Record the price-table question; metering merged',
    sessionId: S1,
  },
  {
    sha: '7b1d0e9c8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d',
    url: 'https://github.com/acme/knowledge/commit/7b1d0e9',
    at: ago(5 * H),
    authorName: 'Computer for Maya Chen',
    summary: 'Add the invoice preview to Left',
    sessionId: S2,
  },
  {
    sha: '3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
    url: 'https://github.com/acme/knowledge/commit/3a4b5c6',
    at: ago(2 * D),
    authorName: 'Igor',
    summary: 'Fix a typo in Why',
    sessionId: null,
  },
  {
    sha: '1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d',
    url: 'https://github.com/acme/knowledge/commit/1c2d3e4',
    at: (it.createdAt as string | null) ?? ago(6 * D),
    authorName: 'Computer for Igor',
    summary: 'Track usage-based billing',
    sessionId: S1,
  },
]

function scenario() {
  return typeof window === 'undefined'
    ? null
    : new URLSearchParams(window.location.search).get('work')
}

// `?work=problem` reads `&problem=<code>` from the page's address (default
// access_denied); access_denied comes with the server's own sentence, the
// others with none, so the web's own words show.
function problemOf() {
  const code =
    (typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get('problem')) ??
    'access_denied'
  return {
    problem: code,
    problemMessage:
      code === 'access_denied'
        ? "The installation cannot read the repository's contents."
        : null,
  }
}

// Returns undefined for paths it does not serve.
export function workMock(
  path: string,
  method: string,
  input: unknown,
): unknown {
  const [pathname, search = ''] = path.split('?')
  if (!pathname.startsWith(PREFIX)) return undefined
  const rest = pathname.slice(PREFIX.length)
  const query = new URLSearchParams(search)
  const s = scenario()
  if (s === 'missing') throw new ApiError('Not found', 404)
  const current =
    s === 'none' || s === 'no-github'
      ? null
      : s === 'problem' && repository
        ? { ...repository, ...problemOf() }
        : repository

  if (rest === '/repository') {
    if (method === 'PUT') {
      const body = JSON.parse(typeof input === 'string' ? input : '{}') as Json
      repository = { ...repo, ...body, problem: null, problemMessage: null }
      return { repository }
    }
    return { repository: current }
  }
  if (rest === '/repositories' && method === 'GET') {
    return { installations: s === 'no-github' ? [] : granting }
  }
  const mineEmpty = s === 'mine-empty'
  const visible = (list: Json[]) =>
    s === 'empty' || s === 'building' || !current
      ? []
      : mineEmpty
        ? list.map((i) => ({ ...i, mine: false }))
        : list
  if (rest === '/items' && method === 'GET') {
    if (query.get('stage') === 'closed') {
      return { items: visible(closed), nextCursor: null }
    }
    return {
      repository: current,
      head: current ? '9f2c1a7e4b3d' : null,
      asOf: current ? ago(0) : null,
      building: s === 'building',
      items: visible(open),
    }
  }
  const linked = rest.match(/^\/sessions\/([^/]+)\/items$/)
  if (linked && method === 'GET') {
    const id = decodeURIComponent(linked[1])
    const all = current ? [...open, ...closed] : []
    return {
      items: all.filter((i) =>
        (i.sessions as { id: string }[]).some((x) => x.id === id),
      ),
    }
  }
  const m = rest.match(/^\/items\/(\d+)(\/history)?$/)
  if (m) {
    const it = [...open, ...closed].find((i) => i.number === Number(m[1]))
    if (!it || !current)
      throw new ApiError('No such item.', 404, 'item_not_found')
    if (m[2]) return { revisions: revisions(it), nextCursor: null }
    return { item: it, body: body(it) }
  }
  return undefined
}

/**
 * The open-items poll as the server answers it, headers included: an ETag
 * over the page without `asOf`, a 304 when the caller's ETag still matches,
 * and the index's `Work-As-Of` on both.
 */
export function workOpenItemsResponse(ifNoneMatch: string | null): Response {
  const page = workMock(`${PREFIX}/items?stage=open`, 'GET', undefined) as Json
  const { asOf, ...rest } = page
  const etag = `"${hash(JSON.stringify(rest))}"`
  const headers = new Headers({ ETag: etag })
  if (typeof asOf === 'string') headers.set('Work-As-Of', asOf)
  if (ifNoneMatch === etag) return new Response(null, { status: 304, headers })
  headers.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(page), { status: 200, headers })
}

function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i)
  return (h >>> 0).toString(16)
}
