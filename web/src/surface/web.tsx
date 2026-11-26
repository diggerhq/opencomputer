import { useEffect, useState } from 'react'
import type { Host } from './host'
import { Surface } from './Surface'

// The web tab (spec 25): a lazy route of the dashboard that owns the whole
// page. With `?fake` it runs against the fake server instead of the API.

const BASE = '/computer/work'
const API = '/api/dashboard/managed-agents'

async function makeHost(): Promise<Host> {
  const fake = new URLSearchParams(location.search).get('fake')
  if (fake !== null || import.meta.env.VITE_PREVIEW === '1') {
    const { fakeHost } = await import('./host-fake')
    return fakeHost({ base: BASE, seed: fake === 'empty' ? 'empty' : 'demo' })
  }
  const res = await fetch('/api/dashboard/me', { credentials: 'include' })
  const me = (await res.json()) as { id: string; email: string; orgId: string }
  const { webHost } = await import('./host-web')
  return webHost({ principal: { org: me.orgId, subject: me.id }, name: me.email.split('@')[0], api: API, base: BASE })
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
