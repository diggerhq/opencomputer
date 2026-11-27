import { createClient, type Client, type Files, type Storage } from '@opencomputer/sdk/computer'
import type { Host } from '../host'

// The surface's client, whose waits can be cut short when the network is back.
export function hurriedClient(host: Host, storage: Storage, files?: Files): { client: Client; hurry: () => void } {
  // The client's waits (reconnect, retry), held so they can be cut short when
  // the network comes back (`hurry`).
  const waits = new Map<number, { fn: () => void; h: ReturnType<typeof setTimeout> }>()
  let waitIds = 0
  const client: Client = createClient({
    principal: host.principal,
    fetch: (path, init) => host.api.fetch(path, init),
    connect: () => host.connect(),
    storage,
    files,
    upload: host.api.upload ? (path, req) => host.api.upload!(path, req) : undefined,
    lock:
      typeof navigator !== 'undefined' && navigator.locks
        ? (name, fn) => navigator.locks.request(name, fn)
        : undefined,
    setTimeout: (fn, ms) => {
      const id = ++waitIds
      waits.set(id, { fn, h: setTimeout(() => (waits.delete(id), fn()), ms) })
      return id
    },
    clearTimeout: (id) => {
      const w = waits.get(id as number)
      if (w) clearTimeout(w.h)
      waits.delete(id as number)
    },
  })
  // The network may be back: an offline client reconnects (and retries) now,
  // not at the end of its backoff.
  const hurry = () => {
    if (client.status.get() === 'online') return
    for (const [id, w] of [...waits]) {
      clearTimeout(w.h)
      waits.delete(id)
      w.fn()
    }
  }
  return { client, hurry }
}
