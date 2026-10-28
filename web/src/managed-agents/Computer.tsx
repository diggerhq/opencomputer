import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import {
  ArrowRight,
  Check,
  Computer as ComputerIcon,
  ExternalLink,
  Ellipsis,
  ChevronRight,
  Copy,
  GitBranch,
  Brain,
  Loader2,
  MessagesSquare,
  Plug,
  RotateCcw,
  Route,
  ShieldCheck,
  Terminal,
  TriangleAlert,
  Unplug,
  UsersRound,
  X,
} from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { GithubMark } from '@/components/github-mark'
import { CopyRow } from '@/components/copy-row'
import { Panel } from '@/components/panel'
import { ResourceTable, type Column } from '@/components/resource-table'
import { StatusBadge } from '@/components/status-badge'
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { notifyError, notifySuccess } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { useTransientFlag } from '@/lib/use-transient-flag'
import { PixelScene } from './pixel-scene'
import { AuthContext } from '@/hooks/useAuth'
import { addManagedGitHubConnection } from './api'
import { launchAuthorizationWindow } from './authorization-window'
import { SlackInstallButton, UnlinkSlackDialog } from './computer-slack'
import {
  AgentCard,
  AgentChangeAction,
  AgentSetup,
  type AgentCardChoice,
} from './AgentStep'
import {
  computerQueryKey,
  computerSessionsQueryKey,
  createComputer,
  getComputer,
  getComputerSessions,
  type ComputerSession,
  type ComputerStatus,
} from './computer-api'
import {
  EXAMPLE_ASKS,
  SETUP_STEPS,
  agentSummary,
  SLACK_RETURN_PARAMS,
  alreadyLinkedCopy,
  SESSION_STATUS,
  START_SESSION_COPY,
  computerIsOnboarded,
  computerPollInterval,
  BOOT_STAGES,
  bootProgress,
  computerPresentation,
  elapsedClock,
  firstSession,
  firstTaskCopy,
  relativeTime,
  sessionIsLive,
  sessionPollInterval,
  firstTaskLead,
  setupStep,
  slackLinks,
  slackReturnFromSearch,
  splitSessions,
  type SetupStep,
  type SlackReturn,
} from './computer-state'

export default function ComputerPage() {
  // Behind the rollout flag (work 052): an organization without its computer
  // goes to its projects. Rendered outside an AuthProvider (tests), no gate.
  const auth = useContext(AuthContext)
  if (auth?.user && !auth.user.computerEnabled)
    return <Navigate to="/" replace />
  return <ComputerPageContent />
}

