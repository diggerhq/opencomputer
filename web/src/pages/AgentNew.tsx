import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ExternalLink,
  GitBranch,
  KeyRound,
  Loader2,
  Search,
} from 'lucide-react'
import {
  ApiError,
  getDeployApp,
  importAgentFromGithub,
  inspectFlueRepository,
  type DeployApp,
  type FlueSourceInspection,
} from '@/api/client'
import { Field, FieldError, Input } from '@/components/form'
import { GithubMark } from '@/components/github-mark'
import { ManualAgentForm } from '@/components/manual-agent-form'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  resolveAgentCreationMode,
  type AgentCreationMode,
} from '@/lib/agent-creation-mode'
import { cn } from '@/lib/utils'

const STARTER_URL = 'https://github.com/diggerhq/oc-flue-starter'
const STARTER_FORK_URL = `${STARTER_URL}/fork`
const IMPORT_COMMAND_STORAGE = 'oc.flue-import-command.v1'

type ImportBody = Parameters<typeof importAgentFromGithub>[0]
type ImportCommand = { fingerprint: string; key: string }

function existingAgentFromError(
  error: unknown,
): { id: string; name: string } | null {
  if (
    !(error instanceof ApiError) ||
    (error.type !== 'name_conflict' && error.type !== 'source_already_linked')
  ) {
    return null
  }
  const existing = error.details?.existing_agent
  if (!existing || typeof existing !== 'object' || Array.isArray(existing))
    return null
  const row = existing as Record<string, unknown>
  return typeof row.id === 'string' && typeof row.name === 'string'
    ? { id: row.id, name: row.name }
    : null
}

function isValidRoot(root: string): boolean {
  if (root.includes('\0') || root.includes('\\') || root.startsWith('/'))
    return false
  return !root
    .split('/')
    .filter(Boolean)
    .some((part) => part === '.' || part === '..')
}

function newCommandKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `import-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

function stableCommandKey(
  fingerprint: string,
  memory: { current: ImportCommand | null },
): string {
  if (memory.current?.fingerprint === fingerprint) return memory.current.key

  try {
    const stored = window.sessionStorage.getItem(IMPORT_COMMAND_STORAGE)
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<ImportCommand>
      if (parsed.fingerprint === fingerprint && parsed.key) {
        memory.current = { fingerprint, key: parsed.key }
        return parsed.key
      }
    }
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }

  const key = newCommandKey()
  memory.current = { fingerprint, key }
  try {
    window.sessionStorage.setItem(
      IMPORT_COMMAND_STORAGE,
      JSON.stringify({ fingerprint, key }),
    )
  } catch {
    // The in-memory key still makes repeated submits stable for this page load.
  }
  return key
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function agentReviewError(error: unknown): string {
  if (error instanceof ApiError && error.type === 'builds_unavailable') {
    return 'Repository import is temporarily unavailable. Try reviewing the agent again.'
  }
  return error instanceof Error ? error.message : 'Agent review failed.'
}

function ModeButton({
  active,
  onClick,
  icon: Icon,
  title,
  description,
}: {
  active: boolean
  onClick: () => void
  icon: typeof GithubMark | typeof Bot
  title: string
  description: string
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'focus-visible:ring-ring/50 flex min-w-0 flex-1 items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-3',
        active
          ? 'bg-background text-foreground ring-border shadow-sm ring-1'
          : 'hover:bg-background/60',
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="text-muted-foreground mt-0.5 block text-xs">
          {description}
        </span>
      </span>
    </button>
  )
}

function DetectedAgent({ inspection }: { inspection: FlueSourceInspection }) {
  const rows = [
    ['Flue entrypoint', inspection.manifest.entrypoint],
    [
      'Runtime',
      `${inspection.manifest.runtime.family}/${inspection.manifest.runtime.type}`,
    ],
    ['Model', inspection.manifest.model],
    ['Commit', shortSha(inspection.sha)],
    [
      'Node',
      `${inspection.package.node_engine} (builder ${inspection.builder.node})`,
    ],
    ['npm lockfile', `lockfileVersion ${inspection.lockfile.version}`],
  ]

  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>Detected Flue agent</PanelTitle>
          <PanelDescription className="mt-1">
            Read from the exact commit without running repository code.
          </PanelDescription>
        </div>
        <Badge variant="outline">{shortSha(inspection.sha)}</Badge>
      </PanelHeader>
      <PanelContent className="space-y-4">
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-muted-foreground text-xs">{label}</dt>
              <dd className="mt-0.5 truncate font-mono text-sm" title={value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <div className="border-t pt-4">
          <p className="text-muted-foreground text-xs">Source</p>
          <p className="mt-1 text-sm">
            {inspection.source.files.toLocaleString()} tracked files,{' '}
            {formatBytes(inspection.source.bytes)}
          </p>
        </div>
        <div className="border-t pt-4">
          <p className="text-muted-foreground text-xs">
            Variables from agent.toml
          </p>
          {inspection.variable_names.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {inspection.variable_names.map((name) => (
                <Badge key={name} variant="secondary" className="font-mono">
                  {name}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-sm">No variables declared.</p>
          )}
          <p className="text-muted-foreground mt-2 text-xs">
            Values stay in source and are not shown here.
          </p>
        </div>
      </PanelContent>
    </Panel>
  )
}

function GithubImport({ app }: { app: DeployApp }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const importCommand = useRef<ImportCommand | null>(null)
  const [repoSearch, setRepoSearch] = useState('')
  const [repoId, setRepoId] = useState('')
  const [productionRef, setProductionRef] = useState('')
  const [root, setRoot] = useState('')
  const [name, setName] = useState('')

  const repositories = useMemo(() => {
    const needle = repoSearch.trim().toLowerCase()
    return app.repositories
      .filter(
        (repo): repo is typeof repo & { id: string } =>
          typeof repo.id === 'string' && repo.id.length > 0,
      )
      .filter(
        (repo) => !needle || repo.full_name.toLowerCase().includes(needle),
      )
  }, [app.repositories, repoSearch])

  const selectedRepo = app.repositories.find((repo) => repo.id === repoId)
  const rootValid = isValidRoot(root.trim())

  const inspectMutation = useMutation({
    mutationFn: () =>
      inspectFlueRepository({
        repo: repoId,
        path: root.trim(),
        production_ref: productionRef.trim(),
      }),
    onSuccess: (inspection) => setName(inspection.manifest.entrypoint),
  })

  const importMutation = useMutation({
    mutationFn: (body: ImportBody) =>
      importAgentFromGithub(
        body,
        stableCommandKey(JSON.stringify(body), importCommand),
      ),
    onSuccess: ({ agent, deployment }) => {
      try {
        window.sessionStorage.removeItem(IMPORT_COMMAND_STORAGE)
      } catch {
        // Storage can be unavailable in privacy-restricted browser contexts.
      }
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      void navigate(`/agents/${agent.id}/deployments/${deployment.id}`)
    },
  })

  const clearInspection = () => {
    inspectMutation.reset()
    importMutation.reset()
  }

  const selectRepo = (id: string) => {
    const repo = app.repositories.find((candidate) => candidate.id === id)
    setRepoId(id)
    setProductionRef(repo?.default_branch || 'main')
    setRoot('')
    setName('')
    clearInspection()
  }

  const inspection = inspectMutation.data
  const existingAgent = existingAgentFromError(importMutation.error)
  const canInspect =
    !!selectedRepo &&
    !!productionRef.trim() &&
    rootValid &&
    !inspectMutation.isPending
  const canImport =
    !!inspection &&
    !!name.trim() &&
    !importMutation.isPending &&
    !inspectMutation.isPending

  const deployAgent = () => {
    if (!inspection || !canImport) return
    importMutation.mutate({
      name: name.trim(),
      source: {
        type: 'github',
        repo: inspection.repository.id,
        path: inspection.root,
        production_ref: inspection.production_ref,
      },
      credential: 'managed',
    })
  }

  if (!app.installed) {
    return (
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Connect GitHub</PanelTitle>
            <PanelDescription className="mt-1">
              Install the OpenComputer App and choose the repositories it may
              deploy.
            </PanelDescription>
          </div>
        </PanelHeader>
        <PanelContent className="space-y-3">
          {app.install_url ? (
            <Button asChild>
              <a href={app.install_url} target="_blank" rel="noreferrer">
                <GithubMark className="size-4" />
                Install GitHub App
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
          ) : (
            <Button disabled>
              <GithubMark className="size-4" />
              Install GitHub App
            </Button>
          )}
          <p className="text-muted-foreground max-w-xl text-sm">
            {app.install_url
              ? 'GitHub opens in a new tab. Return here after installation; this page refreshes the repository list when it regains focus.'
              : 'The installation link is unavailable. Refresh this page or contact support.'}
          </p>
        </PanelContent>
      </Panel>
    )
  }

  return (
    <div className="space-y-5">
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Choose repository</PanelTitle>
            <PanelDescription className="mt-1">
              {app.account
                ? `Repositories available to the OpenComputer App for ${app.account}.`
                : 'Repositories available to the OpenComputer App.'}
            </PanelDescription>
          </div>
          {app.configure_url ? (
            <Button variant="ghost" size="sm" asChild>
              <a href={app.configure_url} target="_blank" rel="noreferrer">
                Add repositories
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
          ) : null}
        </PanelHeader>
        <PanelContent className="space-y-4">
          <div className="relative">
            <Search
              className="text-muted-foreground pointer-events-none absolute top-2 left-2.5 size-4"
              aria-hidden
            />
            <Input
              value={repoSearch}
              onChange={(event) => setRepoSearch(event.target.value)}
              placeholder="Search repositories"
              aria-label="Search repositories"
              className="pl-8"
            />
          </div>
          <div
            role="group"
            aria-label="Repository"
            className="max-h-60 overflow-y-auto rounded-md border"
          >
            {repositories.length ? (
              repositories.map((repo, index) => (
                <button
                  key={repo.id}
                  type="button"
                  aria-pressed={repo.id === repoId}
                  onClick={() => selectRepo(repo.id)}
                  className={cn(
                    'focus-visible:ring-ring/50 flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-inset',
                    index > 0 && 'border-t',
                    repo.id === repoId
                      ? 'bg-row-selected'
                      : 'hover:bg-row-hover',
                  )}
                >
                  <GithubMark className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {repo.full_name}
                  </span>
                  <span className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs">
                    {repo.private == null
                      ? null
                      : repo.private
                        ? 'Private'
                        : 'Public'}
                    {repo.default_branch ? (
                      <span className="hidden items-center gap-1 sm:flex">
                        <GitBranch className="size-3" />
                        {repo.default_branch}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))
            ) : (
              <p className="text-muted-foreground px-4 py-8 text-center text-sm">
                {app.repositories.length === 0
                  ? 'No repositories are available to this installation.'
                  : app.repositories.some((repo) => repo.id)
                    ? 'No repositories match this search.'
                    : 'Repository registration is still syncing. Return to this page in a moment.'}
              </p>
            )}
          </div>

          {selectedRepo ? (
            <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
              <Field
                label="Production branch"
                htmlFor="import-branch"
                description="The branch to resolve for this deployment."
              >
                <Input
                  id="import-branch"
                  value={productionRef}
                  onChange={(event) => {
                    setProductionRef(event.target.value)
                    clearInspection()
                  }}
                  placeholder="main"
                />
              </Field>
              <Field
                label="Root directory"
                htmlFor="import-root"
                error={
                  rootValid
                    ? undefined
                    : 'Use a repository-relative path without . or .. segments.'
                }
                description="Leave empty when agent.toml is at repository root."
              >
                <Input
                  id="import-root"
                  value={root}
                  onChange={(event) => {
                    setRoot(event.target.value)
                    clearInspection()
                  }}
                  placeholder="agents/support"
                  aria-invalid={!rootValid}
                />
              </Field>
            </div>
          ) : null}

          {inspectMutation.isError ? (
            <FieldError>{agentReviewError(inspectMutation.error)}</FieldError>
          ) : null}

          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={!canInspect}
              onClick={() => inspectMutation.mutate()}
            >
              {inspectMutation.isPending ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              {inspectMutation.isPending
                ? 'Reviewing agent…'
                : inspectMutation.isError
                  ? 'Review agent again'
                  : inspection
                    ? 'Review again'
                    : 'Review agent'}
            </Button>
          </div>
        </PanelContent>
      </Panel>

      {inspection ? <DetectedAgent inspection={inspection} /> : null}

      {inspection?.warnings.map((warning) => (
        <Alert key={`${warning.code}:${warning.message}`}>
          <AlertTitle>Compatibility warning</AlertTitle>
          <AlertDescription>{warning.message}</AlertDescription>
        </Alert>
      ))}

      {inspection ? (
        <Panel>
          <PanelHeader>
            <div>
              <PanelTitle>Name and deploy</PanelTitle>
              <PanelDescription className="mt-1">
                The OpenComputer name can differ from the Flue entrypoint.
              </PanelDescription>
            </div>
          </PanelHeader>
          <PanelContent className="space-y-5">
            <Field
              label="Agent name"
              htmlFor="import-agent-name"
              description={`Flue entrypoint: ${inspection.manifest.entrypoint}`}
            >
              <Input
                id="import-agent-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value)
                  importMutation.reset()
                }}
                placeholder="Support triage"
              />
            </Field>
            <div className="bg-panel-2 flex items-start gap-3 rounded-md p-3">
              <KeyRound
                className="text-muted-foreground mt-0.5 size-4 shrink-0"
                aria-hidden
              />
              <div>
                <p className="text-sm font-medium">Managed credential</p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  OpenComputer provides model access for{' '}
                  <code className="font-mono">{inspection.manifest.model}</code>
                  . No provider key is added to the build environment.
                </p>
              </div>
            </div>
            {importMutation.isError ? (
              <Alert variant="destructive">
                <AlertTitle>Agent could not be created</AlertTitle>
                <AlertDescription>
                  {importMutation.error instanceof Error
                    ? importMutation.error.message
                    : 'The import request failed. You can retry without creating a duplicate.'}
                </AlertDescription>
                {existingAgent ? (
                  <div className="mt-3">
                    <Button size="sm" variant="outline" asChild>
                      <Link to={`/agents/${existingAgent.id}`}>
                        Open {existingAgent.name}
                      </Link>
                    </Button>
                  </div>
                ) : null}
              </Alert>
            ) : null}
            <div className="flex justify-end">
              <Button disabled={!canImport} onClick={deployAgent}>
                {importMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                ) : (
                  <ArrowRight className="size-4" />
                )}
                {importMutation.isPending
                  ? 'Creating deployment…'
                  : 'Deploy agent'}
              </Button>
            </div>
          </PanelContent>
        </Panel>
      ) : null}
    </div>
  )
}

export default function AgentNew() {
  const [searchParams, setSearchParams] = useSearchParams()
  const deployAppQuery = useQuery({
    queryKey: ['deploy-app'],
    queryFn: getDeployApp,
    refetchOnWindowFocus: 'always',
  })
  const mode = resolveAgentCreationMode(searchParams.get('mode'))
  const setMode = (next: AgentCreationMode) =>
    setSearchParams(next === 'github' ? {} : { mode: 'manual' }, {
      replace: true,
    })

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        to="/agents"
        className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1.5 text-sm"
      >
        <ArrowLeft className="size-4" />
        Back to agents
      </Link>

      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Create agent</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Deploy an existing Flue repository or configure an agent manually.
        </p>
      </div>

      <div className="bg-muted mb-6 flex flex-col gap-1 rounded-lg p-1 sm:flex-row">
        <ModeButton
          active={mode === 'github'}
          onClick={() => setMode('github')}
          icon={GithubMark}
          title="Import from GitHub"
          description="Build and deploy an existing Flue agent."
        />
        <ModeButton
          active={mode === 'manual'}
          onClick={() => setMode('manual')}
          icon={Bot}
          title="Configure manually"
          description="Create a built-in runtime agent from a prompt."
        />
      </div>

      {mode === 'github' ? (
        deployAppQuery.isLoading ? (
          <Panel aria-busy="true">
            <PanelHeader>
              <div>
                <PanelTitle>Connect GitHub</PanelTitle>
                <PanelDescription className="mt-1">
                  Loading your GitHub installation and repositories.
                </PanelDescription>
              </div>
            </PanelHeader>
            <PanelContent>
              <Skeleton className="h-10 w-full max-w-sm" />
            </PanelContent>
          </Panel>
        ) : deployAppQuery.isError ? (
          <Alert variant="destructive">
            <AlertTitle>GitHub import could not be loaded</AlertTitle>
            <AlertDescription>
              {deployAppQuery.error instanceof Error
                ? deployAppQuery.error.message
                : 'The GitHub installation request failed.'}
            </AlertDescription>
            <div className="mt-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void deployAppQuery.refetch()}
                disabled={deployAppQuery.isFetching}
              >
                {deployAppQuery.isFetching ? (
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                ) : null}
                Retry
              </Button>
            </div>
          </Alert>
        ) : deployAppQuery.data ? (
          <GithubImport app={deployAppQuery.data} />
        ) : null
      ) : (
        <Panel>
          <PanelHeader>
            <div>
              <PanelTitle>Configure manually</PanelTitle>
              <PanelDescription className="mt-1">
                Sessions pin a snapshot of this definition when they are
                created.
              </PanelDescription>
            </div>
          </PanelHeader>
          <PanelContent>
            <ManualAgentForm onCancel={() => setMode('github')} />
          </PanelContent>
        </Panel>
      )}

      <section className="mt-8 border-t pt-6" aria-labelledby="starter-heading">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-xl">
            <h2 id="starter-heading" className="text-sm font-semibold">
              Need a starting point?
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Fork the Flue starter, add your agent logic, then return here to
              deploy it.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={STARTER_URL} target="_blank" rel="noreferrer">
                View repository
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={STARTER_FORK_URL} target="_blank" rel="noreferrer">
                Fork on GitHub
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
