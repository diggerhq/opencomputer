import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  ChevronDown,
  FolderGit2,
  Loader2,
  Radar,
  ShieldCheck,
  X,
} from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import {
  Panel,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { notifyError } from '@/lib/errors'
import {
  addManagedGitHubConnection,
  attachManagedGitHub,
  createManagedMemoryDocument,
  createManagedTemplateInstallation,
  finalizeManagedTemplateInstallation,
  getManagedGitHubConnections,
  getManagedTemplateInstallation,
  inspectManagedTemplate,
  listManagedDeploymentSourceRepositories,
  putAgentRuntimeVariable,
  replaceManagedMemoryDocument,
  startManagedAgentSession,
  type ManagedDeploymentSourceRepository,
} from '../api'
import { installedTemplateAgentId } from '../template-continuation'
import {
  cellDocumentId,
  composeCellPrompt,
  composeLaunchPrompt,
  DEFAULT_SWARM_MODEL,
  runManifestDocumentId,
  SCAN_DECLARATION,
  SECURITY_FINDINGS_RESOURCE,
  SECURITY_SWARM_TEMPLATE_REPOSITORY,
  serializeRunManifest,
  swarmCells,
  SWARM_LOGIN_PASSWORD_VAR,
  SWARM_LOGIN_USERNAME_VAR,
  type LaunchedCell,
  type SwarmCell,
  type SwarmPayload,
} from './catalog'
import { fetchLiveCves, type FeedCve } from './feeds'

// The throwaway test-account credentials, carried from the form to the launch
// handler out-of-band from SwarmPayload so they never reach the cell prompt or
// the run manifest. They go only to the project's encrypted runtime variables.
type SwarmCredentials = { username: string; password: string }

// Each cell is one microVM session — one agent per CVE — so cap the swarm to
// keep a careless "top 500" from spinning up hundreds of sandboxes at once.
const MAX_SWARM_CELLS = 100

// How many of the live, severity-sorted CVEs to preselect on first load, so a
// first swarm runs with no typing. Clamped to the cap and the feed size.
const DEFAULT_TOP_N = 8

// Deploying the swarm project is no longer a step the operator clicks through —
// it starts on its own the moment GitHub is connected and runs while they fill
// in the payload, so by launch time it's usually already done.
const STEPS = ['Connect GitHub', 'Launch swarm'] as const

type DeployResult = { projectId: string; projectAgentId: string }

type DeployState = 'idle' | 'deploying' | 'ready' | 'failed'

// Boot every cell's sandbox in the background, after the launch has already
// written the manifest and navigated. Each cell: create its findings document
// (a session can't bind to a missing one), start its session, then flip the
// cell to `started` with its id — or `failed`. The manifest is rewritten as each
// cell resolves, so the run page lights them up incrementally. We are the only
// writer of this document, so we just carry the latest etag forward; writes are
// coalesced so a burst of resolutions collapses into one trailing write.
async function launchCellsInBackground(args: {
  projectId: string
  runId: string
  agentId: string
  payload: SwarmPayload
  cells: SwarmCell[]
  manifestEtag: string
}) {
  const { projectId, runId, agentId, payload, cells } = args
  const launched: LaunchedCell[] = cells.map((cell) => ({
    cell,
    sessionId: '',
    launch: 'starting',
  }))
  const docTarget = {
    projectId,
    resource: SECURITY_FINDINGS_RESOURCE,
    environment: 'default' as const,
    id: runManifestDocumentId(runId),
  }

  let etag = args.manifestEtag
  let writing = false
  let dirty = false
  const flush = async () => {
    if (writing) {
      dirty = true
      return
    }
    writing = true
    try {
      do {
        dirty = false
        const res = await replaceManagedMemoryDocument({
          ...docTarget,
          etag,
          text: serializeRunManifest({
            runId,
            model: payload.model,
            target: payload.target,
            cells: launched,
          }),
        })
        etag = res.etag
      } while (dirty)
    } catch {
      // Best-effort: a dropped manifest write only delays a cell lighting up on
      // the run page; its agent work is already running.
    } finally {
      writing = false
    }
  }

  await Promise.all(
    cells.map(async (cell, i) => {
      try {
        const id = cellDocumentId(runId, cell)
        await createManagedMemoryDocument({
          projectId,
          resource: SECURITY_FINDINGS_RESOURCE,
          environment: 'default',
          id,
          title: cell.cveId,
          text: '{}',
        })
        const { sessionId } = await startManagedAgentSession(
          agentId,
          composeCellPrompt(payload, cell),
          {
            memory: {
              [SECURITY_FINDINGS_RESOURCE]: {
                scope: 'document',
                id,
                access: 'read-write',
              },
            },
          },
        )
        launched[i] = { cell, sessionId, launch: 'started' }
      } catch {
        launched[i] = { cell, sessionId: '', launch: 'failed' }
      }
      await flush()
    }),
  )
  await flush()
}

async function waitForInstallation(id: string) {
  const deadline = Date.now() + 10 * 60_000
  let installation = await getManagedTemplateInstallation(id)
  while (
    installation.state !== 'ready' &&
    installation.state !== 'failed' &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    installation = await getManagedTemplateInstallation(id)
  }
  return installation
}

// The GitHub install is the swarm's hard boundary, so the repos it grants are
// exactly the ones worth offering. Walk every page into one list, sorted and
// drained of archived repos — they can't be swarmed usefully.
async function listConnectedRepositories(input: {
  projectId: string
  connectionId: string
}): Promise<string[]> {
  const all: ManagedDeploymentSourceRepository[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  do {
    const page = await listManagedDeploymentSourceRepositories({
      ...input,
      cursor,
    })
    all.push(...page.repositories)
    cursor = page.nextCursor
    if (cursor && seen.has(cursor)) break
    if (cursor) seen.add(cursor)
  } while (cursor)
  return all
    .filter((r) => !r.archived)
    .map((r) => r.fullName)
    .sort((a, b) => a.localeCompare(b))
}

export default function SecurityOnboarding() {
  const navigate = useNavigate()

  // Step 1 — GitHub connection. An active install means the boundary is set.
  const connections = useQuery({
    queryKey: ['managed-github-connections'],
    queryFn: getManagedGitHubConnections,
    retry: false,
  })
  const activeConnection = (connections.data?.connections ?? []).find(
    (c) => c.state === 'active',
  )
  const connected = Boolean(activeConnection)

  const [deployed, setDeployed] = useState<DeployResult | null>(null)

  // The repos the install grants — the swarm's boundary and the autocomplete
  // source. It needs a project to scope the listing, so it can only load once
  // the background deploy has settled; by then the operator is usually still
  // filling the payload.
  const connectedRepos = useQuery({
    queryKey: [
      'swarm-connected-repos',
      deployed?.projectId,
      activeConnection?.id,
    ],
    enabled: Boolean(deployed?.projectId && activeConnection?.id),
    staleTime: 5 * 60_000,
    queryFn: () =>
      listConnectedRepositories({
        projectId: deployed!.projectId,
        connectionId: activeConnection!.id,
      }),
  })

  // Two steps now: connect, then launch. The deploy happens on its own between
  // them, so it isn't a step the operator waits on.
  const step = connected ? 1 : 0

  // Holds the in-flight (or settled) deploy so a launch fired before it finishes
  // can await the same promise instead of starting a second deploy.
  const deployPromiseRef = useRef<Promise<DeployResult> | null>(null)

  const connect = useMutation({
    mutationFn: () => addManagedGitHubConnection('install'),
    onSuccess: (url) => window.location.assign(url),
    onError: (error) =>
      notifyError("Couldn't start the GitHub install.", error),
  })

  const deploy = useMutation({
    mutationFn: async (): Promise<DeployResult> => {
      const reviewed = await inspectManagedTemplate(
        SECURITY_SWARM_TEMPLATE_REPOSITORY,
      )
      const installation = await createManagedTemplateInstallation({
        inspectionId: reviewed.id,
        projectName: 'CVE Swarm',
        idempotencyKey: crypto.randomUUID(),
      })
      // Default the swarm model to GLM for every agent that declares it.
      for (const requirement of reviewed.requirements.runtimeVariables) {
        if (!/model/i.test(requirement.name)) continue
        await putAgentRuntimeVariable({
          projectId: installation.projectId,
          environment: 'development',
          agentId: installedTemplateAgentId({
            projectAgentId: installation.projectAgentId,
            localAgentId: requirement.agentId,
            primaryLocalAgentId: reviewed.agents[0]?.id,
          }),
          name: requirement.name,
          value: DEFAULT_SWARM_MODEL,
        })
      }
      const finalized = await finalizeManagedTemplateInstallation(
        installation.id,
      )
      const ready =
        finalized.state === 'ready'
          ? finalized
          : await waitForInstallation(finalized.id)
      if (ready.state !== 'ready') {
        throw new Error(ready.error?.message ?? 'Template installation failed.')
      }
      // Attach the GitHub install to the new project so the swarm's sandbox is
      // injected with GH_TOKEN. Without this the agent can't clone or open PRs,
      // and git/gh calls hang the run. Managed template projects run in the
      // `default` environment. The install is the authorization boundary, so
      // the project is unusable until it's bound.
      const github = await getManagedGitHubConnections()
      const connection = github.connections.find((c) => c.state === 'active')
      if (!connection) {
        throw new Error(
          'Connect the GitHub App before deploying — the swarm needs it to read your repositories.',
        )
      }
      await attachManagedGitHub({
        projectId: ready.projectId,
        environment: 'default',
        connectionId: connection.id,
      })
      return {
        projectId: ready.projectId,
        projectAgentId: installedTemplateAgentId({
          projectAgentId: ready.projectAgentId,
          localAgentId: reviewed.template.firstRun?.agent,
          primaryLocalAgentId: reviewed.agents[0]?.id,
        }),
      }
    },
    onSuccess: (result) => setDeployed(result),
    onError: (error) => notifyError("Couldn't deploy the CVE Swarm.", error),
  })

  // Start the deploy once, reusing the in-flight promise so nothing launches a
  // second one. A failure clears the ref so a retry (or a launch) can try again.
  const startDeploy = (): Promise<DeployResult> => {
    if (deployPromiseRef.current) return deployPromiseRef.current
    const p = deploy.mutateAsync()
    deployPromiseRef.current = p
    void p.catch(() => {
      deployPromiseRef.current = null
    })
    return p
  }

  // Auto-start it the moment GitHub is connected, so it deploys while the
  // operator fills in the payload. The ref guard keeps this to one deploy even
  // though the effect re-runs on each render.
  useEffect(() => {
    if (!connected || deployed || deployPromiseRef.current) return
    const p = deploy.mutateAsync()
    deployPromiseRef.current = p
    void p.catch(() => {
      deployPromiseRef.current = null
    })
  }, [connected, deployed, deploy])

  const deployState: DeployState = deployed
    ? 'ready'
    : deploy.isError
      ? 'failed'
      : connected
        ? 'deploying'
        : 'idle'

  // Launch fans the payload's picked CVEs out into one bound session per CVE —
  // each agent hunts a single CVE against the live target, with every repo as
  // shared evidence. The slow part is booting each cell's sandbox, so we don't block the
  // UI on it: we write the run manifest immediately with every cell `starting`,
  // navigate to the run page, then boot the sandboxes in the background (see
  // launchCellsInBackground), flipping each cell to `started` with its session id
  // as it comes up. The manifest is the source of truth across the route change —
  // the ids don't survive in React state.
  const launch = useMutation({
    mutationFn: async ({
      payload,
      credentials,
    }: {
      payload: SwarmPayload
      credentials: SwarmCredentials | null
    }): Promise<{
      projectId: string
      runId: string
      agentId: string
      payload: SwarmPayload
      cells: SwarmCell[]
      manifestEtag: string
    }> => {
      const cells = swarmCells(payload)
      if (cells.length === 0) {
        throw new Error('Pick at least one CVE and one repository to swarm.')
      }
      if (cells.length > MAX_SWARM_CELLS) {
        throw new Error(
          `That is ${cells.length} CVEs. Pick ${MAX_SWARM_CELLS} or fewer — each CVE is its own sandbox.`,
        )
      }
      // The deploy runs in the background from the moment GitHub connects. If the
      // operator reaches launch before it settles, await that same deploy rather
      // than blocking the whole flow on it earlier.
      const project = deployed ?? (await startDeploy())
      // Authenticated scan: stash the throwaway account in the project's
      // encrypted runtime variables so every cell's sandbox gets them in its
      // environment. Project-scoped (no agentId) so all cells inherit one login;
      // `default` is the environment managed-template projects run in (the same
      // one the GitHub install is attached to above). Never written to the
      // manifest or the prompt.
      if (credentials) {
        await Promise.all([
          putAgentRuntimeVariable({
            projectId: project.projectId,
            environment: 'default',
            name: SWARM_LOGIN_USERNAME_VAR,
            value: credentials.username,
          }),
          putAgentRuntimeVariable({
            projectId: project.projectId,
            environment: 'default',
            name: SWARM_LOGIN_PASSWORD_VAR,
            value: credentials.password,
          }),
        ])
      }
      const runId = `run-${crypto.randomUUID()}`
      const agentId = `${project.projectAgentId}@default`
      const starting: LaunchedCell[] = cells.map((cell) => ({
        cell,
        sessionId: '',
        launch: 'starting',
      }))
      // One fast write makes the run reachable by URL; agentWrites stays disabled
      // — only cell findings are agent-owned.
      const created = await createManagedMemoryDocument({
        projectId: project.projectId,
        resource: SECURITY_FINDINGS_RESOURCE,
        environment: 'default',
        id: runManifestDocumentId(runId),
        title: `Swarm run ${runId}`,
        text: serializeRunManifest({
          runId,
          model: payload.model,
          target: payload.target,
          cells: starting,
        }),
        agentWrites: 'disabled',
      })
      return {
        projectId: project.projectId,
        runId,
        agentId,
        payload,
        cells,
        manifestEtag: created.etag,
      }
    },
    onSuccess: ({ projectId, runId, agentId, payload, cells, manifestEtag }) => {
      void navigate(
        `/projects/${encodeURIComponent(projectId)}/swarms/${encodeURIComponent(runId)}`,
      )
      // Fire-and-forget: this outlives the unmount on navigation, booting the
      // sandboxes and filling the manifest as they come up.
      void launchCellsInBackground({
        projectId,
        runId,
        agentId,
        payload,
        cells,
        manifestEtag,
      })
    },
    onError: (error) => notifyError("Couldn't start the swarm.", error),
  })

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <PageHeader
        title="Launch your first CVE swarm"
        description="Connect the repos you own, deploy the swarm, and prove which of this week's CVEs are actually reachable in your stack — then open a dependency-only fix for the ones that are."
        className="mb-8"
      />

      <div className="mb-10">
        <StepRail steps={STEPS} current={step} />
      </div>

      <div className="space-y-5">
        <StepCard
          index={0}
          current={step}
          icon={FolderGit2}
          title="Connect GitHub"
          done={connected}
        >
          <p className="text-muted-foreground text-sm">
            Install the OpenComputer GitHub App on the repositories you own. The
            repos you select here are the hard boundary — the swarm can never
            touch anything outside this install. It requests only Contents and
            Pull requests (write) plus Metadata (read).
          </p>
          <div className="mt-4 flex items-center gap-3">
            <Button
              onClick={() => connect.mutate()}
              disabled={connect.isPending || connected}
            >
              {connect.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <FolderGit2 />
              )}
              {connected ? 'GitHub connected' : 'Connect GitHub'}
            </Button>
            {connected ? (
              <span className="text-status-running text-sm">
                {connections.data?.connections.filter(
                  (c) => c.state === 'active',
                ).length ?? 0}{' '}
                install(s) active
              </span>
            ) : null}
          </div>
        </StepCard>

        <StepCard
          index={1}
          current={step}
          icon={Radar}
          title="Launch swarm from payload"
          done={false}
        >
          <DeployStatus state={deployState} onRetry={() => void startDeploy()} />
          <PayloadBuilder
            deployState={deployState}
            availableRepos={connectedRepos.data ?? []}
            reposLoading={connectedRepos.isLoading}
            launching={launch.isPending}
            onLaunch={(payload, credentials) =>
              launch.mutate({ payload, credentials })
            }
          />
        </StepCard>
      </div>
    </div>
  )
}