function ComputerPageContent() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const status = useQuery({
    queryKey: computerQueryKey,
    queryFn: getComputer,
    refetchInterval: (query) => computerPollInterval(query.state.data),
  })
  const hasComputer = Boolean(status.data?.computer)
  const sessions = useQuery({
    queryKey: computerSessionsQueryKey,
    queryFn: getComputerSessions,
    // Sessions run on the computer; there are none to ask for before it exists.
    enabled: hasComputer,
    refetchInterval: (query) => sessionPollInterval(query.state.data),
  })

  // The computer comes alive when the organization installs the Slack app
  // (the install's callback claims or creates it; work 052, Mohamed
  // 2026-10-13), never on a visit: most organizations only look, and each
  // computer is a VM. A visit only creates one when Slack is already
  // installed and the computer is still missing (the install's claim
  // failed), and Try again retries a failed one. The call is idempotent.
  const create = useMutation({
    mutationFn: createComputer,
    onSuccess: (next) => queryClient.setQueryData(computerQueryKey, next),
  })
  const { mutate: createNow } = create
  const createStarted = useRef(false)
  const missingAfterInstall =
    status.data?.computer === null && status.data.slack.installed
  useEffect(() => {
    if (!missingAfterInstall || createStarted.current) return
    createStarted.current = true
    createNow()
  }, [missingAfterInstall, createNow])

  // Slack's install redirect lands here with ?slack=connected|error. A
  // failed install gets a panel that stays until dismissed, not a toast that
  // is gone before anyone reads it; a workspace that is another
  // organization's gets its own panel: the person is welcome, they just need
  // an invite. The redirect is a full page load, so the panel's state is read
  // once, from the URL it arrived with; the effect below then cleans the URL.
  const [slackProblem, setSlackProblem] = useState<Exclude<
    SlackReturn,
    { kind: 'connected' } | null
  > | null>(() => {
    const slackReturn = slackReturnFromSearch(searchParams)
    return slackReturn?.kind === 'connected' ? null : slackReturn
  })
  const handledSlackReturn = useRef<string | null>(null)
  useEffect(() => {
    const slackReturn = slackReturnFromSearch(searchParams)
    if (!slackReturn) return
    const key = searchParams.toString()
    if (handledSlackReturn.current === key) return
    handledSlackReturn.current = key
    if (slackReturn.kind === 'connected') {
      notifySuccess('Slack is connected.', START_SESSION_COPY)
    }
    void queryClient.invalidateQueries({ queryKey: computerQueryKey })
    const next = new URLSearchParams(searchParams)
    for (const param of SLACK_RETURN_PARAMS) next.delete(param)
    setSearchParams(next, { replace: true })
  }, [queryClient, searchParams, setSearchParams])

  // Someone who waited here for the first task sees it land: setup gives way
  // to the work with that task on top, live, and a way into its thread.
  // Without the wait, only a first task still under way earns the panel.
  const step = status.data ? setupStep(status.data, sessions.data) : null
  const [waitedForFirstTask, setWaitedForFirstTask] = useState(false)
  const [firstTaskDismissed, setFirstTaskDismissed] = useState(false)
  if (step === 'hello' && !waitedForFirstTask) setWaitedForFirstTask(true)

  if (status.isLoading) {
    return (
      <div
        role="status"
        aria-label="Loading"
        className="flex min-h-64 items-center justify-center"
      >
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    )
  }

  if (status.isError || !status.data) {
    return (
      <Panel>
        <EmptyState
          icon={ComputerIcon}
          title="Your computer is temporarily unavailable"
          description="Try loading this page again."
          action={
            <Button variant="outline" onClick={() => void status.refetch()}>
              Try again
            </Button>
          }
        />
      </Panel>
    )
  }

  const { live, recent } = splitSessions(sessions.data ?? [])
  const sessionsLoading = hasComputer && sessions.isLoading
  const createError = create.isError ? create.error : null
  const dismissSlackProblem = () => setSlackProblem(null)
  const slackProblemPanel =
    slackProblem?.kind === 'already_linked' ? (
      <AlreadyLinked
        notified={slackProblem.notified}
        status={status.data}
        onDismiss={dismissSlackProblem}
      />
    ) : slackProblem?.kind === 'error' ? (
      <SlackInstallFailed
        message={slackProblem.message}
        status={status.data}
        onDismiss={dismissSlackProblem}
      />
    ) : null

  // Whether the first mention is still to come decides between setup and the
  // work, so wait for the sessions rather than flash one and then the other.
  if (sessionsLoading && computerIsOnboarded(status.data)) {
    return (
      <div
        role="status"
        aria-label="Loading"
        className="flex min-h-64 items-center justify-center"
      >
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    )
  }

  // Once it is in Slack, knows the code and has had its first mention, the
  // page is about the work.
  if (step === null) {
    const first = firstSession(sessions.data)
    const showFirstTask =
      first !== null &&
      !firstTaskDismissed &&
      (waitedForFirstTask || sessionIsLive(first))
    return (
      <WithDeveloperFooter>
        <div className="space-y-8">
          <Overview
            status={status.data}
            createError={createError}
            creating={create.isPending}
            onRetry={() => create.mutate()}
          />
          {slackProblemPanel}
          {showFirstTask ? (
            <FirstTask
              session={first}
              readAt={sessions.dataUpdatedAt}
              onDismiss={() => setFirstTaskDismissed(true)}
            />
          ) : null}
          <SessionsPanel
            live={live}
            recent={recent}
            readAt={sessions.dataUpdatedAt}
            loading={sessionsLoading}
            failed={sessions.isError}
          />
          <AgentCard status={status.data} />
          <IdeasToTry />
        </div>
      </WithDeveloperFooter>
    )
  }

  return (
    <Setup
      status={status.data}
      step={step}
      notice={slackProblemPanel}
      createError={createError}
      creating={create.isPending}
      onRetry={() => create.mutate()}
    />
  )
}

/**
 * The page with its footer pinned to the bottom of the viewport. Projects are
 * for developers building agents of their own: a separate track, so it sits
 * below everything, set apart, and says who it is for.
 */
function WithDeveloperFooter({ children }: { children: ReactNode }) {
  return (
    // Takes the rest of the shell's full-height column; the footer then runs
    // into main's bottom padding so it sits on the window's edge.
    <div className="flex flex-1 flex-col">
      <div className="flex flex-1 flex-col">{children}</div>
      {/* Built like the sidebar's profile block (border, py-3, a 40px row)
          so the two rules line up. */}
      <footer className="text-muted-foreground mt-8 -mb-6 border-t py-3 text-xs">
        <p className="flex h-10 items-center gap-1">
          Building your own agent?
          <Link
            to="/new"
            className="hover:text-foreground decoration-muted-foreground/40 inline-flex items-center gap-1 underline underline-offset-4 transition-colors"
          >
            Set it up on OpenComputer infrastructure
            <ArrowRight className="size-3" aria-hidden />
          </Link>
        </p>
      </footer>
    </div>
  )
}

/** Re-renders on an interval so relative times stay true between polls. */
function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

type DotTone = 'alive' | 'busy' | 'failed' | 'quiet'

