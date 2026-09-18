import type {
  ManagedAgentChannel,
  ManagedAgentDeployment,
  ManagedProjectOverview,
  ManagedSlackSetup,
} from './api'

/**
 * Automated Slack setup: the pure parts of Project Connections → Slack.
 * Everything here is derived from API records and the URL; nothing is stored
 * in the browser (docs/agents/channels.mdx "Connect Slack").
 */

export const SLACK_APPS_URL = 'https://api.slack.com/apps'
export const SLACK_CONFIGURATION_TOKEN_STEPS = [
  'Under Your App Configuration Tokens, choose Generate Token.',
  'Choose the workspace the bot will live in.',
  'Copy the Access Token (not the Refresh Token).',
] as const

/** A UUID satisfies the platform's 16..128 chars of [A-Za-z0-9_-]. */
export function newSlackSetupRequestKey(): string {
  return crypto.randomUUID()
}

/**
 * The only place the browser is sent from an API response. The platform
 * builds the URL itself, but the check keeps a wrong or tampered value from
 * navigating anywhere but Slack's consent page.
 */
export function slackAuthorizationHref(url: string): string {
  const parsed = new URL(url)
  if (
    parsed.origin !== 'https://slack.com' ||
    parsed.pathname !== '/oauth/v2/authorize'
  ) {
    throw new Error('Unexpected Slack authorization URL')
  }
  return url
}

// ---------------------------------------------------------------------------
// Return from Slack's consent page. The platform redirects the browser to the
// project's Connections tab with these two parameters; the tab shows the
// outcome once and removes them from the URL.

export const SLACK_RETURN_RESULTS = [
  'connected',
  'authorization_denied',
  'authorization_expired',
  'exchange_failed',
  'app_mismatch',
  'workspace_mismatch',
  'scope_missing',
  'enterprise_install_unsupported',
  'superseded',
  'provider_unavailable',
] as const
export type SlackReturnResult = (typeof SLACK_RETURN_RESULTS)[number]
export type SlackReturn = { result: SlackReturnResult; setupId?: string }

export function slackReturnFromSearch(search: string): SlackReturn | undefined {
  const params = new URLSearchParams(search)
  const result = params.get('slack')
  if (!result || !(SLACK_RETURN_RESULTS as readonly string[]).includes(result))
    return undefined
  const setupId = params.get('setup') ?? undefined
  return { result: result as SlackReturnResult, setupId }
}

export function withoutSlackReturn(search: string): string {
  const params = new URLSearchParams(search)
  params.delete('slack')
  params.delete('setup')
  const next = params.toString()
  return next ? `?${next}` : ''
}

export const SLACK_RETURN_COPY: Record<
  SlackReturnResult,
  { title: string; description: string; tone: 'success' | 'error' }
> = {
  connected: {
    title: 'Slack app installed',
    description:
      'Invite the bot to a channel and mention it to start a conversation.',
    tone: 'success',
  },
  authorization_denied: {
    title: 'Installation was declined',
    description:
      'The app is kept. Authorize again when you are ready to install it.',
    tone: 'error',
  },
  authorization_expired: {
    title: 'The authorization link expired',
    description: 'Authorize again to get a fresh link; the app is kept.',
    tone: 'error',
  },
  exchange_failed: {
    title: 'Slack did not confirm the installation',
    description: 'Authorize again; the app is kept.',
    tone: 'error',
  },
  app_mismatch: {
    title: 'A different Slack app was installed',
    description: 'Authorize again and approve the app created for this agent.',
    tone: 'error',
  },
  workspace_mismatch: {
    title: 'Installed to a different workspace',
    description:
      'This connection is bound to the workspace it was first installed in. Authorize again and choose that workspace.',
    tone: 'error',
  },
  scope_missing: {
    title: 'A declared permission is missing',
    description:
      'The installation did not grant every scope the deployment declares. Authorize again to reinstall with the current manifest.',
    tone: 'error',
  },
  enterprise_install_unsupported: {
    title: 'Organization-wide installs are not supported',
    description: 'Authorize again and install the app into a single workspace.',
    tone: 'error',
  },
  superseded: {
    title: 'Another connection change completed first',
    description:
      'A manual connection or reconnect won. Check the current connection below.',
    tone: 'error',
  },
  provider_unavailable: {
    title: 'Slack was unavailable',
    description: 'Authorize again in a moment; the app is kept.',
    tone: 'error',
  },
}