function StepRail({
  steps,
  current,
}: {
  steps: readonly string[]
  current: number
}) {
  return (
    <ol className="flex items-center gap-3">
      {steps.map((label, i) => {
        const done = i < current
        const active = i === current
        return (
          <li key={label} className="flex flex-1 items-center gap-3">
            <span
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium',
                done || active
                  ? 'border-status-running text-status-running'
                  : 'border-border text-muted-foreground/50',
              )}
            >
              {i + 1}
            </span>
            <span
              className={cn(
                'text-sm',
                active
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground',
              )}
            >
              {label}
            </span>
            {i < steps.length - 1 ? (
              <span
                className={cn(
                  'h-px flex-1',
                  i < current ? 'bg-status-running' : 'bg-border',
                )}
              />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

function StepCard({
  index,
  current,
  icon: Icon,
  title,
  done,
  children,
}: {
  index: number
  current: number
  icon: typeof FolderGit2
  title: string
  done: boolean
  children: React.ReactNode
}) {
  const active = index === current
  return (
    <Panel
      className={cn(
        'transition-opacity',
        index > current && !done ? 'opacity-55' : 'opacity-100',
      )}
    >
      <PanelHeader>
        <PanelTitle className="flex items-center gap-2">
          <Icon
            className={cn(
              'size-4',
              active || done ? 'text-status-running' : 'text-muted-foreground',
            )}
          />
          {title}
        </PanelTitle>
      </PanelHeader>
      <PanelContent>{children}</PanelContent>
    </Panel>
  )
}

// The slim strip at the top of the launch step: the background deploy's state,
// so the operator knows their swarm project is being prepared while they build
// the payload — and can retry if it failed.
function DeployStatus({
  state,
  onRetry,
}: {
  state: DeployState
  onRetry: () => void
}) {
  if (state === 'idle') return null
  if (state === 'ready') {
    return (
      <div className="text-status-running mb-4 inline-flex items-center gap-2 text-xs">
        <ShieldCheck className="size-3.5" />
        Swarm project ready — publishing stays off (dry-run fixes) until you turn
        it on.
      </div>
    )
  }
  if (state === 'failed') {
    return (
      <div className="mb-4 flex items-center gap-3 text-xs">
        <span className="text-destructive">
          Couldn't prepare your swarm project.
        </span>
        <button
          type="button"
          onClick={onRetry}
          className="text-foreground underline underline-offset-4"
        >
          Retry
        </button>
      </div>
    )
  }
  return (
    <div className="text-muted-foreground mb-4 inline-flex items-center gap-2 text-xs">
      <Loader2 className="size-3.5 animate-spin" />
      Preparing your swarm project in the background (model{' '}
      {DEFAULT_SWARM_MODEL})…
    </div>
  )
}

function PayloadBuilder({
  deployState,
  availableRepos,
  reposLoading,
  launching,
  onLaunch,
}: {
  deployState: DeployState
  availableRepos: string[]
  reposLoading: boolean
  launching: boolean
  onLaunch: (payload: SwarmPayload, credentials: SwarmCredentials | null) => void
}) {
  const [target, setTarget] = useState('')
  const [declaration, setDeclaration] = useState(false)
  // Optional throwaway test account, so a cell can log in and scan behind the
  // auth wall. Empty = unauthenticated scan, exactly as before.
  const [loginUrl, setLoginUrl] = useState('')
  const [loginUsername, setLoginUsername] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [repositories, setRepositories] = useState<string[]>([])
  const [cveIds, setCveIds] = useState<string[]>([])
  const [preview, setPreview] = useState<string | null>(null)

  // The live, severity-sorted CVE feed. We pull a generous slice (worst first)
  // and let the operator pick the top N to swarm. cve.now sends CORS `*`, so the
  // browser fetches it directly — no backend proxy.
  const liveCves = useQuery({
    queryKey: ['swarm-live-cves'],
    queryFn: ({ signal }) => fetchLiveCves(100, signal),
    staleTime: 5 * 60_000,
    retry: 1,
  })
  const feed = useMemo(() => liveCves.data ?? [], [liveCves.data])

  // Preselect the top N by severity the first time the feed lands, so a first
  // swarm runs with no typing. One-shot: once defaulted (or the operator edits)
  // we leave the selection alone.
  const cvesDefaultedRef = useRef(false)
  useEffect(() => {
    if (cvesDefaultedRef.current || feed.length === 0) return
    cvesDefaultedRef.current = true
    const n = Math.min(DEFAULT_TOP_N, feed.length, MAX_SWARM_CELLS)
    setCveIds(feed.slice(0, n).map((c) => c.id))
  }, [feed])

  // Replace the selection with the top N of the live feed (severity-sorted).
  const pickTopN = (n: number) => {
    const clamped = Math.max(0, Math.min(n, feed.length))
    setCveIds(feed.slice(0, clamped).map((c) => c.id))
  }

  // A login needs both a username and a password; the URL is optional (the cell
  // can find the login page itself). Only then is the scan authenticated.
  const authenticated = loginUsername.trim() !== '' && loginPassword !== ''
  const credentials: SwarmCredentials | null = authenticated
    ? { username: loginUsername.trim(), password: loginPassword }
    : null

  const payload: SwarmPayload = useMemo(
    () => ({
      target: target.trim(),
      declarationAccepted: declaration,
      repositories,
      cveIds,
      model: DEFAULT_SWARM_MODEL,
      authenticated,
      // Non-secret, so it may ride in the payload; the username/password do not.
      ...(loginUrl.trim() ? { loginUrl: loginUrl.trim() } : {}),
    }),
    [target, declaration, repositories, cveIds, authenticated, loginUrl],
  )

  // Default to every connected repo the moment the list lands — the operator
  // asked to swarm their whole surface, so that's the useful starting point.
  // One-shot: once defaulted (or the operator edits first) we leave the
  // selection alone, so a removed repo doesn't snap back on the next render.
  const defaultedRef = useRef(false)
  useEffect(() => {
    if (defaultedRef.current || availableRepos.length === 0) return
    defaultedRef.current = true
    setRepositories((current) => (current.length > 0 ? current : availableRepos))
  }, [availableRepos])

  // The target is the asset under test, and the declaration attests ownership
  // of "this web application" — so a launch needs a real https(s) URL. An empty
  // or malformed target blocks the button.
  const targetValid = /^https?:\/\/.+/i.test(payload.target)
  // A login URL is optional, but if given it must be a real http(s) URL.
  const loginUrlValid = loginUrl.trim() === '' || /^https?:\/\/.+/i.test(loginUrl.trim())
  // Credentials are all-or-nothing: a half-filled login would silently scan
  // unauthenticated, so block the launch until both fields are set or both empty.
  const loginComplete =
    (loginUsername.trim() === '') === (loginPassword === '')
  // One agent per picked CVE — so the cell count is just the CVEs. Each cell is
  // its own sandbox, so a pick past the cap is a launch we won't start; surface
  // it before the click, not on it.
  const cellCount = cveIds.length
  const overCap = cellCount > MAX_SWARM_CELLS
  // A swarm needs at least one CVE to hunt and at least one repo as shared
  // evidence for every cell to investigate against.
  const ready =
    declaration &&
    cveIds.length > 0 &&
    repositories.length > 0 &&
    !overCap &&
    targetValid &&
    loginUrlValid &&
    loginComplete

  return (
    <div className="space-y-5">
      <Field
        label="Endpoint to scan"
        hint="A URL you operate — required. The swarm discovers routes from your repos and probes this host only. Add a test login below to scan behind the auth wall."
      >
        <Input
          type="url"
          placeholder="https://app.your-domain.com"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          aria-invalid={target !== '' && !targetValid}
        />
        {target !== '' && !targetValid ? (
          <span className="text-destructive text-xs">
            Enter a full http(s) URL.
          </span>
        ) : null}
      </Field>

      <Field
        label="Test login (optional)"
        hint="Use a throwaway account you create just for this — the swarm signs in with it and scans behind the login, exercising the app and its API to find vulnerabilities. Credentials are stored as encrypted runtime variables, never shown again or written to findings. Leave blank to scan only what's reachable without signing in."
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            type="text"
            autoComplete="off"
            placeholder="Username or email"
            value={loginUsername}
            onChange={(e) => setLoginUsername(e.target.value)}
          />
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="Password"
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
          />
        </div>
        <Input
          type="url"
          className="mt-2"
          placeholder="Login page URL (optional)"
          value={loginUrl}
          onChange={(e) => setLoginUrl(e.target.value)}
          aria-invalid={!loginUrlValid}
        />
        {!loginComplete ? (
          <span className="text-destructive text-xs">
            Enter both a username and a password, or leave both blank.
          </span>
        ) : null}
        {!loginUrlValid ? (
          <span className="text-destructive text-xs">
            Enter a full http(s) URL, or leave the login page blank.
          </span>
        ) : null}
      </Field>

      <Field
        label="Repositories"
        hint="Every repo from your GitHub install, selected by default. These are shared evidence — every CVE agent gets all of them cloned to investigate the target against."
      >
        <RepoPicker
          available={availableRepos}
          loading={reposLoading}
          selected={repositories}
          onChange={setRepositories}
        />
      </Field>

      <Field
        label="CVEs to swarm"
        hint="This week's feed, newest and most severe first. Pick the top N by severity — one agent hunts each — or fine-tune the list below."
      >
        <CvePicker
          feed={feed}
          loading={liveCves.isLoading}
          error={liveCves.isError}
          onRetry={() => void liveCves.refetch()}
          selected={cveIds}
          onChange={setCveIds}
          onPickTopN={pickTopN}
          maxCells={MAX_SWARM_CELLS}
        />
      </Field>

      <Field label="Model">
        <span className="bg-muted inline-flex w-fit items-center gap-2 rounded-md px-2.5 py-1 font-mono text-xs">
          <ShieldCheck className="size-3.5" />
          {DEFAULT_SWARM_MODEL}
        </span>
      </Field>

      <label
        htmlFor="swarm-declaration"
        className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3 text-sm"
      >
        <Checkbox
          id="swarm-declaration"
          checked={declaration}
          onCheckedChange={(v) => setDeclaration(v === true)}
          className="mt-0.5"
          required
        />
        <span>{SCAN_DECLARATION}</span>
      </label>

      <div className="flex items-center gap-3">
        <Button
          disabled={!ready || launching || deployState === 'failed'}
          onClick={() => onLaunch(payload, credentials)}
        >
          {launching ? <Loader2 className="animate-spin" /> : <Radar />}
          Launch swarm
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!ready}
          onClick={() => setPreview(composeLaunchPrompt(payload))}
        >
          Preview payload
        </Button>
        {cveIds.length > 0 ? (
          <span
            className={cn(
              'text-xs',
              overCap ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {cellCount} agent{cellCount === 1 ? '' : 's'} ·{' '}
            {repositories.length} repo{repositories.length === 1 ? '' : 's'} each
            {overCap
              ? ` — over the ${MAX_SWARM_CELLS} limit, pick fewer CVEs`
              : null}
          </span>
        ) : null}
      </div>

      {preview ? (
        <pre className="bg-muted text-foreground overflow-x-auto rounded-md p-4 font-mono text-xs leading-5 whitespace-pre-wrap">
          {preview}
        </pre>
      ) : null}
    </div>
  )
}

// A chip multi-select over the install's repos: type to filter, click to add,
// with the whole set selected by default upstream. Repos not in the fetched
// list can still be typed in full (owner/repository) as a fallback, since the
// install — not this list — is the real boundary.
function RepoPicker({
  available,
  loading,
  selected,
  onChange,
}: {
  available: string[]
  loading: boolean
  selected: string[]
  onChange: (repos: string[]) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Close the dropdown when focus or a click lands outside the picker.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const normalized = query.trim().replace(/^https?:\/\/github\.com\//i, '')
  const unselected = available.filter((r) => !selected.includes(r))
  const matches = normalized
    ? unselected.filter((r) =>
        r.toLowerCase().includes(normalized.toLowerCase()),
      )
    : unselected
  // Allow a repo the listing didn't return (fine-grained installs can hide
  // some) as long as it's a well-formed owner/repository not already chosen.
  const canAddRaw =
    /^[^/\s]+\/[^/\s]+$/.test(normalized) &&
    !selected.includes(normalized) &&
    !available.includes(normalized)

  function add(repo: string) {
    if (!selected.includes(repo)) onChange([...selected, repo])
    setQuery('')
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            placeholder={
              loading ? 'Loading your repositories…' : 'Search or owner/repository'
            }
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (matches.length > 0) add(matches[0])
                else if (canAddRaw) add(normalized)
              } else if (e.key === 'Escape') {
                setOpen(false)
              }
            }}
          />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-2 flex items-center"
            aria-label="Toggle repository list"
          >
            <ChevronDown className="size-4" />
          </button>
        </div>
        {available.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              onChange(
                selected.length === available.length ? [] : [...available],
              )
            }
          >
            {selected.length === available.length ? 'Clear' : 'Select all'}
          </Button>
        ) : null}
      </div>

      {open && (matches.length > 0 || canAddRaw) ? (
        <ul className="bg-popover text-popover-foreground absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border p-1 shadow-md">
          {matches.map((repo) => (
            <li key={repo}>
              <button
                type="button"
                onClick={() => add(repo)}
                className="hover:bg-muted flex w-full items-center rounded px-2 py-1.5 text-left font-mono text-xs"
              >
                {repo}
              </button>
            </li>
          ))}
          {canAddRaw ? (
            <li>
              <button
                type="button"
                onClick={() => add(normalized)}
                className="hover:bg-muted flex w-full items-center rounded px-2 py-1.5 text-left text-xs"
              >
                Add <span className="ml-1 font-mono">{normalized}</span>
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}

      {selected.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {selected.map((repo) => (
            <span
              key={repo}
              className="bg-muted inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-xs"
            >
              {repo}
              <button
                type="button"
                onClick={() => onChange(selected.filter((r) => r !== repo))}
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${repo}`}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// The CVE band shown on each row, derived from the stated severity or, failing
// that, the CVSS score. Drives the badge colour and label.
function cveSeverityLabel(cve: FeedCve): { label: string; className: string } {
  const band =
    cve.statedSeverity?.toLowerCase() ??
    (typeof cve.cvss === 'number'
      ? cve.cvss >= 9
        ? 'critical'
        : cve.cvss >= 7
          ? 'high'
          : cve.cvss >= 4
            ? 'medium'
            : 'low'
      : null)
  switch (band) {
    case 'critical':
      return { label: 'Critical', className: 'text-destructive' }
    case 'high':
      return { label: 'High', className: 'text-destructive/80' }
    case 'medium':
      return { label: 'Medium', className: 'text-muted-foreground' }
    case 'low':
      return { label: 'Low', className: 'text-muted-foreground/70' }
    default:
      return { label: 'Unscored', className: 'text-muted-foreground/70' }
  }
}

// The live-CVE picker: pick the top N by severity in one move, or toggle rows to
// fine-tune. The feed arrives severity-sorted (worst first), so "top N" is just
// the first N. Rows past the cap are disabled unless already selected.
function CvePicker({
  feed,
  loading,
  error,
  onRetry,
  selected,
  onChange,
  onPickTopN,
  maxCells,
}: {
  feed: FeedCve[]
  loading: boolean
  error: boolean
  onRetry: () => void
  selected: string[]
  onChange: (ids: string[]) => void
  onPickTopN: (n: number) => void
  maxCells: number
}) {
  const [topN, setTopN] = useState(DEFAULT_TOP_N)

  if (loading) {
    return (
      <div className="text-muted-foreground inline-flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" />
        Loading this week's CVE feed…
      </div>
    )
  }
  if (error || feed.length === 0) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-destructive">
          {error ? "Couldn't load the live CVE feed." : 'No CVEs in the feed right now.'}
        </span>
        <button
          type="button"
          onClick={onRetry}
          className="text-foreground underline underline-offset-4"
        >
          Retry
        </button>
      </div>
    )
  }

  const cap = Math.min(maxCells, feed.length)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs">Pick the top</span>
        <Input
          type="number"
          min={1}
          max={cap}
          value={topN}
          onChange={(e) => setTopN(Number(e.target.value))}
          className="w-20"
        />
        <span className="text-muted-foreground text-xs">by severity</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPickTopN(Math.max(1, Math.min(topN, cap)))}
        >
          Select top {Math.max(1, Math.min(topN, cap))}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange([])}
          disabled={selected.length === 0}
        >
          Clear
        </Button>
        <span className="text-muted-foreground ml-auto text-xs">
          {selected.length} of {feed.length} selected
        </span>
      </div>

      <div className="grid max-h-80 gap-1.5 overflow-auto sm:grid-cols-2">
        {feed.map((cve) => {
          const checked = selected.includes(cve.id)
          const sev = cveSeverityLabel(cve)
          const atCap = !checked && selected.length >= maxCells
          return (
            <label
              key={cve.id}
              htmlFor={`cve-${cve.id}`}
              className={cn(
                'flex items-start gap-2.5 rounded-md border px-3 py-2 text-sm',
                atCap
                  ? 'cursor-not-allowed opacity-50'
                  : 'hover:bg-muted/50 cursor-pointer',
              )}
            >
              <Checkbox
                id={`cve-${cve.id}`}
                checked={checked}
                disabled={atCap}
                onCheckedChange={(value) =>
                  onChange(
                    value
                      ? [...selected, cve.id]
                      : selected.filter((id) => id !== cve.id),
                  )
                }
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs">{cve.id}</span>
                  {cve.kev ? (
                    <span className="text-destructive text-[10px] font-semibold uppercase">
                      KEV
                    </span>
                  ) : null}
                </span>
                <span className="text-muted-foreground block truncate">
                  {cve.title}
                </span>
                <span className={cn('block text-xs', sev.className)}>
                  {sev.label}
                  {typeof cve.cvss === 'number' ? ` · ${cve.cvss.toFixed(1)}` : ''}
                </span>
              </span>
            </label>
          )
        })}
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {hint ? (
        <span className="text-muted-foreground block text-xs leading-5">
          {hint}
        </span>
      ) : null}
      <div className="pt-0.5">{children}</div>
    </div>
  )
}