function PulseDot({ tone, className }: { tone: DotTone; className?: string }) {
  // A steady state (online) holds still; only something under way pulses.
  return (
    <span className={cn('relative flex size-2', className)} aria-hidden>
      {tone === 'busy' ? (
        <span className="absolute inline-flex size-full rounded-full bg-amber-500 opacity-75 motion-safe:animate-ping" />
      ) : null}
      <span
        className={cn(
          'relative inline-flex size-full rounded-full',
          tone === 'alive'
            ? 'bg-emerald-500'
            : tone === 'busy'
              ? 'bg-amber-500'
              : tone === 'failed'
                ? 'bg-red-500'
                : 'bg-muted-foreground',
        )}
      />
    </span>
  )
}

/** The computer's state as a dot tone, shared by the hero and the header. */
function computerDot(status: ComputerStatus, failedToCreate: boolean): DotTone {
  const { computer } = status
  if (failedToCreate || computer?.state === 'failed') return 'failed'
  if (computer?.state === 'ready' && computer.connected) return 'alive'
  // Not set up yet: nothing is happening until Slack is installed.
  if (!computer && !status.slack.installed) return 'quiet'
  if (
    !computer ||
    computer.state === 'provisioning' ||
    computer.state === 'waking' ||
    computer.state === 'ready'
  ) {
    return 'busy'
  }
  return 'quiet'
}

function StatusLabel({
  status,
  failedToCreate,
}: {
  status: ComputerStatus
  failedToCreate: boolean
}) {
  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium">
      <PulseDot tone={computerDot(status, failedToCreate)} />
      {failedToCreate
        ? 'Failed'
        : computerPresentation(
            status.computer,
            status.plan,
            status.slack.installed,
          ).label}
    </span>
  )
}

/**
 * A new computer coming to life, stage by stage, with the time it has taken
 * so far: waiting reads as progress, not as a page that forgot about you.
 */
function BootProgress({
  stage,
  since,
}: {
  stage: number
  since: string | null
}) {
  const now = useNow(1_000)
  const online = stage === BOOT_STAGES.length - 1
  return (
    <div
      role="status"
      aria-label={`Your computer: ${BOOT_STAGES[stage]}`}
      className="flex items-center gap-2 text-sm"
    >
      <ol className="flex items-center gap-2">
        {BOOT_STAGES.map((label, index) => {
          const done = index < stage || online
          const current = index === stage && !online
          return (
            <li key={label} className="flex items-center gap-2">
              {index > 0 ? (
                <span
                  className={cn(
                    'h-px w-4 transition-colors',
                    done || current ? 'bg-foreground/30' : 'bg-border',
                  )}
                  aria-hidden
                />
              ) : null}
              {done ? (
                online && index === stage ? (
                  <PulseDot tone="alive" />
                ) : (
                  <Check className="size-3.5 text-emerald-600" aria-hidden />
                )
              ) : current ? (
                <PulseDot tone="busy" />
              ) : (
                <span
                  className="border-muted-foreground/40 size-2 rounded-full border"
                  aria-hidden
                />
              )}
              <span
                className={cn(
                  current || (online && index === stage)
                    ? 'font-medium'
                    : 'text-muted-foreground',
                )}
              >
                {label}
              </span>
            </li>
          )
        })}
      </ol>
      {since && !online ? (
        <span className="text-muted-foreground tabular-nums">
          <span aria-hidden>· </span>
          <time dateTime={since}>{elapsedClock(since, now)}</time>
        </span>
      ) : null}
    </div>
  )
}

function RetryButton({
  creating,
  onRetry,
  className,
}: {
  creating: boolean
  onRetry: () => void
  className?: string
}) {
  return (
    <Button className={className} disabled={creating} onClick={onRetry}>
      {creating ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <RotateCcw className="size-4" aria-hidden />
      )}
      Try again
    </Button>
  )
}

function Overview({
  status,
  createError,
  creating,
  onRetry,
}: {
  status: ComputerStatus
  createError: Error | null
  creating: boolean
  onRetry: () => void
}) {
  const { computer } = status
  const failedToCreate = !computer && createError !== null
  const offerUpgrade = computer?.state === 'parked' && status.plan === 'free'
  // Only what needs attention: the status speaks for itself otherwise.
  const problem = failedToCreate
    ? createError.message
    : computer?.state === 'failed'
      ? (computer.lastError ??
        'Your computer could not start. Try again, or tell us if it keeps happening.')
      : null
  const canRetry = failedToCreate || computer?.state === 'failed'
  const accounts = status.github.installations.map(
    (installation) => installation.accountLogin,
  )
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">Computer</h1>
        <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 text-sm">
          <StatusLabel status={status} failedToCreate={failedToCreate} />
          {offerUpgrade ? (
            <>
              <span aria-hidden>·</span>
              <Link
                to="/billing"
                className="decoration-muted-foreground/40 hover:text-foreground underline underline-offset-4 transition-colors"
              >
                Upgrade to keep it awake
              </Link>
            </>
          ) : null}
          {problem ? (
            <>
              <span aria-hidden>·</span>
              <span>{problem}</span>
            </>
          ) : null}
        </p>
        {canRetry ? (
          <RetryButton className="mt-4" creating={creating} onRetry={onRetry} />
        ) : null}
      </div>
      <div className="flex items-center gap-5 text-sm">
        <Connection label="Slack">
          {status.slack.teamName ?? 'Connected'}
        </Connection>
        <Connection label="GitHub">
          {accounts.length ? accounts.join(', ') : 'Connected'}
        </Connection>
        <ConnectionsMenu status={status} manage />
      </div>
    </header>
  )
}

