import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowRight,
  Check,
  Computer as ComputerIcon,
  ExternalLink,
  Copy,
  GitBranch,
  Loader2,
  MessagesSquare,
  RotateCcw,
  ShieldCheck,
  Terminal,
  TriangleAlert,
  UsersRound,
  X,
} from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { GithubMark } from '@/components/github-mark'
import { CopyRow } from '@/components/copy-row'
import { Panel } from '@/components/panel'
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { notifyError, notifySuccess } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { useTransientFlag } from '@/lib/use-transient-flag'
import { PixelScene } from './pixel-scene'
import { AuthContext } from '@/hooks/useAuth'
import { addManagedGitHubConnection } from './api'
import { GitHubStarBonus } from './GitHubStarBonus'
import { launchAuthorizationWindow } from './authorization-window'
import { SlackInstallButton, SlackInstallLink } from './computer-slack'
import {
  trackFirstSessionStartClicked,
  trackSetupSlackClicked,
} from './computer-analytics'
import { ChatTextarea } from '@/components/chat-textarea'
import {
  AgentChangeAction,
  AgentSetup,
  type AgentCardChoice,
} from './AgentStep'
import {
  computerQueryKey,
  computerSessionsQueryKey,
  createComputer,
  createSession,
  getComputer,
  getComputerSessions,
  type ComputerStatus,
} from './computer-api'
import {
  EXAMPLE_ASKS,
  SETUP_STEPS,
  agentSummary,
  SLACK_RETURN_PARAMS,
  alreadyLinkedCopy,
  START_SESSION_COPY,
  computerPollInterval,
  BOOT_STAGES,
  bootProgress,
  computerPresentation,
  elapsedClock,
  sessionPollInterval,
  firstTaskLead,
  setupStep,
  slackLinks,
  slackReturnFromSearch,
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
  // 2026-10-13) or starts its first session here (the sessions API creates
  // it), never on a visit: most organizations only look, and each computer
  // is a VM. A visit only creates one when Slack is already
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

  const [githubSkipped, setGithubSkipped] = useState(
    () => localStorage.getItem(GITHUB_SKIPPED_KEY) === '1',
  )
  const skipGithub = () => {
    localStorage.setItem(GITHUB_SKIPPED_KEY, '1')
    setGithubSkipped(true)
  }
  const step = status.data
    ? setupStep(status.data, sessions.data, githubSkipped)
    : null

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
  if (sessionsLoading && step === null) {
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

  // Once it knows the code and has had its first session, there is no page
  // here: the work is. A Slack install that went wrong still says so first.
  if (step === null) {
    if (!slackProblemPanel) return <Navigate to="/computer/work/new" replace />
    return <div className="space-y-8">{slackProblemPanel}</div>
  }

  return (
    <Setup
      status={status.data}
      step={step}
      notice={slackProblemPanel}
      onSkipGithub={skipGithub}
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
 * a landing page (Igor, 2026-10-13). The last step starts the first session:
 * in Slack once it is in, otherwise straight on the web, with Slack a quiet
 * alternative (Mohamed, 2026-11-26).
 */
function Setup({
  status,
  step,
  notice,
  onSkipGithub,
  createError,
  creating,
  onRetry,
}: {
  status: ComputerStatus
  step: SetupStep
  notice: ReactNode
  onSkipGithub: () => void
  createError: Error | null
  creating: boolean
  onRetry: () => void
}) {
  const { computer } = status
  const failedToCreate = !computer && createError !== null
  const failed = failedToCreate || computer?.state === 'failed'
  // Without the backend's agent block (an older edge), setup is two steps.
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
    // Skipped counts as done; its row still offers to connect.
    github: step !== 'github',
    start: false,
  }
  const slack = slackLinks(status.slack)
  // The last step holds the most; the others leave the bottom free.
  const stepsRunLong = step === 'start'
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
            {/* Before the first session or Slack there is no computer to
                report on; while it comes to life, how far along it is. */}
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
              number={number('github')}
              title="Connect GitHub"
              state={progress('github')}
              summary={
                status.github.connected
                  ? githubSummary(status.github)
                  : 'Skipped for now'
              }
              doneAction={
                status.github.connected ? undefined : (
                  <GitHubAction size="sm" variant="outline" />
                )
              }
            >
              <p>
                Pick the repositories it can work in. It reads and runs the code
                to answer, and changes it when you say so.
              </p>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                <GitHubAction size="lg" />
                <button
                  type="button"
                  onClick={onSkipGithub}
                  className="hover:text-foreground decoration-muted-foreground/40 underline underline-offset-4 transition-colors"
                >
                  Skip for now
                </button>
              </div>
            </SetupItem>
            <SetupItem
              number={number('start')}
              title="Give it its first task"
              state={progress('start')}
            >
              {status.slack.installed ? (
                <>
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
                  <WebStart />
                </>
              ) : (
                <WebFirstStart />
              )}
            </SetupItem>
          </ol>
          <div className="flex flex-col gap-6 self-start xl:[grid-area:context]">
            <SetupContext step={step} agentCard={agentCard} />
            <GitHubStarBonus />
          </div>
          {/* The scene only uses height nobody else needs: its area is a size
              container that adds nothing to the page (no row gap either), and
              the scene shows when the space left fits it plus clearance. */}
          <div className="[container-type:size] relative hidden min-h-0 xl:block xl:[grid-area:scene]">
            <PixelScene
              asleep={!computer}
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

/** Where skipping GitHub in setup is remembered, so a reload keeps it. */
const GITHUB_SKIPPED_KEY = 'computer.setup.githubSkipped'

/**
 * The first task, asked right here: starting it brings the computer to life
 * when there is none yet, then opens the session.
 */
function FirstTaskComposer() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [input, setInput] = useState('')
  const [booting, setBooting] = useState(false)
  const start = useMutation({
    mutationFn: () => createSession(input.trim(), () => setBooting(true)),
    onSettled: () => setBooting(false),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: computerQueryKey })
      void navigate(`/computer/work/t/${encodeURIComponent(session.id)}`)
    },
    onError: (error) => notifyError('Could not start the session', error),
  })
  const send = () => {
    if (input.trim() && !start.isPending) start.mutate()
  }
  return (
    <div className="space-y-2">
      <div className="bg-card focus-within:border-ring/60 rounded-lg border transition-colors">
        <ChatTextarea
          aria-label="First task"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onSend={send}
          placeholder={`For example: ${EXAMPLE_ASKS[0]}`}
          className="text-foreground min-h-16 resize-none border-0 bg-transparent px-3 pt-2.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex justify-end px-2 pb-2">
          <Button disabled={!input.trim() || start.isPending} onClick={send}>
            {start.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <ArrowRight className="size-4" aria-hidden />
            )}
            Start
          </Button>
        </div>
      </div>
      {booting ? (
        <p role="status" className="inline-flex items-center gap-2">
          <PulseDot tone="busy" />
          Starting your computer. The first time takes a minute or two.
        </p>
      ) : null}
    </div>
  )
}

