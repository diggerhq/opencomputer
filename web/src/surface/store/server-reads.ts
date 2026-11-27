import type { StoreApi } from 'zustand/vanilla'
import type { Capabilities, Client, Review, Row, SearchReply, ThreadsPage } from '@opencomputer/sdk/computer'
import type { State } from './surface-state'

// The surface's reads that are not streams: Earlier's pages, search, a
// result's review, diff and file, and what a session may be started with.
export function serverReads({
  client,
  fetch,
  store,
  addUnder,
  toast,
}: {
  client: Client
  // The API's own fetch, for a read that is bytes, not JSON.
  fetch: (path: string, init?: RequestInit) => Promise<Response>
  store: StoreApi<State>
  // Rows read by query are held beneath the feed's.
  addUnder: (rows: Row[]) => void
  toast: (t: { text: string; tone?: 'error' }) => void
}) {
  const get = store.getState
  const set = store.setState
  return {
    async loadEarlier(tid?: string) {
      const key = tid ?? ''
      const before = get().earlierNext[key]
      if (before === null) return
      const q = new URLSearchParams({ earlier: '1', limit: '50' })
      if (tid) q.set('track', tid)
      if (before) q.set('before', before)
      try {
        const page = await client.read<ThreadsPage>(`/work/threads?${q}`)
        set({ earlierNext: { ...get().earlierNext, [key]: page.next } })
        addUnder(page.rows)
      } catch {
        // Offline: Earlier shows what is held. Online, a failed read says so.
        if (get().status === 'online') toast({ text: 'Could not load earlier threads', tone: 'error' })
      }
    },
    async search(q: string) {
      const reply = await client.read<SearchReply>(`/work/search?q=${encodeURIComponent(q)}&limit=20`)
      addUnder(reply.rows)
      return reply.rows
    },
    async review(resultId: string) {
      return (await client.read<{ review: Review }>(`/work/results/${resultId}/review`)).review
    },
    // What a session may be started with or changed to (the model and effort pickers).
    async capabilities() {
      return (await client.read<{ capabilities: Capabilities }>('/capabilities')).capabilities
    },
    async diff(resultId: string) {
      return (await client.read<{ head: string; diff: string }>(`/work/results/${resultId}/diff`)).diff
    },
    // A file the agent sent (send_file in a session with no Slack thread), as it is in the workspace.
    async file(resultId: string) {
      const reply = await fetch(`/work/results/${resultId}/file`)
      if (!reply.ok) throw new Error(`file: ${reply.status}`)
      return reply.blob()
    },
  }
}
