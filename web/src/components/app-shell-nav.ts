import {
  Bot,
  Boxes,
  FolderKanban,
  KeySquare,
  Layers,
  MessagesSquare,
  Monitor,
  Package,
  Plug,
  Webhook,
  type LucideIcon,
} from 'lucide-react'

type NavItem = {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
  preview?: boolean
}

export type NavGroup = {
  label?: string
  items: NavItem[]
  collapsible?: boolean
  landingTo?: string
}

const MANAGED_AGENTS_NAV: NavGroup[] = [
  {
    items: [
      { to: '/', label: 'Projects', icon: FolderKanban, end: true },
      {
        to: '/managed-agents/connections',
        label: 'Connections',
        icon: Plug,
      },
    ],
  },
  {
    label: 'Durable sessions',
    collapsible: true,
    landingTo: '/agents',
    items: [
      { to: '/agents', label: 'Agents', icon: Bot, preview: true },
      {
        to: '/sessions',
        label: 'Sessions',
        icon: MessagesSquare,
        preview: true,
      },
      {
        to: '/credentials',
        label: 'Credentials',
        icon: KeySquare,
        preview: true,
      },
    ],
  },
  {
    label: 'Infrastructure',
    collapsible: true,
    landingTo: '/sandboxes',
    items: [
      { to: '/sandboxes', label: 'Sandboxes', icon: Boxes },
      { to: '/checkpoints', label: 'Checkpoints', icon: Layers },
      { to: '/templates', label: 'Sandbox templates', icon: Package },
      { to: '/sandbox-webhooks', label: 'Webhooks', icon: Webhook },
      { to: '/browsers', label: 'Browsers', icon: Monitor },
    ],
  },
]

export function managedAgentsNav(preferences: {
  durableSessionsEnabled: boolean
  infrastructureEnabled: boolean
}): NavGroup[] {
  return MANAGED_AGENTS_NAV.filter((group) => {
    if (group.label === 'Durable sessions') {
      return preferences.durableSessionsEnabled
    }
    if (group.label === 'Infrastructure') {
      return preferences.infrastructureEnabled
    }
    return true
  })
}