/**
 * Before Slack is in, the first session starts on the web: one button
 * straight to the composer, which brings the computer to life with the first
 * task. Slack stays on offer, quietly (Mohamed, 2026-11-26).
 */
function WebFirstStart() {
  return (
    <>
      <p>
        Ask it anything about your code, or hand it a task. It works in the
        browser; you watch and steer as it goes.
      </p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Button size="lg" asChild>
          <Link to="/computer/work/new" onClick={trackFirstSessionStartClicked}>
            Start your first session
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </Button>
        <SlackInstallLink
          label="Or add it to Slack"
          onClick={trackSetupSlackClicked}
        />
      </div>
    </>
  )
}

/**
 * The web, for whoever asks for it once Slack is in: Slack stays the way in,
 * and the composer only opens on request (Mohamed, 2026-11-18: shown upfront,
 * everyone would take the text box).
 */
function WebStart() {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t pt-4">
      {open ? (
        <div className="space-y-3">
          <p className="text-foreground font-medium">
            Give it a first task here
          </p>
          <FirstTaskComposer />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="hover:text-foreground decoration-muted-foreground/40 inline-flex items-center gap-1 underline underline-offset-4 transition-colors"
        >
          Prefer to start on the web? Give it a first task here
          <ArrowRight className="size-3" aria-hidden />
        </button>
      )}
    </div>
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

function GitHubAction({
  size = 'default',
  variant = 'default',
}: {
  size?: 'default' | 'sm' | 'lg'
  variant?: 'default' | 'outline'
}) {
  const [starting, setStarting] = useState(false)
  return (
    <Button
      size={size}
      variant={variant}
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
