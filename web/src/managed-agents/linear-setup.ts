import type { ManagedLinearConnection, ManagedProjectOverview } from './api'
import {
  projectEnvironmentMode,
  projectEnvironments,
  type ProjectEnvironment,
} from './project-context'

/**
 * Linear agent connections: the pure parts of Project Connections → Linear.
 * Everything here is derived from API records and the URL; nothing is stored
 * in the browser (docs/agents/linear.mdx).
 */

export type LinearEnvironment = ProjectEnvironment

// ---------------------------------------------------------------------------
// The agent's name. It becomes the Linear app's name, which is how people see,
// delegate to and mention the agent in Linear. The platform applies the same
// rules; checking here keeps the customer from meeting them on Linear's page.

export const LINEAR_APP_NAME_MAX = 64
export const LINEAR_APP_NAME_RESERVED_MESSAGE =
  'Linear does not allow app names that contain "Linear". Choose another name.'
export const LINEAR_APP_NAME_LENGTH_MESSAGE =
  'The Linear app name must be 1 to 64 characters.'

export type LinearAppNameCheck =
  | { ok: true; name: string }
  | { ok: false; message: string }

export function checkLinearAppName(value: string): LinearAppNameCheck {
  const name = value.trim().replace(/\s+/g, ' ')
  if (
    !name ||
    name.length > LINEAR_APP_NAME_MAX ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    return { ok: false, message: LINEAR_APP_NAME_LENGTH_MESSAGE }
  }
  if (/linear/i.test(name)) {
    return { ok: false, message: LINEAR_APP_NAME_RESERVED_MESSAGE }
  }
  return { ok: true, name }
}

/** What the platform accepts for each credential: printable, no spaces. */
export function isLinearCredentialValue(value: string): boolean {
  return /^[\x21-\x7e]{1,512}$/.test(value)
}

// ---------------------------------------------------------------------------
// The only places the browser is sent from an API response. The platform
// builds both links, but the checks keep a wrong or tampered value from
// navigating anywhere but Linear's own pages.

export function linearCreateAppHref(url: string): string {
  const parsed = new URL(url)
  if (
    parsed.origin !== 'https://linear.app' ||
    parsed.pathname !== '/settings/api/applications/new'
  ) {
    throw new Error('Unexpected Linear create-app URL')
  }
  return url
}

export function linearAuthorizationHref(url: string): string {
  const parsed = new URL(url)
  if (
    parsed.origin !== 'https://linear.app' ||
    parsed.pathname !== '/oauth/authorize'
  ) {
    throw new Error('Unexpected Linear authorization URL')
  }
  return url
}

// ---------------------------------------------------------------------------
// Return from Linear's authorization page. The platform redirects the browser
// to the project's Connections tab with `linear=<result>&connection=<id>`; the
// panel shows the outcome once and removes both from the URL.

export const LINEAR_RETURN_RESULTS = [
  'connected',
  'denied',
  'failed',
  'expired',
  'superseded',
  'used',
] as const
export type LinearReturnResult = (typeof LINEAR_RETURN_RESULTS)[number]
export type LinearReturn = { result: LinearReturnResult; connectionId?: string }

export function linearReturnFromSearch(
  search: string,
): LinearReturn | undefined {
  const params = new URLSearchParams(search)
  const result = params.get('linear')
  if (!result || !(LINEAR_RETURN_RESULTS as readonly string[]).includes(result))
    return undefined
  const connectionId = params.get('connection') ?? undefined
  return { result: result as LinearReturnResult, connectionId }
}

export function withoutLinearReturn(search: string): string {
  const params = new URLSearchParams(search)
  params.delete('linear')
  params.delete('connection')
  const next = params.toString()
  return next ? `?${next}` : ''
}

export const LINEAR_RETURN_COPY: Record<
  LinearReturnResult,
  { title: string; description: string; tone: 'success' | 'error' }
> = {
  connected: {
    title: 'Linear agent authorized',
    description:
      'Delegate an issue to the agent in Linear, or mention it in a comment, to start its first session.',
    tone: 'success',
  },
  denied: {
    title: 'Authorization was declined',
    description:
      'The app was not installed. A Linear workspace admin must approve it; authorize again when one is ready.',
    tone: 'error',
  },
  failed: {
    title: 'Linear did not complete the authorization',
    description:
      'Check that the client ID and client secret match the app in Linear, then authorize again.',
    tone: 'error',
  },
  expired: {
    title: 'The authorization link expired',
    description: 'Authorize again to get a fresh link.',
    tone: 'error',
  },
  superseded: {
    title: 'That authorization is out of date',
    description:
      'The connection changed after the link was issued. Authorize again from its current setup.',
    tone: 'error',
  },
  used: {
    title: 'That authorization link was already used',
    description: 'Nothing changed. The connection’s current state is below.',
    tone: 'error',
  },
}

