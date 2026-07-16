const MANAGED_SLACK_RESULTS = new Set([
  'connected',
  'oauth_denied',
  'oauth_state_invalid',
  'oauth_state_expired',
  'oauth_exchange_failed',
  'oauth_scope_missing',
  'enterprise_install_unsupported',
  'slack_upstream_unavailable',
  'agent_not_ready',
  'workspace_already_connected',
])

export function managedSlackNotice(
  result: string | null,
  workspace: string | null | undefined,
  agentName: string,
  connectedAgentName?: string | null,
): { title: string; description?: string; destructive?: boolean } | null {
  if (!result || !MANAGED_SLACK_RESULTS.has(result)) return null
  switch (result) {
    case 'connected':
      return {
        title: 'Slack connected',
        description: workspace
          ? `OpenComputer will send messages in ${workspace} to ${agentName}.`
          : `OpenComputer will send Slack messages to ${agentName}.`,
      }
    case 'oauth_denied':
      return { title: 'Slack connection was canceled' }
    case 'oauth_state_invalid':
    case 'oauth_state_expired':
      return {
        title: 'Slack connection session expired',
        description: 'Connect Slack again.',
        destructive: true,
      }
    case 'oauth_scope_missing':
      return {
        title: 'Slack permissions are incomplete',
        description: 'Reconnect and approve the requested permissions.',
        destructive: true,
      }
    case 'enterprise_install_unsupported':
      return {
        title: 'Enterprise Grid installation is not supported yet',
        description: 'Install the app in a single Slack workspace instead.',
        destructive: true,
      }
    case 'agent_not_ready':
      return {
        title: 'This agent cannot connect to Slack yet',
        description: 'Finish its initial setup, then try again.',
        destructive: true,
      }
    case 'workspace_already_connected':
      return {
        title: 'This Slack workspace is already connected',
        description: connectedAgentName
          ? `This workspace sends messages to ${connectedAgentName}. Disconnect it below before connecting it to ${agentName}.`
          : 'Connect a different workspace or use your own Slack app for this agent.',
        destructive: true,
      }
    case 'oauth_exchange_failed':
    case 'slack_upstream_unavailable':
      return {
        title: "Slack couldn't complete the connection",
        description: 'Try again in a moment.',
        destructive: true,
      }
    default:
      return null
  }
}
