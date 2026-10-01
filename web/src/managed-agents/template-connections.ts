import {
  getManagedAgentConnections,
  refreshManagedAgentConnection,
  type ManagedAgentConnection,
  type TemplateInspection,
} from './api'

export type TemplateConnectionRequirement =
  TemplateInspection['requirements']['connections'][number]

// Providers whose single grant can be linked from the template page. Google
// grants are split by service, so a bare `google` requirement is linked from
// the Connections page instead.
const LINKABLE_PROVIDERS: Readonly<Record<string, string>> = {
  github: 'GitHub',
  linear: 'Linear',
  notion: 'Notion',
  searchconsole: 'Google Search Console',
}

export function templateConnectionName(provider: string) {
  return (
    LINKABLE_PROVIDERS[provider] ??
    (provider === 'google' ? 'Google' : provider)
  )
}

export function templateConnectionLinkable(provider: string) {
  return Object.prototype.hasOwnProperty.call(LINKABLE_PROVIDERS, provider)
}

export function templateConnectionConnected(
  requirement: Pick<TemplateConnectionRequirement, 'provider'>,
  connections: readonly Pick<ManagedAgentConnection, 'provider' | 'status'>[],
) {
  return connections.some(
    (connection) =>
      connection.provider === requirement.provider &&
      connection.status === 'connected',
  )
}

export function missingTemplateConnection(
  requirements: readonly Pick<
    TemplateConnectionRequirement,
    'provider' | 'required'
  >[],
  connections: readonly Pick<ManagedAgentConnection, 'provider' | 'status'>[],
) {
  return requirements.some(
    (requirement) =>
      requirement.required &&
      !templateConnectionConnected(requirement, connections),
  )
}

/** Lists tool connections, first settling any pending linkable grants. */
export async function loadTemplateConnections() {
  const current = await getManagedAgentConnections()
  const pending = current.filter(
    (connection) =>
      connection.status === 'pending' &&
      templateConnectionLinkable(connection.provider),
  )
  if (!pending.length) return current
  await Promise.allSettled(
    pending.map((connection) =>
      refreshManagedAgentConnection(
        connection.provider,
        connection.provider,
        connection.id,
      ),
    ),
  )
  return getManagedAgentConnections()
}
