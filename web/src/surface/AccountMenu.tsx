import { SELFHOST } from '@/lib/selfhost'
import { useNavigate } from 'react-router-dom'
import {
  CalendarClock,
  CreditCard,
  KeyRound,
  LockKeyhole,
  LogOut,
  Plug,
  Settings,
} from 'lucide-react'
import { logout } from '@/api/client'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from '@/hooks/useAuth'

// The web tab's way out to the rest of the dashboard: what the old sessions
// view had in its rail and account menu.
export function AccountMenu() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const org = user?.orgs?.find((o) => o.isActive)
  const who = user?.email ?? ''
  const go = (path: string) => () => void navigate(path)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open account menu"
          className="hover:bg-hover focus-visible:focus-ring -ml-1 flex min-w-0 items-center gap-2 rounded-md p-1 text-left outline-none"
        >
          <span className="bg-pressed text-foreground flex size-6 flex-none items-center justify-center rounded-full text-xs font-medium">
            {(who || '?').charAt(0).toUpperCase()}
          </span>
          <span className="truncate">{who.split('@')[0]}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-56">
        <DropdownMenuLabel className="truncate">
          {org?.name ?? 'Account'}
          <span className="text-muted-foreground block truncate text-xs font-normal">
            {who}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={go('/automations')}>
          <CalendarClock className="size-4 opacity-60" aria-hidden />
          Automations
        </DropdownMenuItem>
        <DropdownMenuItem onClick={go('/computer/secrets')}>
          <LockKeyhole className="size-4 opacity-60" aria-hidden />
          Secrets
        </DropdownMenuItem>
        <DropdownMenuItem onClick={go('/managed-agents/connections')}>
          <Plug className="size-4 opacity-60" aria-hidden />
          Connections
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={go('/settings')}>
          <Settings className="size-4 opacity-60" aria-hidden />
          Settings & members
        </DropdownMenuItem>
        <DropdownMenuItem onClick={go('/api-keys')}>
          <KeyRound className="size-4 opacity-60" aria-hidden />
          API keys
        </DropdownMenuItem>
        {!SELFHOST && (
          <DropdownMenuItem onClick={go('/billing')}>
            <CreditCard className="size-4 opacity-60" aria-hidden />
            Billing
          </DropdownMenuItem>
        )}
        {user?.capabilities?.signOut !== false && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void logout()}>
              <LogOut className="size-4 opacity-60" aria-hidden />
              Sign out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
