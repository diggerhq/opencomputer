import type { ProjectEnvironment } from './project-context'
import { projectEnvironmentSearch } from './project-context'

export type FirstSessionStep = {
  id: 'slack' | 'schedules' | 'webhooks' | 'code'
  title: string
  description: string
  to?: string
  command?: string
}

export const FIRST_SESSION_DEPLOY_COMMAND = 'npm run deploy -- --watch'

/**
 * The guide belongs to the moment right after the very first exchange: the
 * project has at most this one session, the agent has answered, and nothing is
 * running. A second session of any source means the user already found a next
 * step, so the guide retires on its own.
 */
export function firstSessionGuideVisible({
  sessionCount,
  hasResponse,
  agentWorking,
}: {
  sessionCount: number
  hasResponse: boolean
  agentWorking: boolean
}) {
  return sessionCount <= 1 && hasResponse && !agentWorking
}

export function firstSessionSteps(
  projectId: string,
  environment: ProjectEnvironment,
): FirstSessionStep[] {
  const base = `/projects/${encodeURIComponent(projectId)}`
  const search = projectEnvironmentSearch('', environment)
  return [
    {
      id: 'slack',
      title: 'Talk to it from Slack',
      description:
        'Install the Slack app so this agent answers in a channel instead of the playground.',
      to: `${base}/connections${search}`,
    },
    {
      id: 'schedules',
      title: 'Run it on a schedule',
      description:
        'Have the agent start a session on its own — hourly, nightly, or on any cron.',
      to: `${base}/schedules${search}`,
    },
    {
      id: 'webhooks',
      title: 'Trigger it from other systems',
      description:
        'Create a webhook so CI, an issue tracker, or your own code can start sessions.',
      to: `${base}/webhooks${search}`,
    },
    {
      id: 'code',
      title: 'Change what it does',
      description:
        'Edit the agent in your local checkout; every save redeploys while this runs:',
      command: FIRST_SESSION_DEPLOY_COMMAND,
    },
  ]
}
