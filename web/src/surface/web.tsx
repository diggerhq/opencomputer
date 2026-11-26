import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { OrgSwitcher } from '@/components/app-shell'
import { BillingWarningBanner, HaltModal } from '@/components/billing-surfaces'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/useAuth'
import { AccountMenu } from './AccountMenu'
import type { Host } from './host'
import { Surface } from './Surface'

// The web tab (spec 25): a lazy route of the dashboard, inside its auth gate,
// that owns the whole page. In development and previews, `?fake` shows it
// over recorded data instead of the API (host-demo.ts), to look at; a
// production build has none.

const BASE = '/computer/work'
// The Computer API takes the dashboard's cookie (spec 37); Live is `${API}/live`.
const API = '/api/managed-agents/computer'

function login(): Promise<never> {
  const returnTo = location.pathname + location.search
  location.replace(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`)
  return new Promise(() => {})
}

const FAKE_ALLOWED = import.meta.env.DEV || import.meta.env.VITE_PREVIEW === '1'

async function makeHost(fake: string | null, email?: string): Promise<Host> {
  if (FAKE_ALLOWED && (fake !== null || import.meta.env.VITE_PREVIEW === '1')) {
    const { demoHost } = await import('./host-demo')
    return demoHost({ base: BASE, empty: fake === 'empty' })
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
  // surface is made again for the new principal. Never refetched otherwise.
  const {
    data: host,
    isError,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['surface-host', user?.orgId, fake],
    queryFn: () => makeHost(fake, user?.email),
    enabled: !!user,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  if (host)
    return (
      <Surface
        host={host}
        account={<Org />}
        me={<AccountMenu />}
        banner={
          <>
            <BillingWarningBanner />
            <HaltModal />
          </>
        }
      />
    )
  return (
    <div className="bg-background text-muted-foreground fixed inset-0 flex flex-col items-center justify-center gap-3 text-sm">
      {isError ? (
        <>
          <p>Could not reach your computer.</p>
          <Button
            size="sm"
            variant="outline"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            Try again
          </Button>
        </>
      ) : (
        <Loader2 className="size-5 animate-spin" aria-label="Loading" />
      )}
    </div>
  )
}