// ---------------------------------------------------------------------------
// What the setup card says, and which action it leads with, for every phase
// and error the platform can report. Buttons come from `setup.actions`; this
// only decides copy and which permitted action is primary.

export type SlackSetupView = {
  title: string
  description: string
  tone: 'idle' | 'pending' | 'error' | 'success'
  /** The permitted action to lead with, and its button label. */
  primary?: { action: 'create' | 'authorize'; label: string }
}

function retryAfter(ms?: number) {
  if (!ms) return 'a moment'
  const seconds = Math.ceil(ms / 1000)
  return seconds < 60
    ? `${seconds} second${seconds === 1 ? '' : 's'}`
    : `${Math.ceil(seconds / 60)} minutes`
}

export function describeSlackSetup(
  setup: ManagedSlackSetup | null | undefined,
): SlackSetupView {
  if (setup?.error?.code === 'slack_setup_superseded') {
    return {
      title: 'This setup no longer owns the connection',
      description:
        'A manual connection or reconnect replaced it. Set up manually, or create a new bot.',
      tone: 'error',
      primary: { action: 'create', label: 'Create Slack bot' },
    }
  }
  if (setup?.phase === 'cancelled') {
    // The record carries what a cancellation leaves behind: possibly an app
    // in the workspace's app list, which the platform never deletes.
    return {
      title: 'Setup cancelled',
      description:
        setup.error?.message ??
        "The Slack app may still appear in your workspace's app list and can be removed there.",
      tone: 'idle',
      primary: { action: 'create', label: 'Create Slack bot' },
    }
  }
  if (!setup) {
    return {
      title: 'Not connected',
      description:
        'Create a dedicated Slack app for this channel. You will need a Slack configuration access token; installation is approved in Slack.',
      tone: 'idle',
      primary: { action: 'create', label: 'Create Slack bot' },
    }
  }
  const name = setup.app?.name ?? setup.name
  const error = setup.error
  switch (setup.phase) {
    case 'prepared': {
      if (!error) {
        return {
          title: 'Ready to create the app',
          description: `Submit a configuration access token to create the Slack app ${name}.`,
          tone: 'idle',
          primary: { action: 'create', label: 'Create Slack bot' },
        }
      }
      // Only an explicit rejection with no side effect is retried with a
      // new token; anything the platform marks unrecoverable is not.
      const retry = error.recoverable
        ? ({ action: 'create', label: 'Try another token' } as const)
        : undefined
      switch (error.code) {
        case 'slack_configuration_token_invalid':
          return {
            title: 'Slack rejected the configuration token',
            description:
              'Generate a new token at api.slack.com/apps and submit it again. Nothing was created; this setup is kept.',
            tone: 'error',
            primary: retry,
          }
        case 'slack_configuration_token_expired':
          return {
            title: 'The configuration token expired',
            description:
              'Configuration tokens expire 12 hours after they are generated. Generate a new one and submit it again.',
            tone: 'error',
            primary: retry,
          }
        case 'slack_manifest_rejected':
          return {
            title: 'Slack rejected the app manifest',
            description: `${error.message} Fix the channel declaration and redeploy, then ${
              error.recoverable
                ? 'submit a token again.'
                : 'Cancel this setup and create the bot again, or set it up manually.'
            }`,
            tone: 'error',
            primary: retry,
          }
        case 'slack_app_limit_reached':
          return {
            title: 'The workspace has reached its app limit',
            description:
              'Remove an unused app in Slack or generate the token for another workspace, then submit it again.',
            tone: 'error',
            primary: retry,
          }
        case 'slack_rate_limited':
          return {
            title: 'Slack is rate limiting app creation',
            description: `Wait ${retryAfter(error.retryAfterMs)} and submit the token again.`,
            tone: 'error',
            primary: retry,
          }
        case 'slack_provider_unavailable':
          return {
            title: 'Slack was unavailable',
            description:
              'Nothing was created. Submit the token again in a moment.',
            tone: 'error',
            primary: retry,
          }
        default:
          return {
            title: 'The app was not created',
            description: `${error.message} Correct the input and submit a token again.`,
            tone: 'error',
            primary: retry,
          }
      }
    }
    case 'creating':
      return {
        title: 'Creating the Slack app…',
        description: `Slack is creating ${name}. This usually takes a few seconds.`,
        tone: 'pending',
      }
    case 'creation_uncertain':
      return {
        title: 'The result of app creation was lost',
        description: `Slack may or may not have created ${name}. Check your Slack app list: if the app exists, finish with Set up manually using its credentials; if it does not, cancel this setup and create a new one.`,
        tone: 'error',
      }
    case 'app_created': {
      const authorize = {
        action: 'authorize',
        label: 'Authorize again',
      } as const
      if (!error) {
        return {
          title: 'App created. Approve its installation in Slack',
          description: `Authorize ${name} to install it into your workspace. Slack asks you to approve the permissions declared in code.`,
          tone: 'idle',
          primary: { action: 'authorize', label: 'Authorize in Slack' },
        }
      }
      switch (error.code) {
        case 'slack_authorization_denied':
          return {
            title: 'Installation was declined',
            description: `${name} is kept. Authorize again when you are ready to install it.`,
            tone: 'error',
            primary: authorize,
          }
        case 'slack_authorization_expired':
          return {
            title: 'The authorization link expired',
            description:
              'Links last ten minutes. Authorize again to get a fresh one; the app is kept.',
            tone: 'error',
            primary: authorize,
          }
        case 'slack_exchange_failed':
          return {
            title: 'Slack did not confirm the installation',
            description:
              'The installation could not be completed with Slack. Authorize again; the app is kept.',
            tone: 'error',
            primary: authorize,
          }
        case 'slack_exchange_uncertain':
        case 'slack_provider_unavailable':
          return {
            title: 'The installation could not be confirmed',
            description:
              'Slack did not confirm the installation in time. Authorize again; the app is kept.',
            tone: 'error',
            primary: authorize,
          }
        case 'slack_app_mismatch':
          return {
            title: 'A different app was installed',
            description: `Slack returned an installation for another app. Authorize again and approve ${name}.`,
            tone: 'error',
            primary: authorize,
          }
        case 'slack_workspace_mismatch':
          return {
            title: 'Installed to a different workspace',
            description: `This connection is bound to ${setup.workspace?.name ?? 'the workspace it was first installed in'}. Authorize again and choose that workspace.`,
            tone: 'error',
            primary: authorize,
          }
        case 'slack_scope_missing':
          return {
            title: 'A declared permission is missing',
            description:
              'The installation did not grant every scope the deployment declares. Authorize again to reinstall with the current manifest.',
            tone: 'error',
            primary: authorize,
          }
        case 'slack_enterprise_install_unsupported':
          return {
            title: 'Organization-wide installs are not supported',
            description:
              'Authorize again and install the app into a single workspace.',
            tone: 'error',
            primary: authorize,
          }
        default:
          return {
            title: 'The installation did not complete',
            description: `${error.message} Authorize again; the app is kept.`,
            tone: 'error',
            primary: authorize,
          }
      }
    }
    case 'exchanging':
      return {
        title: 'Confirming the installation…',
        description: 'Slack approved the installation; checking the bot.',
        tone: 'pending',
      }
    case 'connected':
      return {
        title: 'Slack app installed',
        description: `Invite @${name} to a channel${setup.workspace ? ` in ${setup.workspace.name}` : ''} and mention it to start a conversation.`,
        tone: 'success',
      }
  }
}

