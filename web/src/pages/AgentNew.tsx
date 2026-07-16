import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ExternalLink,
  FolderSearch,
  GitBranch,
  KeyRound,
  Loader2,
  Search,
} from 'lucide-react'
import {
  ApiError,
  getDeployApp,
  importAgentFromGithub,
  reviewRepositoryAgent,
  type DeployApp,
  type RepositorySourceInspection,
} from '@/api/client'
import { Field, FieldError, Input } from '@/components/form'
import { GithubMark } from '@/components/github-mark'
import { ManualAgentForm } from '@/components/manual-agent-form'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelFooter,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import {
  resolveAgentCreationMode,
  type AgentCreationMode,
} from '@/lib/agent-creation-mode'
import {
  isValidRepositoryRoot,
  repositoryReviewPresentation,
  repositorySeedFromState,
  sourceChangedRequiresReview,
  type RepositorySeed,
} from '@/lib/repository-onboarding'
import { cn } from '@/lib/utils'

const STARTER_URL = 'https://github.com/diggerhq/oc-flue-starter'
const STARTER_FORK_URL = `${STARTER_URL}/fork`
const IMPORT_COMMAND_STORAGE = 'oc.repository-import-command.v1'

type ImportBody = Parameters<typeof importAgentFromGithub>[0]
type ImportCommand = { fingerprint: string; key: string }
function existingAgentFromError(
  error: unknown,
): { id: string; name: string; conflict: 'name' | 'source' } | null {
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
    ? {
        id: row.id,
        name: row.name,
        conflict: error.type === 'source_already_linked' ? 'source' : 'name',
      }
    : null
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

function GithubImport({
  app,
  initialSource,
}: {
  app: DeployApp
  initialSource?: RepositorySeed
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const importCommand = useRef<ImportCommand | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const rootInput = useRef<HTMLInputElement>(null)
  const [repoSearch, setRepoSearch] = useState('')
  const initialRepo = app.repositories.find(
    (repo) => repo.id === initialSource?.repo,
  )
  const [repoId, setRepoId] = useState(initialRepo?.id ?? '')
  const [productionRef, setProductionRef] = useState(
    initialRepo
      ? initialSource?.productionRef || initialRepo.default_branch || 'main'
      : '',
  )
  const [root, setRoot] = useState(initialRepo ? initialSource?.path || '' : '')
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
  const rootValid = isValidRepositoryRoot(root.trim())

  const inspectMutation = useMutation({
    mutationFn: (source?: RepositorySeed) =>
      reviewRepositoryAgent({
        repo: source?.repo ?? repoId,
        path: (source?.path ?? root).trim(),
        production_ref: (source?.productionRef ?? productionRef).trim(),
      }),
    onSuccess: (inspection) => {
      setRoot(inspection.root)
      if (
        inspection.interpretation.disposition === 'exact' &&
        inspection.profile
      ) {
        setName((current) => current || inspection.profile!.manifest.entrypoint)
        globalThis.requestAnimationFrame?.(() => nameInput.current?.focus())
      }
    },
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
      void navigate(
        `/agents/${agent.id}/setup?deployment=${encodeURIComponent(deployment.id)}`,
      )
    },
  })

  const clearInspection = () => {
    inspectMutation.reset()
    importMutation.reset()
  }

  const changeSource = () => {
    setName('')
    clearInspection()
    globalThis.requestAnimationFrame?.(() => rootInput.current?.focus())
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
  const sourceChanged = sourceChangedRequiresReview(importMutation.error)
  const reviewPresentation = inspection
    ? repositoryReviewPresentation(inspection)
    : null
  const exactInspection =
    inspection?.interpretation.disposition === 'exact' && inspection.profile
      ? inspection
      : null
  const canInspect =
    !!selectedRepo &&
    !!productionRef.trim() &&
    rootValid &&
    !inspectMutation.isPending
  const canImport =
    !!exactInspection &&
    !!name.trim() &&
    !sourceChanged &&
    !importMutation.isPending &&
    !inspectMutation.isPending

  const deployAgent = () => {
    if (
      !exactInspection ||
      exactInspection.interpretation.disposition !== 'exact' ||
      !canImport
    )
      return
    importMutation.mutate({
      name: name.trim(),
      source: {
        type: 'github',
        repo: exactInspection.repository.id,
        path: exactInspection.root,
        production_ref: exactInspection.production_ref,
      },
      review: {
        sha: exactInspection.sha,
        source_profile: exactInspection.interpretation.source_profile,
        fingerprint: exactInspection.review_fingerprint,
      },
      credential: 'managed',
    })
  }

  const reviewAgain = () => {
    importMutation.reset()
    inspectMutation.mutate(undefined)
  }

  const chooseCandidate = (
    candidate: RepositorySourceInspection['candidate_roots'][number],
  ) => {
    const next = {
      repo: repoId,
      path: candidate.path,
      productionRef,
    }
    setRoot(candidate.path)
    setName('')
    clearInspection()
    inspectMutation.mutate(next)
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
          {inspection ? (
            <div className="min-w-0">
              <PanelTitle className="truncate">
                {inspection.repository.full_name}
              </PanelTitle>
              <PanelDescription className="mt-1 truncate">
                {inspection.production_ref}
                {' · '}
                {inspection.root || 'Repository root'}
                {' · '}
                <span className="font-mono">{shortSha(inspection.sha)}</span>
              </PanelDescription>
            </div>
          ) : (
            <div>
              <PanelTitle>Choose repository</PanelTitle>
              <PanelDescription className="mt-1">
                {app.account
                  ? `Repositories available to the OpenComputer App for ${app.account}.`
                  : 'Repositories available to the OpenComputer App.'}
              </PanelDescription>
            </div>
          )}
          {inspection ? (
            <Button variant="ghost" size="sm" onClick={changeSource}>
              Change source
            </Button>
          ) : app.configure_url ? (
            <Button variant="ghost" size="sm" asChild>
              <a href={app.configure_url} target="_blank" rel="noreferrer">
                Add repositories
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
          ) : null}
        </PanelHeader>
        {!inspection ? (
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
                      : 'Use a repository-relative path of at most 1,024 characters without . or .. segments.'
                  }
                  description="Leave empty to review the repository root."
                >
                  <Input
                    ref={rootInput}
                    id="import-root"
                    value={root}
                    onChange={(event) => {
                      setRoot(event.target.value)
                      setName('')
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
                disabled={!canInspect}
                onClick={() => inspectMutation.mutate(undefined)}
              >
                {inspectMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                ) : null}
                {inspectMutation.isPending
                  ? 'Reviewing agent…'
                  : inspectMutation.isError
                    ? 'Review agent again'
                    : 'Review agent'}
              </Button>
            </div>
          </PanelContent>
        ) : null}
      </Panel>

      {inspection?.interpretation.disposition === 'exact' &&
      inspection.profile ? (
        <Panel>
          <PanelHeader>
            <div>
              <PanelTitle>{reviewPresentation?.heading}</PanelTitle>
              <PanelDescription className="mt-1">
                {inspection.profile.manifest.entrypoint}
                {' · '}
                <span className="font-mono">
                  {inspection.profile.manifest.model}
                </span>
              </PanelDescription>
            </div>
          </PanelHeader>
          <PanelContent className="space-y-4">
            <Field
              label="Agent name"
              htmlFor="import-agent-name"
              description="Used in the dashboard and API."
            >
              <Input
                ref={nameInput}
                id="import-agent-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value)
                  importMutation.reset()
                }}
                placeholder="Support triage"
              />
            </Field>
            <p className="text-muted-foreground flex items-center gap-2 text-xs">
              <KeyRound className="size-3.5 shrink-0" aria-hidden />
              Model access is managed by OpenComputer.
            </p>
            {inspection.profile.warnings.map((warning) => (
              <Alert key={`${warning.code}:${warning.message}`}>
                <AlertTitle>Compatibility warning</AlertTitle>
                <AlertDescription>{warning.message}</AlertDescription>
              </Alert>
            ))}
            {importMutation.isError ? (
              <Alert
                variant={
                  existingAgent || sourceChanged ? 'default' : 'destructive'
                }
              >
                <AlertTitle>
                  {sourceChanged
                    ? 'Repository changed since review'
                    : existingAgent?.conflict === 'source'
                      ? 'Repository already linked'
                      : existingAgent
                        ? 'Agent name already in use'
                        : 'Agent could not be created'}
                </AlertTitle>
                <AlertDescription>
                  {sourceChanged
                    ? 'Nothing was created. Review the current commit before deploying it.'
                    : existingAgent?.conflict === 'source'
                      ? `This repository path is already linked to ${existingAgent.name}. Open the existing agent to deploy its latest commit.`
                      : existingAgent
                        ? `Another agent is already named ${existingAgent.name}. Choose a different name or open the existing agent.`
                        : importMutation.error instanceof Error
                          ? importMutation.error.message
                          : 'The import request failed. You can retry without creating a duplicate.'}
                </AlertDescription>
                {sourceChanged ? (
                  <div className="mt-3">
                    <Button
                      size="sm"
                      onClick={reviewAgain}
                      disabled={inspectMutation.isPending}
                    >
                      {inspectMutation.isPending ? (
                        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                      ) : null}
                      Review agent again
                    </Button>
                  </div>
                ) : existingAgent ? (
                  <div className="mt-3">
                    <Button size="sm" asChild>
                      <Link to={`/agents/${existingAgent.id}`}>Open agent</Link>
                    </Button>
                  </div>
                ) : null}
              </Alert>
            ) : null}
          </PanelContent>
          <PanelFooter className="justify-end">
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
          </PanelFooter>
        </Panel>
      ) : inspection?.interpretation.disposition === 'invalid' ? (
        <Panel>
          <PanelHeader>
            <div>
              <PanelTitle>{reviewPresentation?.heading}</PanelTitle>
              <PanelDescription className="mt-1">
                {reviewPresentation?.explanation}
              </PanelDescription>
            </div>
          </PanelHeader>
          <PanelContent className="space-y-3">
            {inspection.interpretation.issues.map((issue) => (
              <Alert
                key={`${issue.code}:${issue.path ?? ''}:${issue.message}`}
                variant="destructive"
              >
                <AlertTitle>{issue.path || issue.code}</AlertTitle>
                <AlertDescription>{issue.message}</AlertDescription>
              </Alert>
            ))}
            {inspection.interpretation.issues.length === 0 ? (
              <Alert variant="destructive">
                <AlertTitle>{inspection.interpretation.reason_code}</AlertTitle>
                <AlertDescription>
                  {inspection.interpretation.summary}
                </AlertDescription>
              </Alert>
            ) : null}
          </PanelContent>
          <PanelFooter className="justify-between gap-2">
            <Button variant="ghost" onClick={changeSource}>
              Choose another folder
            </Button>
            <Button onClick={reviewAgain} disabled={inspectMutation.isPending}>
              {inspectMutation.isPending ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              Review agent again
            </Button>
          </PanelFooter>
        </Panel>
      ) : inspection?.interpretation.disposition === 'unrecognized' ? (
        <Panel>
          <PanelHeader>
            <div>
              <PanelTitle>{reviewPresentation?.heading}</PanelTitle>
              <PanelDescription className="mt-1">
                {reviewPresentation?.explanation}
              </PanelDescription>
            </div>
          </PanelHeader>
          <PanelContent className="space-y-4">
            {inspection.candidate_roots.length ? (
              <div
                className="divide-y overflow-hidden rounded-md border"
                aria-label="Candidate agent folders"
              >
                {inspection.candidate_roots.map((candidate) => (
                  <div
                    key={`${candidate.path}:${candidate.marker ?? ''}`}
                    className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm">
                        {candidate.path || 'Repository root'}
                      </p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {candidate.summary}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={inspectMutation.isPending}
                      onClick={() => chooseCandidate(candidate)}
                    >
                      {inspectMutation.isPending ? (
                        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                      ) : (
                        <FolderSearch className="size-4" />
                      )}
                      Choose folder
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
            {inspection.candidate_roots_truncated ? (
              <Alert>
                <AlertTitle>More folders may match</AlertTitle>
                <AlertDescription>
                  The bounded search was truncated. Choose a narrower root and
                  review again.
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {inspection.candidate_roots.length === 0 ? (
                <Button onClick={changeSource}>Choose another folder</Button>
              ) : null}
              <Button variant="outline" asChild>
                <a href={STARTER_FORK_URL} target="_blank" rel="noreferrer">
                  Fork the Flue starter
                  <ExternalLink className="size-3.5" />
                </a>
              </Button>
              <Button variant="ghost" asChild>
                <Link to="/agents/new?mode=manual">Configure manually</Link>
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
  const location = useLocation()
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
          Deploy an agent from an existing repository or configure one manually.
        </p>
      </div>

      <div className="bg-muted mb-6 flex flex-col gap-1 rounded-lg p-1 sm:flex-row">
        <ModeButton
          active={mode === 'github'}
          onClick={() => setMode('github')}
          icon={GithubMark}
          title="Import from GitHub"
          description="Review and deploy an agent from code."
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
          <GithubImport
            app={deployAppQuery.data}
            initialSource={repositorySeedFromState(location.state)}
          />
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
