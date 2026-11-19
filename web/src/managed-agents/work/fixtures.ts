import type { Item } from './api'

// Test data for the work screens, in the API's shape (tech design 3.10).

// The real clock, so the screens' relative times read as written.
export const NOW = Date.now()
export const minutesAgo = (min: number) =>
  new Date(NOW - min * 60_000).toISOString()

export function makeItem(over: Partial<Item> = {}): Item {
  return {
    number: 1,
    stage: 'open',
    path: 'work/001-thing.md',
    url: 'https://github.com/acme/knowledge/blob/main/work/001-thing.md',
    title: 'A thing',
    stateLine: null,
    tags: [],
    owner: null,
    author: null,
    mine: false,
    left: 1,
    readyToClose: false,
    warnings: [],
    pullRequests: [],
    attention: null,
    sessions: [],
    unpublished: false,
    updatedAt: minutesAgo(60),
    createdAt: null,
    closedAt: null,
    closedBy: null,
    ...over,
  }
}