function Connection({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <span className="inline-flex max-w-56 items-baseline gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-medium">{children}</span>
    </span>
  )
}

function IdeasToTry() {
  return (
    <details className="group">
      <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex cursor-pointer list-none items-center gap-1.5 rounded-sm text-sm transition-colors outline-none focus-visible:ring-3 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-3.5 transition-transform group-open:rotate-90"
          aria-hidden
        />
        Ideas to try
      </summary>
      <div className="mt-3 grid gap-2">
        {EXAMPLE_ASKS.map((ask) => (
          <CopyRow key={ask} value={`@OpenComputer ${ask}`} />
        ))}
      </div>
    </details>
  )
}

/**
 * Someone tried to link a Slack workspace that already works with
 * OpenComputer in another organization. Not an error: their team is already
 * here, and the way in is an invite (the person who set it up may have been
 * asked in Slack already).
 */
function AlreadyLinked({
  notified,
  status,
  onDismiss,
}: {
  notified: boolean
  status: ComputerStatus
  onDismiss: () => void
}) {
  const copy = alreadyLinkedCopy(notified)
  return (
    <section
      aria-labelledby="already-linked-title"
      className="bg-panel relative rounded-xl border px-6 py-5"
    >
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground absolute top-3 right-3"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X className="size-4" aria-hidden />
      </Button>
      <div className="flex gap-5">
        <div className="bg-primary/15 text-primary flex size-11 shrink-0 items-center justify-center rounded-full">
          <UsersRound className="size-5" aria-hidden />
        </div>
        <div className="max-w-2xl min-w-0 pr-8">
          <h2
            id="already-linked-title"
            className="text-lg font-semibold tracking-tight text-balance"
          >
            {copy.headline}
          </h2>
          <p className="text-muted-foreground mt-2 text-balance">{copy.body}</p>
          {status.slack.installed ? null : (
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <span className="text-muted-foreground text-sm">
                Or connect a different Slack workspace
              </span>
              <SlackInstallButton variant="outline" />
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

/**
 * The payoff of setup: the first task, landed. Where it is, live, and the way
 * into its thread, so the person sees the loop close.
 */
function FirstTask({
  session,
  readAt,
  onDismiss,
}: {
  session: ComputerSession
  readAt: number
  onDismiss: () => void
}) {
  const now = Math.max(useNow(30_000), readAt)
  const copy = firstTaskCopy(session.status)
  const live = sessionIsLive(session)
  return (
    <section
      aria-labelledby="first-task-title"
      aria-live="polite"
      className="bg-panel relative rounded-xl border px-6 py-5 shadow-sm"
    >
      {live ? null : (
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground absolute top-3 right-3"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <X className="size-4" aria-hidden />
        </Button>
      )}
      <div className="flex gap-5">
        <div
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-full',
            session.status === 'error'
              ? 'bg-destructive/10 text-destructive'
              : live
                ? 'bg-amber-500/10'
                : 'bg-primary/15 text-primary',
          )}
          aria-hidden
        >
          {session.status === 'error' ? (
            <TriangleAlert className="size-5" />
          ) : live ? (
            <PulseDot tone="busy" className="size-2.5" />
          ) : (
            <Check className="size-5" />
          )}
        </div>
        <div className="max-w-2xl min-w-0 pr-8">
          <h2
            id="first-task-title"
            className="text-lg font-semibold tracking-tight text-balance"
          >
            {copy.headline}
          </h2>
          <p className="text-muted-foreground mt-1 flex min-w-0 items-baseline gap-2 text-sm">
            <span className="text-foreground truncate font-medium">
              {session.title || 'Untitled session'}
            </span>
            <span aria-hidden>·</span>
            <time
              className="whitespace-nowrap"
              dateTime={session.updatedAt}
              title={new Date(session.updatedAt).toLocaleString()}
            >
              {relativeTime(session.updatedAt, now)}
            </time>
          </p>
          <p className="text-muted-foreground mt-3 text-sm">{copy.body}</p>
          {session.slackUrl ? (
            <Button className="mt-5" asChild>
              <a href={session.slackUrl} target="_blank" rel="noreferrer">
                <MessagesSquare className="size-4" aria-hidden />
                Open the thread
              </a>
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function SlackInstallFailed({
  message,
  status,
  onDismiss,
}: {
  message: string
  status: ComputerStatus
  onDismiss: () => void
}) {
  return (
    <section
      role="alert"
      aria-labelledby="slack-install-failed-title"
      className="border-destructive/40 bg-destructive/5 relative rounded-xl border px-6 py-5"
    >
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground absolute top-3 right-3"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X className="size-4" aria-hidden />
      </Button>
      <div className="flex gap-5">
        <div className="bg-destructive/15 text-destructive flex size-11 shrink-0 items-center justify-center rounded-full">
          <TriangleAlert className="size-5" aria-hidden />
        </div>
        <div className="max-w-2xl min-w-0 pr-8">
          <h2
            id="slack-install-failed-title"
            className="text-lg font-semibold tracking-tight"
          >
            Slack is not connected
          </h2>
          <p className="text-muted-foreground mt-1 text-balance">{message}</p>
          {status.slack.installed ? null : (
            <div className="mt-4">
              <SlackInstallButton label="Try again" />
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

/**
 * Setup is the onboarding of every new organization: three steps, one call to
 * action at a time, and where the person is in them. No pitch; the page is not
 * a landing page (Igor, 2026-10-13).
 */
function Setup({
  status,
  step,
  notice,
  createError,
  creating,
  onRetry,
}: {
  status: ComputerStatus
  step: SetupStep
  notice: ReactNode
  createError: Error | null
  creating: boolean
  onRetry: () => void
}) {
  const { computer } = status
  const failedToCreate = !computer && createError !== null
  const failed = failedToCreate || computer?.state === 'failed'
  // Without the backend's agent block (an older edge), setup is the three
  // steps it was.
  const { agent } = status
  const steps = SETUP_STEPS.filter((id) => id !== 'agent' || agent)
  const position = steps.indexOf(step) + 1
  const number = (id: SetupStep) => steps.indexOf(id) + 1
  const boot = bootProgress(status)
  const [agentCard, setAgentCard] = useState<AgentCardChoice>(
    agent?.choice === 'codex' ? 'codex' : 'claude',
  )
  const done: Record<SetupStep, boolean> = {
    // An installed organization that never chose and has no subscription
    // reads "free credits": routing decides from the subscription row alone,
    // so that is what runs its threads.
    agent: Boolean(agent) && step !== 'agent',
    slack: status.slack.installed,
    github: status.github.connected,
    hello: false,
  }
  const slack = slackLinks(status.slack)
  // The last step holds the most; the others leave the bottom free.
  const stepsRunLong = step === 'hello'
  const progress = (id: SetupStep): SetupItemState =>
    id === step ? 'current' : done[id] ? 'done' : 'upcoming'
  return (
    <WithDeveloperFooter>
      <div className="flex flex-1 flex-col gap-6">
        <header className="max-w-2xl">
          <div className="flex items-center justify-between gap-4">
            <p className="text-muted-foreground text-sm font-medium">
              Step {position} of {steps.length}
            </p>
            {/* Before Slack there is no computer to report on; while it
                comes to life, how far along it is. */}
            {boot && !failed ? (
              <BootProgress stage={boot.stage} since={boot.since} />
            ) : computer || status.slack.installed ? (
              <StatusLabel status={status} failedToCreate={failedToCreate} />
            ) : null}
          </div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">
            Set up your computer
          </h1>
          <div className="mt-4 flex gap-1.5" aria-hidden>
            {steps.map((id) => (
              <span
                key={id}
                className={cn(
                  'h-1 flex-1 rounded-full transition-colors',
                  done[id]
                    ? 'bg-primary'
                    : id === step
                      ? 'bg-primary/35'
                      : 'bg-muted',
                )}
              />
            ))}
          </div>
        </header>

        {notice}

        {failed ? (
          <Alert
            variant="destructive"
            className="border-destructive/40 bg-destructive/5 max-w-2xl px-4 py-3 pr-32"
          >
            <TriangleAlert aria-hidden />
            <AlertTitle>Your computer could not start.</AlertTitle>
            <AlertDescription className="text-muted-foreground">
              {failedToCreate
                ? createError.message
                : (computer?.lastError ??
                  'Try again, or tell us if it keeps happening.')}
            </AlertDescription>
            <AlertAction className="top-1/2 right-3 -translate-y-1/2">
              <RetryButton creating={creating} onRetry={onRetry} />
            </AlertAction>
          </Alert>
        ) : null}

        {/* The steps and their context share a row, so the two cards' top
            edges line up by construction. The scene takes the area left
            empty: the whole bottom row while the steps are short, the column
            under the context once the last step runs long. The bottom row
            grows to the footer, and the scene stands on its floor. */}
        <div
          className={cn(
            'grid flex-1 gap-x-12 gap-y-10 xl:grid-cols-[minmax(0,42rem)_18rem] xl:grid-rows-[auto_minmax(0,1fr)] xl:gap-y-0',
            stepsRunLong
              ? "xl:[grid-template-areas:'steps_context'_'steps_scene']"
              : "xl:[grid-template-areas:'steps_context'_'scene_scene']",
          )}
        >
          <ol className="bg-panel divide-y self-start overflow-hidden rounded-xl border shadow-sm xl:[grid-area:steps]">
            {agent ? (
              <SetupItem
                number={number('agent')}
                title="Choose your coding agent"
                state={progress('agent')}
                summary={agentSummary(agent)}
                doneAction={<AgentChangeAction agent={agent} />}
              >
                <AgentSetup
                  agent={agent}
                  selected={agentCard}
                  onSelect={setAgentCard}
                />
              </SetupItem>
            ) : null}
            <SetupItem
              number={number('slack')}
              title="Add OpenComputer to Slack"
              state={progress('slack')}
              summary={`In ${status.slack.teamName ?? 'your Slack workspace'}`}
              doneAction={<ConnectionsMenu status={status} />}
            >
              <p>
                Mention it in any thread and work the task through together,
                right there.
              </p>
              <SlackInstallButton size="lg" label="Add to Slack" />
              {/* Most workspaces only let admins add apps; where approval is
                  on, Slack itself lets a member ask for it. */}
              <p className="text-xs">
                Not a Slack admin? Click it anyway: Slack lets you ask your
                admin to approve it. Come back here once they have.
              </p>
            </SetupItem>
            <SetupItem
              number={number('github')}
              title="Connect GitHub"
              state={progress('github')}
              summary={githubSummary(status.github)}
            >
              <p>
                Pick the repositories it can work in. It reads and runs the code
                to answer, and changes it when you say so.
              </p>
              <GitHubAction size="lg" />
            </SetupItem>
            <SetupItem
              number={number('hello')}
              title="Give it a first task"
              state={progress('hello')}
            >
              <p>{firstTaskLead(computer)} For example:</p>
              <CopyRow value={`@OpenComputer ${EXAMPLE_ASKS[0]}`} />
              <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                {slack.dm ? (
                  <Button size="lg" asChild>
                    <a href={slack.dm}>
                      <MessagesSquare className="size-4" aria-hidden />
                      Message OpenComputer
                    </a>
                  </Button>
                ) : null}
                {slack.web ? (
                  slack.dm ? (
                    <a
                      href={slack.web}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-foreground decoration-muted-foreground/40 underline underline-offset-4 transition-colors"
                    >
                      Open Slack in the browser
                    </a>
                  ) : (
                    <Button size="lg" asChild>
                      <a href={slack.web} target="_blank" rel="noreferrer">
                        Open Slack
                        <ExternalLink className="size-4" aria-hidden />
                      </a>
                    </Button>
                  )
                ) : null}
              </div>
              <p className="inline-flex items-center gap-2">
                <PulseDot tone="busy" />
                Waiting for its first task. This page moves on by itself.
              </p>
            </SetupItem>
          </ol>
          <SetupContext
            step={step}
            agentCard={agentCard}
            className="xl:[grid-area:context]"
          />
          {/* The scene only uses height nobody else needs: its area is a size
              container that adds nothing to the page (no row gap either), and
              the scene shows when the space left fits it plus clearance. */}
          <div className="[container-type:size] relative hidden min-h-0 xl:block xl:[grid-area:scene]">
            <PixelScene
              asleep={step === 'agent' || step === 'slack'}
              shape={stepsRunLong ? 'compact' : 'wide'}
              className={cn(
                'absolute inset-x-0 bottom-0 hidden',
                stepsRunLong
                  ? '[@container(min-height:15.5rem)]:block'
                  : '[@container(min-height:9.5rem)]:block',
              )}
            />
          </div>
        </div>
      </div>
    </WithDeveloperFooter>
  )
}

/**
 * Why each step matters, beside the steps: quiet, never a call to action
 * (Igor, 2026-10-13: setup lost the what and the why).
 */
function SetupContext({
  step,
  agentCard,
  className,
}: {
  step: SetupStep
  agentCard: AgentCardChoice
  className?: string
}) {
  return (
    <aside
      aria-label="About your computer"
      className={cn('relative self-start text-sm', className)}
    >
      {step === 'agent' ? (
        <div className="bg-panel rounded-xl border p-5 shadow-sm">
          <h2 className="font-semibold">Your agent, in the cloud</h2>
          <p className="text-muted-foreground mt-2">
            {agentCard === 'codex' ? 'Codex' : 'Claude Code'} on its own
            machine, with your repos. Ask in Slack; it runs tests, opens PRs and
            fixes CI.
          </p>
        </div>
      ) : step === 'slack' ? (
        <>
          <ContextHeading>How it works</ContextHeading>
          <SlackThreadPreview />
          <ContextPoints
            points={[
              [MessagesSquare, 'Talk it through in the thread'],
              [Route, 'Change course mid-task; it follows'],
              [Brain, 'Knows your code from one ask to the next'],
            ]}
          />
        </>
      ) : step === 'github' ? (
        <>
          <ContextHeading>What it does with your code</ContextHeading>
          <TerminalPreview />
          <ContextPoints
            points={[
              [Terminal, 'Runs your code to check its answers'],
              [GitBranch, 'Works on a branch you can pick up anytime'],
              [ShieldCheck, 'Never pushes to main unless you ask'],
            ]}
          />
        </>
      ) : (
        <>
          <ContextHeading>More to try</ContextHeading>
          <ul className="space-y-1">
            {EXAMPLE_ASKS.slice(1).map((ask) => (
              <AskItem key={ask} ask={ask} />
            ))}
          </ul>
        </>
      )}
    </aside>
  )
}

function ContextHeading({ children }: { children: ReactNode }) {
  return (
    // Above the aside on wide screens, so the card below it starts level
    // with the steps.
    <h2 className="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase xl:absolute xl:bottom-full xl:left-0">
      {children}
    </h2>
  )
}

function ContextPoints({
  points,
}: {
  points: [typeof MessagesSquare, string][]
}) {
  return (
    <ul className="text-muted-foreground mt-5 space-y-2.5">
      {points.map(([Icon, text]) => (
        <li key={text} className="flex gap-2.5">
          <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
          {text}
        </li>
      ))}
    </ul>
  )
}

/**
 * A short exchange as it looks in Slack: a question back, a steer, done a
 * minute later. Illustration, not data.
 */
const THREAD: { app?: boolean; at: string; text: ReactNode }[] = [
  {
    at: '2:14',
    text: (
      <>
        <span className="text-foreground/70 font-medium">@OpenComputer</span>{' '}
        why is the checkout test flaky?
      </>
    ),
  },
  {
    app: true,
    at: '2:14',
    text: 'Two tests share the cart clock. Freeze it per test, or reset it between them?',
  },
  { at: '2:15', text: 'freeze it' },
  {
    app: true,
    at: '2:15',
    text: (
      <>
        Done: 50 runs, no flakes, on{' '}
        <span className="font-mono text-xs">fix/cart-clock</span>
      </>
    ),
  },
]

function SlackThreadPreview() {
  return (
    <div
      className="bg-panel text-muted-foreground space-y-2.5 rounded-lg border p-4 text-[13px] leading-snug"
      aria-hidden
    >
      {THREAD.map((message, i) => (
        <div key={i} className="flex gap-2.5">
          {message.app ? (
            <div className="bg-muted flex size-6 shrink-0 items-center justify-center rounded-md">
              <ComputerIcon className="size-3" />
            </div>
          ) : (
            <div className="bg-muted flex size-6 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold">
              M
            </div>
          )}
          <div className="min-w-0">
            <p className="text-xs">
              <span className="text-foreground/70 font-semibold">
                {message.app ? 'OpenComputer' : 'Maya'}
              </span>
              <span className="ml-1.5 opacity-70">{message.at}</span>
            </p>
            <p className="mt-0.5">{message.text}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

/** It checking its own work: illustration, not data. */
function TerminalPreview() {
  return (
    <div
      className="bg-panel text-muted-foreground space-y-1.5 rounded-lg border p-4 font-mono text-xs"
      aria-hidden
    >
      <p className="opacity-70">~/acme/web</p>
      <p>
        <span className="opacity-70">$ </span>
        {'pnpm test cart'}
      </p>
      <p>
        <span className="text-emerald-600/70 dark:text-emerald-400/70">
          {'✓ '}
        </span>
        {'214 passed '}
        <span className="opacity-70">{'· 50 runs · 3.1s'}</span>
      </p>
      <p>
        <span className="opacity-70">$ </span>
        {'git push origin fix/cart-clock'}
      </p>
    </div>
  )
}

function AskItem({ ask }: { ask: string }) {
  const [copied, markCopied] = useTransientFlag(1500)
  return (
    <li>
      <button
        type="button"
        className="group hover:bg-muted/60 focus-visible:ring-ring/50 -mx-2 flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors outline-none focus-visible:ring-3"
        onClick={() => {
          // navigator.clipboard is missing outside secure contexts.
          Promise.resolve()
            .then(() => navigator.clipboard.writeText(`@OpenComputer ${ask}`))
            .then(markCopied)
            .catch((error: unknown) => notifyError("Couldn't copy.", error))
        }}
      >
        <span className="text-muted-foreground group-hover:text-foreground flex-1 transition-colors">
          {ask.charAt(0).toUpperCase() + ask.slice(1)}
        </span>
        <span className="sr-only" aria-live="polite">
          {copied ? 'Copied' : ''}
        </span>
        {copied ? (
          <Check
            className="mt-0.5 size-3.5 shrink-0 text-emerald-600"
            aria-hidden
          />
        ) : (
          <Copy
            className="text-muted-foreground mt-0.5 size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            aria-hidden
          />
        )}
      </button>
    </li>
  )
}

type SetupItemState = 'done' | 'current' | 'upcoming'

function SetupItem({
  number,
  title,
  state,
  summary,
  doneAction,
  children,
}: {
  number: number
  title: string
  state: SetupItemState
  summary?: string
  doneAction?: ReactNode
  children: ReactNode
}) {
  const current = state === 'current'
  return (
    <li
      aria-current={current ? 'step' : undefined}
      className={cn('px-5', current ? 'bg-primary/[0.03] py-5' : 'py-4')}
    >
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
            state === 'done' && 'bg-primary/15 text-primary',
            current && 'bg-primary text-primary-foreground',
            state === 'upcoming' && 'text-muted-foreground border',
          )}
          aria-hidden
        >
          {state === 'done' ? <Check className="size-3.5" /> : number}
        </div>
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'text-sm',
              current ? 'font-semibold' : 'font-medium',
              state === 'upcoming' && 'text-muted-foreground',
            )}
          >
            {title}
            <span className="sr-only">
              {state === 'done'
                ? ' (done)'
                : current
                  ? ' (current step)'
                  : ' (to do)'}
            </span>
          </p>
          {state === 'done' && summary ? (
            <p className="text-muted-foreground truncate text-sm">{summary}</p>
          ) : null}
        </div>
        {state === 'done' ? doneAction : null}
      </div>
      {current ? (
        <div className="text-muted-foreground mt-3 space-y-4 pl-10 text-sm">
          {children}
        </div>
      ) : null}
    </li>
  )
}

function githubSummary(github: ComputerStatus['github']) {
  const accounts = github.installations.map(
    (installation) => installation.accountLogin,
  )
  return accounts.length
    ? `Repositories in ${accounts.join(', ')}`
    : 'GitHub is connected'
}

/**
 * Connection housekeeping behind one quiet menu: unlinking stops the computer
 * answering in Slack, so it is never a button in plain view.
 */
function ConnectionsMenu({
  status,
  manage = false,
}: {
  status: ComputerStatus
  manage?: boolean
}) {
  const [confirmUnlink, setConfirmUnlink] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label="Connection options"
          >
            <Ellipsis className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-auto min-w-48 whitespace-nowrap"
        >
          {manage ? (
            <DropdownMenuItem asChild>
              <Link to="/managed-agents/connections">
                <Plug aria-hidden />
                Manage connections
              </Link>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setConfirmUnlink(true)}
          >
            <Unplug aria-hidden />
            Unlink Slack workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <UnlinkSlackDialog
        teamName={status.slack.teamName}
        open={confirmUnlink}
        onOpenChange={setConfirmUnlink}
      />
    </>
  )
}

function GitHubAction({ size = 'default' }: { size?: 'default' | 'lg' }) {
  const [starting, setStarting] = useState(false)
  return (
    <Button
      size={size}
      disabled={starting}
      onClick={() => {
        setStarting(true)
        // The same managed GitHub App install as Connections; the page picks
        // the new installation up when it is next read (on focus or poll).
        void launchAuthorizationWindow(() =>
          addManagedGitHubConnection('install'),
        )
          .catch((error: unknown) =>
            notifyError("Couldn't start the GitHub installation.", error),
          )
          .finally(() => setStarting(false))
      }}
    >
      {starting ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        <GithubMark className="size-4" />
      )}
      Connect GitHub
    </Button>
  )
}

function sessionColumns(now: number): Column<ComputerSession>[] {
  return [
    {
      key: 'title',
      header: 'Session',
      cell: (session) => (
        <span className="block max-w-md truncate font-medium">
          {session.title || 'Untitled session'}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (session) => (
        <StatusBadge
          status={SESSION_STATUS[session.status].badge}
          label={SESSION_STATUS[session.status].label}
        />
      ),
    },
    {
      key: 'updated',
      header: 'Updated',
      cell: (session) => (
        <time
          className="text-muted-foreground whitespace-nowrap"
          dateTime={session.updatedAt}
          title={new Date(session.updatedAt).toLocaleString()}
        >
          {relativeTime(session.updatedAt, now)}
        </time>
      ),
    },
    {
      key: 'open',
      header: <span className="sr-only">Open</span>,
      align: 'right',
      cell: (session) =>
        session.slackUrl ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            asChild
          >
            <a
              href={session.slackUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="Open in Slack"
              title="Open in Slack"
            >
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </Button>
        ) : null,
    },
  ]
}

/** Every session in one list, the live ones first. */
function SessionsPanel({
  live,
  recent,
  readAt,
  loading,
  failed,
}: {
  live: ComputerSession[]
  recent: ComputerSession[]
  /** When the sessions were read; relative times never predate it. */
  readAt: number
  loading: boolean
  failed: boolean
}) {
  const now = Math.max(useNow(30_000), readAt)
  const columns = useMemo(() => sessionColumns(now), [now])
  return (
    <section aria-labelledby="computer-sessions">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 id="computer-sessions" className="text-sm font-semibold">
          Sessions
        </h2>
        {live.length > 0 ? (
          <span className="text-muted-foreground text-sm">
            {live.length} working now
          </span>
        ) : null}
      </div>
      <Panel>
        <ResourceTable
          columns={columns}
          rows={[...live, ...recent]}
          rowKey={(session) => session.key}
          loading={loading}
          skeletonRows={3}
          empty={
            <EmptyState
              icon={MessagesSquare}
              title={
                failed
                  ? 'Sessions are temporarily unavailable'
                  : 'No sessions yet'
              }
              description={
                failed ? 'They reload by themselves.' : START_SESSION_COPY
              }
            />
          }
        />
      </Panel>
    </section>
  )
}
