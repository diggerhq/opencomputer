import {
  ArrowLeft,
  BookOpen,
  Bot,
  Boxes,
  BrainCircuit,
  CalendarClock,
  Computer,
  CreditCard,
  Database,
  FolderKanban,
  KeySquare,
  Layers,
  MessagesSquare,
  Monitor,
  Package,
  Plug,
  Radar,
  Rocket,
  Settings,
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

export function managedAgentsNav(options: {
  projectId?: string
  durableSessionsEnabled: boolean
  infrastructureEnabled: boolean
  computerEnabled?: boolean
  swarmEnabled?: boolean
}): NavGroup[] {
  const groups: NavGroup[] = []

  if (options.projectId) {
    const projectPath = `/projects/${encodeURIComponent(options.projectId)}`
    groups.push(
      {
        items: [
          {
            to: '/automations',
            label: 'Back to all automations',
            icon: ArrowLeft,
          },
        ],
      },
      {
        items: [
          // Only CVE Swarm projects declare the findings resource, so the
          // Swarms list is offered just for them.
          ...(options.swarmEnabled
            ? [{ to: `${projectPath}/swarms`, label: 'Swarms', icon: Radar }]
            : []),
          {
            to: `${projectPath}/deployments`,
            label: 'Deployments',
            icon: Rocket,
          },
          {
            to: `${projectPath}/sessions`,
            label: 'Sessions',
            icon: MessagesSquare,
          },
          {
            to: `${projectPath}/schedules`,
            label: 'Schedules',
            icon: CalendarClock,
          },
          {
            to: `${projectPath}/webhooks`,
            label: 'Webhooks',
            icon: Webhook,
          },
          {
            to: `${projectPath}/memory`,
            label: 'Memory',
            icon: BookOpen,
          },
          {
            to: `${projectPath}/database`,
            label: 'Database',
            icon: Database,
          },
          {
            to: `${projectPath}/secrets`,
            label: 'Secrets',
            icon: KeySquare,
          },
          {
            to: `${projectPath}/connections`,
            label: 'Connections',
            icon: Plug,
          },
          {
            to: `${projectPath}/byok`,
            label: 'BYOK',
            icon: BrainCircuit,
          },
          {
            to: projectPath,
            label: 'Debug playground',
            icon: Bot,
            end: true,
          },
          {
            to: `${projectPath}/settings`,
            label: 'Settings',
            icon: Settings,
          },
        ],
      },
    )

    return groups
  }

  if (!options.projectId) {
    // The organization's computer comes first (work 052); Automations (the
    // project list) is always there, so the computer's automations have a
    // place to show up before the first one exists.
    groups.push({
      items: [
        ...(options.computerEnabled
          ? [{ to: '/computer', label: 'Computer', icon: Computer }]
          : []),
        { to: '/automations', label: 'Automations', icon: FolderKanban },
        { to: '/billing', label: 'Billing', icon: CreditCard },
      ],
    })
  }

  groups.push({
    label: 'Account',
    items: [
      {
        to: '/managed-agents/connections',
        label: 'Connections',
        icon: Plug,
      },
    ],
  })

  if (options.durableSessionsEnabled) {
    groups.push({
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
    })
  }

  if (options.infrastructureEnabled) {
    groups.push({
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
    })
  }

  return groups
}
