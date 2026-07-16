import {
  deploymentSlackPresentation,
  type DeploymentSlackPresentation,
  type ManagedSlackStatus,
} from '@/lib/deployment-slack-cta'

export type AgentSetupStage = 'preparing' | 'ready' | 'failed'

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
}): AgentSetupPresentation {
  const slack = deploymentSlackPresentation({
    deploymentState: input.stage === 'ready' ? 'ready' : input.stage,
    deploymentTerminal: input.stage !== 'preparing',
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