/**
 * Connected credentials are not a working channel: the first real message is
 * what proves events arrive and are signed correctly. A URL-verification
 * challenge does not count.
 */
export type SlackVerificationView = {
  state: 'waiting' | 'verified' | 'rejected'
  title: string
  description: string
}

export function describeSlackVerification(
  connection: ManagedAgentChannel,
  botName: string,
): SlackVerificationView {
  if (connection.verificationError) {
    return {
      state: 'rejected',
      title: 'Slack events are being rejected',
      description:
        'The signing secret does not match. Edit the credentials and send the bot a message again.',
    }
  }
  if (connection.verifiedAt) {
    return {
      state: 'verified',
      title: 'First message received',
      description: 'The bot is listening for Slack messages.',
    }
  }
  return {
    state: 'waiting',
    title: 'Waiting for the first message',
    description: `Credentials are connected. In Slack, invite @${botName} to a channel and mention it.`,
  }
}

// ---------------------------------------------------------------------------
// Slots: what the environment can connect. One per declared Slack channel,
// consumed by every agent that registers it; plus the dedicated app for an
// agent whose deployment declares no channel at all.

export type SlackSlot = {
  key: string
  /** Undefined for a dedicated app: the platform stores it under `slack`. */
  channelId?: string
  name: string
  dedicated: boolean
  /** The agent the connection and setup are keyed by. */
  agentId: string
  /** Agents whose registrations consume this channel. */
  consumers: string[]
  destinations: string[]
  connection?: ManagedAgentChannel
}

