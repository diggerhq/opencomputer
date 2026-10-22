import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  FolderGit2,
  Loader2,
  Radar,
  RotateCcw,
  Rocket,
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
  putAgentRuntimeVariable,
  startManagedAgentSession,
} from '../api'
import { installedTemplateAgentId } from '../template-continuation'
import {
  cellDocumentId,
  composeCellPrompt,
  composeLaunchPrompt,
  DEFAULT_SWARM_MODEL,
  SCAN_DECLARATION,
  SECURITY_FINDINGS_RESOURCE,
  SECURITY_SWARM_TEMPLATE_REPOSITORY,
  SEED_CVES,
  swarmCells,
  type LaunchedCell,
  type SwarmPayload,
} from './catalog'
import { SwarmGrid } from './SwarmGrid'

// Each cell is one microVM session, so cap the matrix to keep an accidental
// 20×20 launch from spinning up hundreds of sandboxes at once.
const MAX_SWARM_CELLS = 24

const STEPS = ['Connect GitHub', 'Deploy swarm', 'Launch swarm'] as const

type DeployResult = { projectId: string; projectAgentId: string }

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

type SwarmRun = { runId: string; cells: LaunchedCell[] }

export default function SecurityOnboarding() {
  const [run, setRun] = useState<SwarmRun | null>(null)

  // Step 1 — GitHub connection. An active install means the boundary is set.
  const connections = useQuery({
    queryKey: ['managed-github-connections'],
    queryFn: getManagedGitHubConnections,
    retry: false,
  })
  const connected = (connections.data?.connections ?? []).some(
    (c) => c.state === 'active',
  )

  const [deployed, setDeployed] = useState<DeployResult | null>(null)
  const [manualStep, setManualStep] = useState<number | null>(null)

  // Derive the active step from real state, but let the user step forward in
  // the walkthrough even before a backend action resolves.
  const derivedStep = deployed ? 2 : connected ? 1 : 0
  const step = Math.max(derivedStep, manualStep ?? 0)

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

  // Launch fans the payload's repository × CVE matrix out into one bound,
  // labelled session per cell. Each cell gets its own findings document, created
  // first (a binding to a missing document fails admission), then a session
  // bound read-write to it with labels that tie it back to the run. The sessions
  // run in parallel; the grid below polls them by `swarmRun` label.
  const launch = useMutation({
    mutationFn: async (payload: SwarmPayload): Promise<SwarmRun> => {
      if (!deployed) throw new Error('Deploy the swarm before launching.')
      const cells = swarmCells(payload)
      if (cells.length === 0) {
        throw new Error('Add at least one repository and one CVE to swarm.')
      }
      if (cells.length > MAX_SWARM_CELLS) {
        throw new Error(
          `That is ${cells.length} cells (repos × CVEs). Trim to ${MAX_SWARM_CELLS} or fewer — each cell is its own sandbox.`,
        )
      }
      const runId = `run-${crypto.randomUUID()}`
      const agentId = `${deployed.projectAgentId}@default`
      const launched = await Promise.all(
        cells.map(async (cell): Promise<LaunchedCell> => {
          const id = cellDocumentId(runId, cell)
          await createManagedMemoryDocument({
            projectId: deployed.projectId,
            resource: SECURITY_FINDINGS_RESOURCE,
            environment: 'default',
            id,
            title: `${cell.repository} · ${cell.cveId}`,
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
          return { cell, sessionId }
        }),
      )
      return { runId, cells: launched }
    },
    onSuccess: (started) => setRun(started),
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
          icon={Rocket}
          title="Deploy the swarm"
          done={!!deployed}
        >
          <p className="text-muted-foreground text-sm">
            Create your own <code>CVE Swarm</code> project from the template.
            The default model is <strong>{DEFAULT_SWARM_MODEL}</strong>.
            Publishing stays off (dry-run fixes) until you turn it on.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <Button
              onClick={() => deploy.mutate()}
              disabled={deploy.isPending || !!deployed}
            >
              {deploy.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Rocket />
              )}
              {deployed ? 'Swarm deployed' : 'Deploy CVE Swarm'}
            </Button>
            {deploy.isError && !deployed ? (
              <span className="text-muted-foreground text-sm">
                Couldn't deploy yet — continue below to preview the launch.
              </span>
            ) : null}
          </div>
          {!deployed && step >= 1 ? (
            <button
              type="button"
              onClick={() => setManualStep(2)}
              className="text-muted-foreground hover:text-foreground mt-3 text-xs underline underline-offset-4"
            >
              Skip to the payload →
            </button>
          ) : null}
        </StepCard>

        <StepCard
          index={2}
          current={step}
          icon={Radar}
          title={run ? 'Swarm running' : 'Launch swarm from payload'}
          done={false}
        >
          {run && deployed ? (
            <div className="space-y-4">
              <SwarmGrid
                projectId={deployed.projectId}
                runId={run.runId}
                cells={run.cells}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setRun(null)}
              >
                <RotateCcw />
                New swarm
              </Button>
            </div>
          ) : (
            <PayloadBuilder
              canLaunch={!!deployed}
              launching={launch.isPending}
              onLaunch={(payload) => launch.mutate(payload)}
            />
          )}
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

function PayloadBuilder({
  canLaunch,
  launching,
  onLaunch,
}: {
  canLaunch: boolean
  launching: boolean
  onLaunch: (payload: SwarmPayload) => void
}) {
  const [target, setTarget] = useState('')
  const [declaration, setDeclaration] = useState(false)
  const [repoInput, setRepoInput] = useState('')
  const [repositories, setRepositories] = useState<string[]>([])
  // Prefill every CVE in this week's feed so a first swarm runs with no typing.
  const [cveIds, setCveIds] = useState<string[]>(() =>
    SEED_CVES.map((c) => c.id),
  )
  const [preview, setPreview] = useState<string | null>(null)

  const payload: SwarmPayload = useMemo(
    () => ({
      target: target.trim(),
      declarationAccepted: declaration,
      repositories,
      cveIds,
      model: DEFAULT_SWARM_MODEL,
    }),
    [target, declaration, repositories, cveIds],
  )

  // The target is the asset under test, and the declaration attests ownership
  // of "this web application" — so a launch needs a real https(s) URL. An empty
  // or malformed target blocks the button.
  const targetValid = /^https?:\/\/.+/i.test(payload.target)
  // Fan-out needs explicit repositories: one session per repository × CVE cell.
  const ready =
    declaration &&
    cveIds.length > 0 &&
    repositories.length > 0 &&
    targetValid

  function addRepo() {
    const value = repoInput.trim().replace(/^https?:\/\/github\.com\//i, '')
    if (!/^[^/\s]+\/[^/\s]+$/.test(value)) return
    if (!repositories.includes(value)) setRepositories([...repositories, value])
    setRepoInput('')
  }

  return (
    <div className="space-y-5">
      <Field
        label="Endpoint to scan"
        hint="A public URL you operate — required. Passive only: plain GETs on public paths and banner headers. No payloads, no auth probing."
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
        label="Repositories"
        hint="Repos from your GitHub install to swarm. Each repository is checked against each CVE as its own parallel cell."
      >
        <div className="flex gap-2">
          <Input
            placeholder="owner/repository"
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addRepo()
              }
            }}
          />
          <Button type="button" variant="outline" onClick={addRepo}>
            Add
          </Button>
        </div>
        {repositories.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {repositories.map((repo) => (
              <span
                key={repo}
                className="bg-muted inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-xs"
              >
                {repo}
                <button
                  type="button"
                  onClick={() =>
                    setRepositories(repositories.filter((r) => r !== repo))
                  }
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={`Remove ${repo}`}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </Field>

      <Field
        label="CVEs"
        hint="This week's feed, pre-selected. Trim to focus a run."
      >
        <div className="grid gap-1.5 sm:grid-cols-2">
          {SEED_CVES.map((cve) => {
            const checked = cveIds.includes(cve.id)
            return (
              <label
                key={cve.id}
                htmlFor={`cve-${cve.id}`}
                className="hover:bg-muted/50 flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-sm"
              >
                <Checkbox
                  id={`cve-${cve.id}`}
                  checked={checked}
                  onCheckedChange={(value) =>
                    setCveIds((current) =>
                      value
                        ? [...current, cve.id]
                        : current.filter((id) => id !== cve.id),
                    )
                  }
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block font-mono text-xs">{cve.id}</span>
                  <span className="text-muted-foreground block truncate">
                    {cve.product} · {cve.severity} {cve.cvss.toFixed(1)}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
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
          disabled={!ready || !canLaunch || launching}
          onClick={() => onLaunch(payload)}
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
        {!canLaunch ? (
          <span className="text-muted-foreground text-xs">
            Deploy the swarm above to launch.
          </span>
        ) : ready ? (
          <span className="text-muted-foreground text-xs">
            {repositories.length} × {cveIds.length} ={' '}
            {repositories.length * cveIds.length} parallel cell
            {repositories.length * cveIds.length === 1 ? '' : 's'}
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
