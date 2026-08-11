import {
  ArrowLeft,
  Bot,
  Boxes,
  CalendarClock,
  KeySquare,
  Layers,
  MessagesSquare,
  Monitor,
  Package,
  Radio,
  Rocket,
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
}): NavGroup[] {
  const groups: NavGroup[] = []

  if (options.projectId) {
    const projectPath = `/projects/${encodeURIComponent(options.projectId)}`
    groups.push(
      {
        items: [
          {
            to: '/',
            label: 'Back to all projects',
            icon: ArrowLeft,
          },
        ],
      },
      {
        items: [
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
            to: `${projectPath}/channels`,
            label: 'Channels',
            icon: Radio,
          },
          {
            to: `${projectPath}/schedules`,
            label: 'Schedules',
            icon: CalendarClock,
          },
          {
            to: `${projectPath}/secrets`,
            label: 'Secrets',
            icon: KeySquare,
          },
          {
            to: projectPath,
            label: 'Debug playground',
            icon: Bot,
            end: true,
          },
        ],
      },
    )
  }

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
