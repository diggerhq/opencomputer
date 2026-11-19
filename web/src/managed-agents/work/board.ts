import type {
  Item,
  PullRequest,
  PullState,
  Repository,
  SessionStatus,
} from './api'

// How the board lays out what the API returns (ux-spec 4.1). Nothing here
// decides a stage, readiness or attention: those are the item's own fields.
// This file only filters, orders and words them.

export type Tab = 'mine' | 'everyone'

// The board and the item page poll this often (tech design 3.11).
export const OPEN_POLL_MS = 15_000
export const STALE_DAYS = 14
export const CLOSED_RECENT_DAYS = 7
const DAY = 86_400_000

export type Filters = { tab: Tab; q: string; tag: string | null }

export function matches(item: Item, f: Filters): boolean {
  if (f.tab === 'mine' && !item.mine) return false
  if (f.tag && !item.tags.includes(f.tag)) return false
  const q = f.q.trim().toLowerCase()
  if (!q) return true
  return (
    item.title.toLowerCase().includes(q) ||
    (item.stateLine ?? '').toLowerCase().includes(q)
  )
}

// Newest change first; an item whose last change is not known yet goes last.
const latestFirst = (a: Item, b: Item) =>
  a.updatedAt === b.updatedAt
    ? 0
    : a.updatedAt === null
      ? 1
      : b.updatedAt === null
        ? -1
        : b.updatedAt.localeCompare(a.updatedAt)

const needsYouFirst = (a: Item, b: Item) =>
  (a.attention?.state === 'needs_you' ? 0 : 1) -
    (b.attention?.state === 'needs_you' ? 0 : 1) || latestFirst(a, b)

/**
 * In progress: the cards that need the viewer first, then by last change
 * (unknown last, within each group).
 */
export function inProgress(items: Item[]): Item[] {
  return items
    .filter((i) => i.stage === 'open' && !i.readyToClose)
    .sort(needsYouFirst)
}

/** Ready to close: in the same order. */
export function readyToClose(items: Item[]): Item[] {
  return items
    .filter((i) => i.stage === 'open' && i.readyToClose)
    .sort(needsYouFirst)
}

/** Closed in the last seven days, unless older ones are asked for. */
export function closedShown(
  items: Item[],
  showOlder: boolean,
  now = Date.now(),
): Item[] {
  return items
    .filter((i) => i.stage === 'closed')
    .filter(
      (i) =>
        showOlder ||
        (i.closedAt !== null &&
          now - new Date(i.closedAt).getTime() <= CLOSED_RECENT_DAYS * DAY),
    )
}

/** Days since the last change, when that makes the card stale; else null. */
export function staleDays(item: Item, now = Date.now()): number | null {
  if (item.stage !== 'open' || item.updatedAt === null) return null
  const days = Math.floor((now - new Date(item.updatedAt).getTime()) / DAY)
  return days >= STALE_DAYS ? days : null
}

/** The one attention line on a card, and whether it is the coloured one. */
export function attentionLabel(
  item: Item,
  ago: (iso: string) => string,
): { text: string; needsYou: boolean } | null {
  const a = item.attention
  if (!a) return null
  switch (a.state) {
    case 'needs_you':
      return { text: 'needs you', needsYou: true }
    case 'waiting_on':
      return {
        text: `waiting on ${a.name ?? 'someone'} · ${ago(a.since)}`,
        needsYou: false,
      }
    case 'working':
      return { text: 'agent working', needsYou: false }
  }
}

/** "#412" for a GitHub pull request link, else the link itself. */
export function pullLabel(pr: PullRequest): string {
  const m = pr.url.match(/\/pull\/(\d+)/)
  return m ? `#${m[1]}` : pr.url
}

export function personName(p: { name: string | null; email: string }) {
  return p.name?.trim() || p.email
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

// The sessions screens' words, lower case; "waiting" says what it waits for,
// because the session may be someone else's.
const SESSION_STATUS_WORD: Record<SessionStatus, string> = {
  starting: 'starting',
  running: 'working',
  waiting: 'waiting for an answer',
  idle: 'idle',
  suspended: 'asleep',
}

export function sessionStatusWord(status: SessionStatus) {
  return SESSION_STATUS_WORD[status] ?? status
}

export function pullStateWord(state: PullState) {
  return state ?? 'state unknown'
}

export function repositoryName(r: Repository) {
  return `${r.owner}/${r.name}`
}

// The server's problem codes (its RepositoryProblem), in words, for when it
// sends no `problemMessage`.
const PROBLEM_TEXT: Record<string, string> = {
  installation_removed:
    'The GitHub installation is not connected to this organization.',
  installation_suspended: 'The GitHub installation is suspended.',
  repository_not_found:
    'The repository does not exist, or the GitHub installation no longer grants it.',
  branch_not_found: 'The repository has no such branch.',
  access_denied: "The GitHub installation cannot read the repository's files.",
  github_app_not_configured: 'The GitHub App is not configured.',
}

/**
 * Why the repository cannot be read, as a sentence; null when it can. The
 * server's own message wins; a code is never shown as it is.
 */
export function repositoryProblem(r: Repository): string | null {
  if (!r.problem) return null
  return (
    r.problemMessage?.trim() ||
    PROBLEM_TEXT[r.problem] ||
    'GitHub refused the last read; check the repository setting.'
  )
}

// The index is this far behind before the board says how old it is.
const STALE_INDEX_MS = 5 * 60_000

/** True when the index the answer was read from is a while old. */
export function indexIsOld(asOf: string | null, now = Date.now()) {
  return asOf !== null && now - new Date(asOf).getTime() > STALE_INDEX_MS
}

/**
 * The doc as a reader sees it: without its frontmatter (the header and the
 * aside show those fields) and without a leading title (the header has it).
 */
export function presentBody(body: string): string {
  let s = body.replace(/^\uFEFF/, '')
  const fm = s.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/)
  if (fm) s = s.slice(fm[0].length)
  s = s.replace(/^\s*#[ \t]+[^\n]*(\n|$)/, '')
  return s.trimStart()
}

/** A link in the doc relative to the doc resolves to its place on GitHub. */
export function resolveAgainst(url: string, base: string): string {
  if (!url || url.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(url))
    return url
  try {
    return new URL(url, base).toString()
  } catch {
    return url
  }
}