export const DEDICATED_SLACK_CHANNEL_ID = 'slack'

/**
 * The automated setup card's element id for a target, so the manual wizard
 * can point at it when a manual completion is blocked by that setup.
 */
export function slackSetupAnchorId(target: {
  agentId: string
  alias: string
  channelId?: string
}): string {
  return `slack-setup-${target.agentId}-${target.alias}-${target.channelId ?? DEDICATED_SLACK_CHANNEL_ID}`
}

export function slackSlotsForEnvironment(input: {
  project: ManagedProjectOverview['project']
  deployments: ManagedAgentDeployment[]
  channels: ManagedAgentChannel[]
  environment: 'development' | 'production'
}): SlackSlot[] {
  const projectAgentIds = new Set(input.project.agents.map((agent) => agent.id))
  const live = input.channels.filter(
    (channel) =>
      channel.alias === input.environment &&
      channel.status !== 'disconnected' &&
      projectAgentIds.has(channel.agentId),
  )
  const declared = new Map<
    string,
    {
      name: string
      destinations: string[]
      declaredBy: string[]
      registeredBy: string[]
    }
  >()
  const dedicated: SlackSlot[] = []

  for (const deployment of input.deployments) {
    const reference = deployment.projectDeployment
    const slackChannels =
      reference?.resources.channels.filter(
        (channel) => channel.type === 'slack',
      ) ?? []
    if (!reference || slackChannels.length === 0) {
      const connection = live.find(
        (channel) =>
          channel.agentId === deployment.agentId &&
          channel.channelId === DEDICATED_SLACK_CHANNEL_ID,
      )
      dedicated.push({
        key: `dedicated:${deployment.agentId}`,
        name: 'Dedicated Slack app',
        dedicated: true,
        agentId: deployment.agentId,
        consumers: [deployment.agentId],
        destinations: [],
        connection,
      })
      continue
    }
    const localToAgent = new Map(
      reference.agents.map((agent) => [agent.localId, agent.agentId]),
    )
    localToAgent.set(reference.localAgentId, deployment.agentId)
    for (const channel of slackChannels) {
      const entry = declared.get(channel.id) ?? {
        name: channel.displayName ?? channel.id,
        destinations: Object.keys(channel.destinations),
        declaredBy: [],
        registeredBy: [],
      }
      entry.declaredBy.push(deployment.agentId)
      for (const registration of reference.resources.channelRegistrations) {
        if (registration.channelId !== channel.id) continue
        const agentId = localToAgent.get(registration.agentId)
        if (agentId) entry.registeredBy.push(agentId)
      }
      declared.set(channel.id, entry)
    }
  }

  const slots: SlackSlot[] = [...declared.entries()].map(
    ([channelId, entry]) => {
      const connection = live.find((channel) => channel.channelId === channelId)
      const fromConnection = connection?.agents ?? []
      const consumers = unique(
        fromConnection.length
          ? fromConnection
          : entry.registeredBy.length
            ? entry.registeredBy
            : entry.declaredBy,
      ).sort()
      return {
        key: `channel:${channelId}`,
        channelId,
        name: entry.name,
        dedicated: false,
        // The connection and its setup are keyed by one agent. With a
        // connection that is its owner; without one, the first consumer in
        // sorted order, so the slot is the same whichever deployment the
        // page loaded first.
        agentId:
          connection?.agentId ??
          consumers[0] ??
          [...entry.declaredBy].sort()[0],
        consumers,
        destinations: entry.destinations,
        connection,
      }
    },
  )
  return [...slots, ...dedicated]
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
