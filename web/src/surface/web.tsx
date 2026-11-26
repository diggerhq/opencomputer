import { useQuery } from '@tanstack/react-query'
import { OrgSwitcher } from '@/components/app-shell'
import { useAuth } from '@/hooks/useAuth'
import type { Host } from './host'
import { Surface } from './Surface'

// The web tab (spec 25): a lazy route of the dashboard, inside its auth gate,
// that owns the whole page. With `?fake` it runs against the fake server
// instead of the API.

const BASE = '/computer/work'
// The Computer API takes the dashboard's cookie (spec 37); Live is `${API}/live`.
const API = '/api/managed-agents/computer'

function login(): Promise<never> {
  const returnTo = location.pathname + location.search
  location.replace(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`)
  return new Promise(() => {})
}

async function makeHost(fake: string | null, email?: string): Promise<Host> {
  if (fake !== null || import.meta.env.VITE_PREVIEW === '1') {
    const { fakeHost } = await import('./host-fake')
    return fakeHost({ base: BASE, seed: fake === 'empty' ? 'empty' : 'demo' })
  }
  // The principal as the server names it (`usr_…`, not the dashboard's user
  // id): every feed frame carries it, and the client drops frames that differ.
  const feed = await fetch(`${API}/feed?kinds=pref`, { credentials: 'include' })
  if (feed.status === 401) return login()
  if (!feed.ok) throw new Error(`feed ${feed.status}`)
  const { org, subject } = (await feed.json()) as {
    org: string
    subject: string
  }
  const { webHost } = await import('./host-web')
  return webHost({
    principal: { org, subject },
    name: email?.split('@')[0],
    api: API,
    base: BASE,
  })
}

// The org the surface is in, and the dashboard's switcher where there are more.
function Org() {
  const { user } = useAuth()
  const orgs = user?.orgs ?? []
  if (orgs.length > 1) return <OrgSwitcher />
  const active = orgs.find((o) => o.isActive) ?? orgs[0]
  return active ? (
    <span className="text-muted-foreground truncate text-[13px]">
      {active.name}
    </span>
  ) : null
}

export default function WebSurface() {
  const { user } = useAuth()
  const fake = new URLSearchParams(location.search).get('fake')
  // One host per org: switching org clears the query cache (useAuth), so the
  // surface is made again for the new principal. Never refetched otherwise —
  // a second fake server would leave `window.__fake` pointing at one nothing uses.
  const { data: host } = useQuery({
    queryKey: ['surface-host', user?.orgId, fake],
    queryFn: () => makeHost(fake, user?.email),
    enabled: !!user,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  return host ? <Surface host={host} account={<Org />} /> : null
}
