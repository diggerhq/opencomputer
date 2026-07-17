import {
  deploymentSlackPresentation,
  deploymentStage,
  type DeploymentSlackPresentation,
  type ManagedSlackStatus,
} from '@/lib/deployment-slack-cta'

export type AgentSetupStage = 'preparing' | 'ready' | 'failed'

export function agentSetupStage(input: {
  hasDeployment: boolean
  state?: string
  terminal?: boolean
  loadFailed: boolean
  canStartSession: boolean
  agentReady: boolean
  agentDeploymentState?: string
}): AgentSetupStage {
  if (!input.hasDeployment) {
    if (input.agentReady) return 'ready'
    if (
      [
        'failed',
        'canceled',
        'superseded',
        'skipped',
        'unverified',
        'not_deployed',
      ].includes(input.agentDeploymentState ?? '')
    ) {
      return 'failed'
    }
    return 'preparing'
  }

  // A status-read failure is not a deployment failure, but it also cannot
  // prove the deployment's authoritative start_session action. Preserve
  // independent Slack setup without promoting chat until the read recovers.
  if (input.loadFailed) return 'preparing'
  if (!input.state) return 'preparing'
  const stage = deploymentStage(input.state, input.terminal ?? false)
  if (stage === 'ready' && !input.canStartSession) return 'preparing'
  return stage === 'running' ? 'preparing' : stage
}

export interface AgentSetupPresentation extends DeploymentSlackPresentation {
  title: string
  description: string
}

export function agentSetupPresentation(input: {
  agentName: string
  stage: AgentSetupStage
  managedStatus: ManagedSlackStatus
  openUrl?: string | null
  connecting: boolean
  activated?: boolean
}): AgentSetupPresentation {
  const slack = deploymentSlackPresentation({
    deploymentState: input.stage === 'ready' ? 'ready' : input.stage,
    deploymentTerminal: input.stage !== 'preparing',
    canStartSession: input.stage === 'ready',
    managedStatus: input.managedStatus,
    openUrl: input.openUrl,
    connecting: input.connecting,
  })

  if (input.stage === 'failed') {
    return {
      ...slack,
      title: 'The deployment needs attention',
      description:
        input.managedStatus === 'active'
          ? 'Slack is connected. Review the failed deployment, then return here to start chatting.'
          : 'Review the failure and deploy again. You can finish Slack setup after the agent is ready.',
    }
  }

  if (input.managedStatus === 'active') {
    if (input.stage === 'ready' && input.openUrl) {
      if (input.activated) {
        return {
          ...slack,
          label: 'Continue in Slack',
          announcement:
            'Your first Slack message created an OpenComputer session.',
          title: `${input.agentName} is live in Slack`,
          description:
            'Your first message created a durable session. Keep chatting in Slack or open the full conversation in OpenComputer.',
        }
      }
      return {
        ...slack,
        title: 'Send your first message',
        description: `Open Slack, find OpenComputer, and say hello to ${input.agentName}.`,
      }
    }
    if (input.stage === 'ready') {
      return {
        ...slack,
        title: 'Slack is connected',
        description: `Open Slack, find OpenComputer, and say hello to ${input.agentName}.`,
      }
    }
    return {
      ...slack,
      title: 'Slack is connected',
      description: `We’re finishing ${input.agentName}’s deployment. Open Slack will appear here as soon as the agent is ready.`,
    }
  }

  if (input.stage === 'ready') {
    return {
      ...slack,
      title: `${input.agentName} is ready`,
      description:
        'Connect Slack to start chatting with your agent. OpenComputer’s app is the quickest way to try it.',
    }
  }

  return {
    ...slack,
    title: `Connect Slack while we prepare ${input.agentName}`,
    description:
      'Authorize the OpenComputer app now. The deployment will keep running in the background.',
  }
}
