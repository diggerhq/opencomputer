import { useEffect, useState } from 'react'
import type { Host } from './host'
import { Surface } from './Surface'

// The web tab (spec 25): a lazy route of the dashboard that owns the whole
// page. With `?fake` it runs against the fake server instead of the API.

const BASE = '/computer/work'
// The Computer API takes the dashboard's cookie (spec 37); Live is `${API}/live`.
const API = '/api/managed-agents/computer'

async function makeHost(): Promise<Host> {
  const fake = new URLSearchParams(location.search).get('fake')
  if (fake !== null || import.meta.env.VITE_PREVIEW === '1') {
    const { fakeHost } = await import('./host-fake')
    return fakeHost({ base: BASE, seed: fake === 'empty' ? 'empty' : 'demo' })
  }
  // The principal as the server names it (`usr_…`, not the dashboard's user
  // id): every feed frame carries it, and the client drops frames that differ.
  const [feed, me] = await Promise.all([
    fetch(`${API}/feed?kinds=pref`, { credentials: 'include' }),
    fetch('/api/dashboard/me', { credentials: 'include' }).then((r) => (r.ok ? r.json() : null), () => null),
  ])
  if (feed.status === 401) {
    location.assign('/auth/login')
    return new Promise(() => {})
  }
  const { org, subject } = (await feed.json()) as { org: string; subject: string }
  const email = (me as { email?: string } | null)?.email
  const { webHost } = await import('./host-web')
  return webHost({ principal: { org, subject }, name: email?.split('@')[0], api: API, base: BASE })
}

// Made once for the page: StrictMode runs the effect twice, and a second fake
// server would leave `window.__fake` pointing at one nothing uses.
let made: Promise<Host> | undefined

export default function WebSurface() {
  const [host, setHost] = useState<Host | null>(null)
  useEffect(() => {
    let live = true
    void (made ??= makeHost()).then((h) => live && setHost(h))
    return () => {
      live = false
    }
  }, [])
  return host ? <Surface host={host} /> : null
}
