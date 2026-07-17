import { Fragment } from 'react'
import { Check, Circle, CircleAlert, Loader2 } from 'lucide-react'
import type { AgentDeployment, AgentDeploymentLog } from '@/api/client'
import { cn } from '@/lib/utils'

const PHASES = [
  {
    label: 'Prepare',
    states: [
      'accepted',
      'queued',
      'fetching',
      'validating',
      'installing',
      'source',
      'install',
    ],
  },
  { label: 'Build', states: ['building', 'uploading', 'build', 'artifact'] },
  { label: 'Deploy', states: ['deploying', 'verifying', 'deploy', 'verify'] },
] as const

function failedPhase(deployment: AgentDeployment): string | undefined {
  const phase = deployment.error?.phase?.toLowerCase()
  if (phase) return phase
  const errorClass = deployment.error_class?.toLowerCase() ?? ''
  return PHASES.find(({ states, label }) =>
    [...states, label.toLowerCase()].some((state) =>
      errorClass.includes(state),
    ),
  )?.label.toLowerCase()
}

function phaseIndex(deployment: AgentDeployment): number {
  if (deployment.state === 'ready') return PHASES.length
  const state =
    deployment.state === 'failed'
      ? failedPhase(deployment)
      : deployment.phase.toLowerCase()
  return PHASES.findIndex(
    ({ label, states }) =>
      label.toLowerCase() === state || states.some((item) => item === state),
  )
}

export function DeploymentPhases({
  deployment,
  align = 'end',
}: {
  deployment: AgentDeployment
  align?: 'start' | 'end'
}) {
  const current = phaseIndex(deployment)
  const failed = deployment.state === 'failed'
  const terminalWithoutPhase = failed && current < 0
  const allDone = deployment.state === 'ready'
  const activeLabel = PHASES[current]?.label
  const liveAnnouncement = allDone
    ? 'All deployment phases complete.'
    : terminalWithoutPhase
      ? 'The deployment failed before a phase was recorded.'
      : activeLabel
        ? `${activeLabel} ${failed ? 'failed' : deployment.terminal ? 'ended' : 'in progress'}.`
        : 'Waiting for deployment to start.'

  return (
    <div className="shrink-0">
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </span>
      <ol
        className={cn(
          'flex flex-wrap items-center gap-y-1.5',
          align === 'end' && 'sm:justify-end',
        )}
        aria-label="Deployment phases"
      >
        {PHASES.map((phase, index) => {
          const done = allDone || (current >= 0 && index < current)
          const active = !allDone && !deployment.terminal && index === current
          const terminalPhase =
            !allDone && deployment.terminal && index === current
          const phaseFailed = terminalPhase && failed
          const Icon = phaseFailed
            ? CircleAlert
            : done
              ? Check
              : active
                ? Loader2
                : Circle
          return (
            <li
              key={phase.label}
              className="flex items-center"
              aria-current={active ? 'step' : undefined}
            >
              <span
                className={cn(
                  'flex items-center gap-1 text-[11px] font-medium',
                  phaseFailed
                    ? 'text-status-error'
                    : done || active
                      ? 'text-foreground'
                      : 'text-muted-foreground',
                )}
              >
                <Icon
                  className={cn(
                    'size-3',
                    phaseFailed && 'text-status-error',
                    done && 'text-status-running',
                    active && 'text-status-pending',
                    active &&
                      !failed &&
                      'animate-spin motion-reduce:animate-none',
                  )}
                  aria-hidden
                />
                {phase.label}
                {phaseFailed ? (
                  <span className="sr-only">, failed</span>
                ) : active ? (
                  <span className="sr-only">, in progress</span>
                ) : done ? (
                  <span className="sr-only">, complete</span>
                ) : terminalPhase ? (
                  <span className="sr-only">, ended here</span>
                ) : (
                  <span className="sr-only">, pending</span>
                )}
              </span>
              {index < PHASES.length - 1 ? (
                <span className="bg-border mx-2 h-px w-3" aria-hidden="true" />
              ) : null}
            </li>
          )
        })}
      </ol>
      {terminalWithoutPhase ? (
        <p
          className={cn(
            'text-status-error mt-1.5 flex items-center gap-1 text-[11px]',
            align === 'end' && 'sm:justify-end',
          )}
        >
          <CircleAlert className="size-3.5" aria-hidden />
          Phase unavailable
        </p>
      ) : null}
    </div>
  )
}

export function DeploymentLog({
  logs,
  terminal,
}: {
  logs: AgentDeploymentLog[]
  terminal: boolean
}) {
  if (!logs.length) {
    return (
      <div className="text-code-muted bg-code flex min-h-52 items-center justify-center rounded-md px-4 py-8 font-mono text-xs">
        {terminal
          ? 'No build output was recorded.'
          : 'Waiting for build output…'}
      </div>
    )
  }

  return (
    <div
      className="bg-code text-code-foreground max-h-[32rem] overflow-auto rounded-md py-3 font-mono text-xs"
      aria-label="Build and deploy log"
    >
      {logs.map((entry, index) => {
        const phaseChanged =
          index === 0 || entry.phase !== logs[index - 1]?.phase
        return (
          <Fragment key={entry.seq}>
            {phaseChanged ? (
              <div className="text-code-muted border-code-border mt-2 border-y px-4 py-1.5 first:mt-0">
                {entry.phase}
              </div>
            ) : null}
            <div className="grid grid-cols-[3rem_4.5rem_minmax(0,1fr)] gap-2 px-4 py-0.5">
              <span className="text-code-muted text-right select-none">
                {entry.seq}
              </span>
              <span
                className={cn(
                  'select-none',
                  entry.stream === 'stderr'
                    ? 'text-red-300'
                    : 'text-code-muted',
                )}
              >
                {entry.stream}
              </span>
              <span className="min-w-0 break-words whitespace-pre-wrap">
                {entry.chunk}
              </span>
            </div>
          </Fragment>
        )
      })}
    </div>
  )
}
