import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Loader2,
  RefreshCw,
  Trash2,
  Unplug,
} from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { GithubMark } from '@/components/github-mark'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  addManagedGitHubConnection,
  deployManagedDeploymentSource,
  getManagedDeploymentSource,
  getManagedGitHubConnections,
  listManagedDeploymentSourceBranches,
  listManagedDeploymentSourceRepositories,
  removeManagedDeploymentSource,
  removeManagedPreview,
  setManagedDeploymentSource,
  type ManagedDeploymentSourceRepository,
  type ManagedGitBuild,
} from './api'
import { launchAuthorizationWindow } from './authorization-window'

const selectClassName =
  'border-input bg-background h-9 min-w-48 rounded-md border px-3 text-sm disabled:opacity-50'

const REPOSITORY_PAGE_LIMIT = 20

async function listAllRepositories(input: {
  projectId: string
  connectionId: string
}): Promise<{ repositories: ManagedDeploymentSourceRepository[] }> {
  const repositories: ManagedDeploymentSourceRepository[] = []
  let cursor: string | null = null
  for (let page = 0; page < REPOSITORY_PAGE_LIMIT; page++) {
    const result = await listManagedDeploymentSourceRepositories({
      ...input,
      cursor,
    })
    repositories.push(...result.repositories)
    cursor = result.nextCursor
    if (!cursor) break
  }
  return { repositories }
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function refLabel(build: ManagedGitBuild): string {
  if (build.pullRequest) return `#${build.pullRequest.number}`
  return build.ref.replace(/^refs\/heads\//, '')
}

export function ManagedProjectSettings({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const queryKey = ['managed-deployment-source', projectId]
  const status = useQuery({
    queryKey,
    queryFn: () => getManagedDeploymentSource(projectId),
    refetchInterval: (query) =>
      query.state.data?.builds.some(
        (build) => build.state === 'queued' || build.state === 'building',
      )
        ? 3_000
        : 30_000,
  })
  const connections = useQuery({
    queryKey: ['managed-github-connections'],
    queryFn: getManagedGitHubConnections,
  })
  const activeConnections = (connections.data?.connections ?? []).filter(
    (connection) => connection.state === 'active',
  )

  const [editing, setEditing] = useState(false)
  // Form picks are stored only once the user changes them; until then the
  // effective value is derived from the saved source (or the first option).
  const [pickedConnectionId, setConnectionId] = useState('')
  const [pickedRepository, setRepositoryFullName] = useState('')
  const [pickedBranch, setBranch] = useState('')
  const [previewsEnabled, setPreviewsEnabled] = useState(true)
  const [addingConnection, setAddingConnection] = useState(false)

  const source = status.data?.source ?? null
  const configuring = editing || (status.isSuccess && !source)
  const connectionId =
    pickedConnectionId || source?.connectionId || activeConnections[0]?.id || ''

  const repositories = useQuery({
    queryKey: ['managed-deployment-source-repos', projectId, connectionId],
    queryFn: () => listAllRepositories({ projectId, connectionId }),
    enabled: configuring && Boolean(connectionId),
  })
  const repositoryOptions = repositories.data?.repositories ?? []
  const savedRepository =
    connectionId === source?.connectionId
      ? repositoryOptions.find(
          (repo) => repo.fullName === source.repository.fullName,
        )
      : undefined
  const selectedRepository =
    (pickedRepository
      ? repositoryOptions.find((repo) => repo.fullName === pickedRepository)
      : (savedRepository ?? repositoryOptions[0])) ?? null
  const repositoryFullName = selectedRepository?.fullName ?? ''
  const branch =
    pickedBranch ||
    (selectedRepository && selectedRepository === savedRepository
      ? source?.branch
      : selectedRepository?.defaultBranch) ||
    ''

  const branches = useQuery({
    queryKey: [
      'managed-deployment-source-branches',
      projectId,
      connectionId,
      repositoryFullName,
    ],
    queryFn: () =>
      listManagedDeploymentSourceBranches({
        projectId,
        connectionId,
        repository: repositoryFullName,
      }),
    enabled: configuring && Boolean(connectionId && repositoryFullName),
  })
  const branchOptions = branches.data?.branches ?? []

  const save = useMutation({
    mutationFn: () => {
      if (!selectedRepository) throw new Error('Choose a repository')
      return setManagedDeploymentSource({
        projectId,
        connectionId,
        repository: {
          id: selectedRepository.id,
          fullName: selectedRepository.fullName,
        },
        branch,
        previewsEnabled,
      })
    },
    onSuccess: async (data) => {
      queryClient.setQueryData(queryKey, data)
      await queryClient.invalidateQueries({ queryKey })
      setEditing(false)
      notifySuccess(`Deploying ${branch} from ${repositoryFullName}.`)
    },
    onError: (error) =>
      notifyError("Couldn't save the deployment source.", error),
  })
  const deploy = useMutation({
    mutationFn: () => deployManagedDeploymentSource(projectId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey })
      notifySuccess('Deployment started.')
    },
    onError: (error) => notifyError("Couldn't start the deployment.", error),
  })
  const disconnect = useMutation({
    mutationFn: () => removeManagedDeploymentSource(projectId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey })
      setEditing(false)
      setRepositoryFullName('')
      setBranch('')
      notifySuccess('Automatic deployments turned off.')
    },
    onError: (error) =>
      notifyError("Couldn't remove the deployment source.", error),
  })
  const removePreview = useMutation({
    mutationFn: (alias: string) => removeManagedPreview({ projectId, alias }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey })
      notifySuccess('Preview removed.')
    },
    onError: (error) => notifyError("Couldn't remove the preview.", error),
  })

  if (status.isLoading) {
    return (
      <Panel>
        <PanelContent className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading deployment
          settings…
        </PanelContent>
      </Panel>
    )
  }
  if (status.isError) {
    return (
      <Panel>
        <EmptyState
          icon={GitBranch}
          title="Deployment settings are temporarily unavailable"
          description="Try loading the project again."
          action={
            <Button variant="outline" onClick={() => void status.refetch()}>
              Try again
            </Button>
          }
        />
      </Panel>
    )
  }

  const builds = status.data?.builds ?? []
  const previews = status.data?.previews ?? []
  const latestBranchBuild = builds.find((build) => build.kind === 'branch')

  return (
    <div className="space-y-5">
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Deploy from GitHub</PanelTitle>
            <PanelDescription className="mt-1 max-w-2xl">
              Connect a repository and pick a branch. Every push to that branch
              builds the project and publishes it to the development
              environment; pull requests against it get their own preview
              environment.
            </PanelDescription>
          </div>
          {source ? (
            <StatusBadge status={latestBranchBuild?.state ?? 'not_deployed'} />
          ) : null}
        </PanelHeader>
        <PanelContent className="space-y-4">
          {source && !configuring ? (
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <GithubMark className="size-4" />
                  <a
                    href={source.repository.url}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline"
                  >
                    {source.repository.fullName}
                  </a>
                </p>
                <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
                  <GitBranch className="size-3.5" />
                  {source.branch}
                  {' · '}
                  {source.previewsEnabled
                    ? 'PR previews on'
                    : 'PR previews off'}
                  {source.connection
                    ? ` · ${source.connection.accountLogin}`
                    : ''}
                </p>
                {latestBranchBuild ? (
                  <p className="text-muted-foreground text-sm">
                    Last deploy {shortSha(latestBranchBuild.commitSha)}
                    {latestBranchBuild.state === 'failed' &&
                    latestBranchBuild.error
                      ? ` — ${latestBranchBuild.error}`
                      : ''}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  disabled={deploy.isPending}
                  onClick={() => deploy.mutate()}
                >
                  {deploy.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <RefreshCw />
                  )}
                  Deploy now
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setConnectionId('')
                    setRepositoryFullName('')
                    setBranch('')
                    setPreviewsEnabled(source.previewsEnabled)
                    setEditing(true)
                  }}
                >
                  Change
                </Button>
                <Button
                  variant="outline"
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate()}
                >
                  {disconnect.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Unplug />
                  )}
                  Turn off
                </Button>
              </div>
            </div>
          ) : activeConnections.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-muted-foreground max-w-2xl text-sm">
                Install the OpenComputer GitHub App on the repository you want
                to deploy from.
              </p>
              <Button
                disabled={addingConnection}
                onClick={() => {
                  setAddingConnection(true)
                  void launchAuthorizationWindow(() =>
                    addManagedGitHubConnection('install'),
                  )
                    .then(() =>
                      queryClient.invalidateQueries({
                        queryKey: ['managed-github-connections'],
                      }),
                    )
                    .catch((error: unknown) =>
                      notifyError(
                        "Couldn't start the GitHub installation.",
                        error,
                      ),
                    )
                    .finally(() => setAddingConnection(false))
                }}
              >
                {addingConnection ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <GithubMark className="size-4" />
                )}
                Add GitHub connection
              </Button>
            </div>
          ) : (
            <form
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault()
                save.mutate()
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor="deployment-source-connection">
                  GitHub connection
                </Label>
                <select
                  id="deployment-source-connection"
                  className={selectClassName}
                  value={connectionId}
                  onChange={(event) => {
                    setConnectionId(event.target.value)
                    setRepositoryFullName('')
                    setBranch('')
                  }}
                >
                  {activeConnections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.accountLogin}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="deployment-source-repository">Repository</Label>
                <select
                  id="deployment-source-repository"
                  className={selectClassName}
                  value={repositoryFullName}
                  disabled={repositories.isLoading || !repositoryOptions.length}
                  onChange={(event) => {
                    setRepositoryFullName(event.target.value)
                    setBranch('')
                  }}
                >
                  {repositories.isLoading ? (
                    <option value="">Loading repositories…</option>
                  ) : repositoryOptions.length ? (
                    repositoryOptions.map((repo) => (
                      <option key={repo.id} value={repo.fullName}>
                        {repo.fullName}
                      </option>
                    ))
                  ) : (
                    <option value="">
                      No repositories granted to this installation
                    </option>
                  )}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="deployment-source-branch">Branch</Label>
                <select
                  id="deployment-source-branch"
                  className={selectClassName}
                  value={branch}
                  disabled={branches.isLoading || !branchOptions.length}
                  onChange={(event) => setBranch(event.target.value)}
                >
                  {branches.isLoading ? (
                    <option value={branch}>Loading branches…</option>
                  ) : branchOptions.length ? (
                    branchOptions.map((candidate) => (
                      <option key={candidate.name} value={candidate.name}>
                        {candidate.name}
                      </option>
                    ))
                  ) : (
                    <option value={branch}>{branch || 'No branches'}</option>
                  )}
                </select>
              </div>
              <div className="flex items-center gap-3 self-end pb-2">
                <Switch
                  id="deployment-source-previews"
                  checked={previewsEnabled}
                  onCheckedChange={setPreviewsEnabled}
                />
                <Label htmlFor="deployment-source-previews">
                  Preview environment for every pull request
                </Label>
              </div>
              <div className="flex items-center gap-2 sm:col-span-2">
                <Button
                  type="submit"
                  disabled={
                    save.isPending || !selectedRepository || !branch.trim()
                  }
                >
                  {save.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <GitBranch />
                  )}
                  {source ? 'Save and deploy' : 'Connect and deploy'}
                </Button>
                {source ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setEditing(false)}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </form>
          )}
          {connections.data && !connections.data.app ? (
            <p className="text-destructive text-sm">
              The managed GitHub App is not configured in this environment.
            </p>
          ) : null}
        </PanelContent>
      </Panel>

      {source ? (
        <Panel>
          <PanelHeader>
            <div>
              <PanelTitle>Pull request previews</PanelTitle>
              <PanelDescription className="mt-1 max-w-2xl">
                Each open pull request against{' '}
                <span className="font-medium">{source.branch}</span> is deployed
                under its own alias. Target a preview from sessions, schedules,
                and webhooks as{' '}
                <code className="text-xs">agent@pr-&lt;number&gt;</code>, or
                open it in the playground. Previews disappear when the pull
                request closes.
              </PanelDescription>
            </div>
          </PanelHeader>
          <PanelContent>
            {previews.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {source.previewsEnabled
                  ? 'No open pull requests have been built yet.'
                  : 'Previews are turned off for this project.'}
              </p>
            ) : (
              <ul className="divide-border divide-y">
                {previews.map((preview) => (
                  <li
                    key={preview.alias}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        <GitPullRequest className="size-4 shrink-0" />
                        {preview.pullRequest ? (
                          <a
                            href={preview.pullRequest.url}
                            target="_blank"
                            rel="noreferrer"
                            className="truncate hover:underline"
                          >
                            #{preview.pullRequest.number}{' '}
                            {preview.pullRequest.title}
                          </a>
                        ) : (
                          preview.alias
                        )}
                      </p>
                      <p className="text-muted-foreground text-sm">
                        <code className="text-xs">{preview.alias}</code>
                        {' · '}
                        {shortSha(preview.commitSha)}
                        {preview.state === 'failed' && preview.error
                          ? ` — ${preview.error}`
                          : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={preview.state} />
                      {preview.state === 'ready' ? (
                        <Button asChild size="sm" variant="outline">
                          <Link
                            to={`/projects/${encodeURIComponent(projectId)}?environment=${encodeURIComponent(preview.alias)}`}
                          >
                            <ExternalLink />
                            Open preview
                          </Link>
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={removePreview.isPending}
                        onClick={() => removePreview.mutate(preview.alias)}
                        aria-label={`Remove ${preview.alias}`}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </PanelContent>
        </Panel>
      ) : null}

      {builds.length ? (
        <Panel>
          <PanelHeader>
            <div>
              <PanelTitle>Build history</PanelTitle>
              <PanelDescription className="mt-1">
                Recent branch deploys and preview builds.
              </PanelDescription>
            </div>
          </PanelHeader>
          <PanelContent>
            <ul className="divide-border divide-y">
              {builds.map((build) => (
                <li
                  key={build.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    {build.kind === 'preview' ? (
                      <GitPullRequest className="text-muted-foreground size-4 shrink-0" />
                    ) : (
                      <GitBranch className="text-muted-foreground size-4 shrink-0" />
                    )}
                    <span className="font-medium">{refLabel(build)}</span>
                    <code className="text-muted-foreground text-xs">
                      {shortSha(build.commitSha)}
                    </code>
                    <span className="text-muted-foreground">
                      → {build.alias}
                    </span>
                    {build.state === 'failed' && build.error ? (
                      <span className="text-destructive truncate">
                        {build.error}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground flex items-center gap-3 text-xs">
                    {new Date(build.updatedAt).toLocaleString()}
                    <StatusBadge status={build.state} />
                  </div>
                </li>
              ))}
            </ul>
          </PanelContent>
        </Panel>
      ) : null}
    </div>
  )
}