/** Why the last authorization or token refresh failed, in plain words. */
export function describeLinearVerificationError(
  code: string | undefined,
): string | undefined {
  switch (code) {
    case undefined:
    case '':
      return undefined
    case 'authorization_denied':
      return 'The last authorization was declined in Linear. A workspace admin must approve the app.'
    case 'authorization_failed':
      return 'Linear did not complete the last authorization. Check the client ID and client secret, then authorize again.'
    case 'refresh_rejected':
      return 'Linear stopped accepting the app’s access. Authorize it again to reconnect.'
    default:
      return 'The last authorization did not succeed. Authorize again.'
  }
}

// ---------------------------------------------------------------------------
// Rows: one per environment. Each binds to the agent the environment runs.

export type LinearRow = {
  environment: LinearEnvironment
  /** The environment's agent, when one is deployed there. */
  agentId?: string
  /** The live (not disconnected) connection for that environment, if any. */
  connection?: ManagedLinearConnection
}

export function linearRowsForProject(
  project: ManagedProjectOverview['project'],
  connections: readonly ManagedLinearConnection[],
): LinearRow[] {
  return projectEnvironments(projectEnvironmentMode(project)).map(
    (environment) => {
      const agentId = project.environments.find(
        (candidate) =>
          candidate.name === environment &&
          candidate.agentId &&
          candidate.activeDeploymentId,
      )?.agentId
      const live = connections.filter(
        (connection) =>
          connection.environment === environment &&
          connection.status !== 'disconnected',
      )
      const connection =
        live.find((candidate) => candidate.agentId === agentId) ?? live[0]
      return { environment, agentId, connection }
    },
  )
}

export type LinearRowAction = 'create' | 'continue' | 'authorize'

export type LinearRowView = {
  tone: 'idle' | 'pending' | 'waiting' | 'success' | 'error'
  title: string
  description: string
  /** The primary action the row offers. */
  primary?: { action: LinearRowAction; label: string }
  /** Health is polled while the connection waits for its first event. */
  poll: boolean
}

export function describeLinearRow(row: LinearRow): LinearRowView {
  const connection = row.connection
  if (!connection) {
    if (!row.agentId) {
      return {
        tone: 'idle',
        title: 'Not connected',
        description: `Deploy an agent to ${row.environment} to connect it to Linear.`,
        poll: false,
      }
    }
    return {
      tone: 'idle',
      title: 'Not connected',
      description:
        'Create a Linear app for this agent so people can delegate issues to it.',
      primary: { action: 'create', label: 'Create Linear agent' },
      poll: false,
    }
  }
  const failure = describeLinearVerificationError(connection.verificationError)
  const state =
    connection.health?.state ??
    (connection.status === 'revoked'
      ? 'revoked'
      : connection.status === 'connected'
        ? 'waiting_for_first_delegation'
        : connection.clientId
          ? 'awaiting_authorization'
          : 'awaiting_credentials')
  switch (state) {
    case 'awaiting_credentials':
      return {
        tone: 'pending',
        title: 'Setup in progress',
        description:
          'Create the app in Linear, then paste its client ID, client secret and webhook signing secret.',
        primary: { action: 'continue', label: 'Continue setup' },
        poll: false,
      }
    case 'awaiting_authorization':
      return {
        tone: failure ? 'error' : 'pending',
        title: failure ? 'Authorization did not finish' : 'Ready to authorize',
        description:
          failure ??
          'Authorize the app in Linear to finish setup. A Linear workspace admin must approve it.',
        primary: { action: 'authorize', label: 'Authorize in Linear' },
        poll: false,
      }
    case 'waiting_for_first_delegation':
      return {
        tone: 'waiting',
        title: 'Waiting for the first delegation',
        description: `Authorized. In Linear, delegate an issue to ${connection.name} or mention it in a comment.`,
        poll: true,
      }
    case 'receiving':
      return {
        tone: 'success',
        title: 'First session received',
        description: `${connection.name} is receiving delegations from Linear.`,
        poll: false,
      }
    case 'revoked':
      return {
        tone: 'error',
        title: 'Access revoked',
        description:
          failure ??
          'The app’s access was revoked in Linear. Authorize it again to reconnect.',
        primary: { action: 'authorize', label: 'Authorize in Linear' },
        poll: false,
      }
  }
}

/** The time of the last Linear event, when the platform has seen one. */
export function linearLastEventAt(
  connection: ManagedLinearConnection | undefined,
): string | undefined {
  return connection?.health?.lastEventAt ?? connection?.lastEventAt
}

/** Whether any connection is authorized but has not yet seen a Linear event. */
export function linearNeedsPolling(
  connections: readonly ManagedLinearConnection[] | undefined,
): boolean {
  return (connections ?? []).some(
    (connection) =>
      connection.status !== 'disconnected' &&
      connection.health?.state === 'waiting_for_first_delegation',
  )
}
