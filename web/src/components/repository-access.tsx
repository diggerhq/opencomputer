import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  GitPullRequest,
  LoaderCircle,
  Search,
  ShieldCheck,
} from 'lucide-react'
import {
  getDeployApp,
  updateRepositoryAccess,
  type RepositoryAccess,
  type RepositoryAccessPolicy,
} from '@/api/client'
import { GithubMark } from '@/components/github-mark'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelFooter,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { notifyError, notifySuccess } from '@/lib/errors'
import { useRepositoryAccess } from '@/hooks/use-repository-access'
import {
  isNarrowingRepositoryAccess,
  repositoryAccessCandidates,
  repositoryAccessQueryKey,
  sameRepositoryAccessPolicy,
  selectedRepositoryIds,
  toggleSelectedRepository,
} from '@/lib/repository-access'
import { cn } from '@/lib/utils'

function ExternalAction({
  href,
  children,
}: {
  href: string
  children: string
}) {
  return (
    <Button asChild size="sm" variant="outline">
      <a href={href} target="_blank" rel="noreferrer">
        {children}
        <ArrowUpRight />
      </a>
    </Button>
  )
}

function AccessUnavailable({
  access,
  onRetry,
}: {
  access: RepositoryAccess
  onRetry: () => void
}) {
  if (access.grant.status === 'not_installed') {
    return (
      <div className="flex flex-col items-start gap-3 py-1">
        <div>
          <p className="text-sm font-medium">
            Connect GitHub to work in repositories
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            Chat still works without GitHub. Connect the OpenComputer app when
            this agent needs to read code or open pull requests.
          </p>
        </div>
        <ExternalAction href={access.grant.install_url}>
          Connect GitHub
        </ExternalAction>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-start gap-3 py-1">
      <div>
        <p className="text-sm font-medium">
          GitHub access is temporarily unavailable
        </p>
        <p className="text-muted-foreground mt-1 text-sm">
          Nothing changed. Try loading the installation again.
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

interface RepositoryAccessPanelProps {
  agentId: string
  context?: 'setup' | 'settings'
}

export function RepositoryAccessPanel({
  agentId,
  context = 'settings',
}: RepositoryAccessPanelProps) {
  return (
    <RepositoryAccessPanelForAgent
      key={agentId}
      agentId={agentId}
      context={context}
    />
  )
}

function RepositoryAccessPanelForAgent({
  agentId,
  context = 'settings',
}: RepositoryAccessPanelProps) {
  const queryClient = useQueryClient()
  const accessQuery = useRepositoryAccess(agentId)
  const deployAppQuery = useQuery({
    queryKey: ['deploy-app'],
    queryFn: getDeployApp,
    enabled:
      accessQuery.data?.grant.status === 'active' &&
      accessQuery.data.policy.mode === 'selected',
    staleTime: 30_000,
    refetchOnWindowFocus: 'always',
  })
  const [draft, setDraft] = useState<RepositoryAccessPolicy | null>(
    () => accessQuery.data?.policy ?? null,
  )
  const baselinePolicy = useRef<RepositoryAccessPolicy | null>(null)
  const [search, setSearch] = useState('')
  const [confirming, setConfirming] = useState(false)

  const access = accessQuery.data
  useEffect(() => {
    if (!access) return
    setDraft((current) => {
      const clean =
        current === null ||
        baselinePolicy.current === null ||
        sameRepositoryAccessPolicy(current, baselinePolicy.current)
      baselinePolicy.current = access.policy
      return clean ? access.policy : current
    })
  }, [access])

  const candidates = useMemo(
    () =>
      access ? repositoryAccessCandidates(access, deployAppQuery.data) : [],
    [access, deployAppQuery.data],
  )
  const visibleCandidates = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    return term
      ? candidates.filter((repo) =>
          repo.full_name.toLocaleLowerCase().includes(term),
        )
      : candidates
  }, [candidates, search])

  const saveMutation = useMutation({
    mutationFn: (policy: RepositoryAccessPolicy) =>
      updateRepositoryAccess(agentId, policy),
    onMutate: async (policy) => {
      const key = repositoryAccessQueryKey(agentId)
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<RepositoryAccess>(key)
      if (previous) queryClient.setQueryData(key, { ...previous, policy })
      return { previous }
    },
    onError: (error, _policy, contextValue) => {
      if (contextValue?.previous) {
        queryClient.setQueryData(
          repositoryAccessQueryKey(agentId),
          contextValue.previous,
        )
        setDraft(contextValue.previous.policy)
        baselinePolicy.current = contextValue.previous.policy
      }
      notifyError("Couldn't save repository access.", error)
    },
    onSuccess: (next) => {
      queryClient.setQueryData(repositoryAccessQueryKey(agentId), next)
      setDraft(next.policy)
      baselinePolicy.current = next.policy
      notifySuccess('Repository access saved.')
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: repositoryAccessQueryKey(agentId),
      }),
  })

  const save = () => {
    if (!access || !draft) return
    if (isNarrowingRepositoryAccess(access.policy, draft)) {
      setConfirming(true)
      return
    }
    saveMutation.mutate(draft)
  }

  const title =
    context === 'setup' ? 'Choose working repositories' : 'Repository access'
  const description =
    context === 'setup'
      ? 'Optional. Let this agent check out code and open pull requests.'
      : 'Choose where this agent can check out code and open pull requests.'

  return (
    <Panel className="min-w-0 overflow-hidden">
      <PanelHeader className="flex-wrap">
        <div className="min-w-0">
          <PanelTitle className="flex items-center gap-2">
            <GithubMark className="size-4" />
            {title}
          </PanelTitle>
          <PanelDescription className="mt-1">{description}</PanelDescription>
        </div>
        {access?.grant.status === 'active' && access.grant.account ? (
          <span className="text-muted-foreground max-w-40 truncate text-xs">
            {access.grant.account}
          </span>
        ) : null}
      </PanelHeader>
      <PanelContent>
        {accessQuery.isLoading ? (
          <div className="space-y-3" aria-label="Loading repository access">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : accessQuery.isError ? (
          <div className="flex flex-col items-start gap-3 py-1">
            <div>
              <p className="text-sm font-medium">
                Couldn’t load repository access
              </p>
              <p className="text-muted-foreground mt-1 text-sm">
                Nothing changed. Try loading it again.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void accessQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : access && access.grant.status !== 'active' ? (
          <AccessUnavailable
            access={access}
            onRetry={() => void accessQuery.refetch()}
          />
        ) : access && draft ? (
          <div className="space-y-4">
            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="sr-only">Repository policy</legend>
              <label
                className={cn(
                  'hover:border-foreground/20 focus-within:ring-foreground/20 flex min-h-16 min-w-0 cursor-pointer items-start gap-3 rounded-lg border p-3 text-left transition-colors focus-within:ring-2 focus-within:ring-offset-2',
                  draft.mode === 'all' && 'border-foreground/30 bg-muted/50',
                )}
              >
                <input
                  type="radio"
                  name={`repository-policy-${agentId}`}
                  value="all"
                  checked={draft.mode === 'all'}
                  onChange={() => setDraft({ mode: 'all' })}
                  className="sr-only"
                />
                <span
                  aria-hidden
                  className={cn(
                    'mt-0.5 grid size-4 place-items-center rounded-full border',
                    draft.mode === 'all' &&
                      'border-foreground bg-foreground text-background',
                  )}
                >
                  {draft.mode === 'all' ? <Check className="size-3" /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    All granted repositories
                  </span>
                  <span className="text-muted-foreground mt-0.5 block text-xs">
                    Includes repositories added to the installation later.
                  </span>
                </span>
              </label>
              <label
                className={cn(
                  'hover:border-foreground/20 focus-within:ring-foreground/20 flex min-h-16 min-w-0 cursor-pointer items-start gap-3 rounded-lg border p-3 text-left transition-colors focus-within:ring-2 focus-within:ring-offset-2',
                  draft.mode === 'selected' &&
                    'border-foreground/30 bg-muted/50',
                )}
              >
                <input
                  type="radio"
                  name={`repository-policy-${agentId}`}
                  value="selected"
                  checked={draft.mode === 'selected'}
                  onChange={() =>
                    setDraft({
                      mode: 'selected',
                      repository_ids:
                        access.policy.mode === 'selected'
                          ? selectedRepositoryIds(access.policy)
                          : (access.effective_repositories ?? []).map(
                              (repo) => repo.id,
                            ),
                    })
                  }
                  className="sr-only"
                />
                <span
                  aria-hidden
                  className={cn(
                    'mt-0.5 grid size-4 place-items-center rounded-full border',
                    draft.mode === 'selected' &&
                      'border-foreground bg-foreground text-background',
                  )}
                >
                  {draft.mode === 'selected' ? (
                    <Check className="size-3" />
                  ) : null}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    Only selected repositories
                  </span>
                  <span className="text-muted-foreground mt-0.5 block text-xs">
                    An empty selection disables repository work.
                  </span>
                </span>
              </label>
            </fieldset>

            {access.grant.truncated ? (
              <div className="border-border bg-muted/40 rounded-md border px-3 py-2 text-xs">
                <p className="font-medium">
                  GitHub returned a partial repository list
                </p>
                <p className="text-muted-foreground mt-0.5">
                  {access.policy.mode === 'selected'
                    ? 'Hidden existing selections are preserved when you save.'
                    : 'Switching to selected access limits the agent to repositories you choose from this partial list.'}{' '}
                  Configure the GitHub app to see the full grant.
                </p>
              </div>
            ) : null}

            {draft.mode === 'selected' ? (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Find a repository"
                    aria-label="Find a repository"
                    className="h-8 pl-8"
                  />
                </div>
                {deployAppQuery.isLoading ? (
                  <div
                    className="space-y-2"
                    aria-label="Loading repository catalog"
                  >
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : null}
                {deployAppQuery.isError ? (
                  <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs">
                    <span className="text-muted-foreground">
                      Couldn’t load the full repository list.
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void deployAppQuery.refetch()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : null}
                {!deployAppQuery.isLoading ? (
                  <div className="max-h-64 overflow-y-auto rounded-lg border">
                    {visibleCandidates.length ? (
                      visibleCandidates.map((repo) => {
                        const checked = draft.repository_ids.includes(repo.id)
                        const unavailable =
                          access.unavailable_selected_repositories.some(
                            (item) => item.id === repo.id,
                          )
                        return (
                          <label
                            key={repo.id}
                            className="hover:bg-muted/40 flex min-w-0 cursor-pointer items-center gap-3 overflow-hidden border-b px-3 py-2.5 last:border-b-0"
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(next) =>
                                setDraft(
                                  toggleSelectedRepository(
                                    draft,
                                    repo.id,
                                    next === true,
                                  ),
                                )
                              }
                            />
                            <GithubMark className="text-muted-foreground size-3.5 shrink-0" />
                            <span
                              className="min-w-0 flex-1 truncate text-sm"
                              title={repo.full_name}
                            >
                              {repo.full_name}
                            </span>
                            {unavailable ? (
                              <span className="text-muted-foreground shrink-0 text-xs">
                                Unavailable
                              </span>
                            ) : repo.private ? (
                              <span className="text-muted-foreground shrink-0 text-xs">
                                Private
                              </span>
                            ) : null}
                          </label>
                        )
                      })
                    ) : (
                      <p className="text-muted-foreground px-3 py-5 text-center text-sm">
                        {candidates.length
                          ? 'No repositories match.'
                          : deployAppQuery.isError
                            ? 'Current selections are unavailable until the repository list reloads.'
                            : 'No repositories are available.'}
                      </p>
                    )}
                  </div>
                ) : null}
                {draft.repository_ids.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    Repository work is disabled. This agent can still chat.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </PanelContent>
      {access?.grant.status === 'active' && draft ? (
        <PanelFooter className="flex-wrap justify-between">
          <div className="min-w-0">
            {access.grant.configure_url ? (
              <a
                href={access.grant.configure_url}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline underline-offset-4"
              >
                Configure GitHub app <ArrowUpRight className="size-3" />
              </a>
            ) : null}
          </div>
          <Button
            size="sm"
            className="ml-auto"
            onClick={save}
            disabled={
              saveMutation.isPending ||
              sameRepositoryAccessPolicy(access.policy, draft)
            }
          >
            {saveMutation.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : null}
            Save access
          </Button>
        </PanelFooter>
      ) : null}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Narrow repository access?</AlertDialogTitle>
            <AlertDialogDescription>
              New checkouts and publishes to removed repositories will be
              blocked. Files already copied into an active session remain in its
              sandbox until that session is archived.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current access</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false)
                if (draft) saveMutation.mutate(draft)
              }}
            >
              Save narrower access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  )
}

export function RepositoryAccessSummary({
  agentId,
  onOpenSettings,
}: {
  agentId: string
  onOpenSettings: () => void
}) {
  const accessQuery = useRepositoryAccess(agentId)
  const access = accessQuery.data
  const effective = access?.effective_repositories ?? []
  const selected =
    access?.policy.mode === 'selected'
      ? access.policy.repository_ids.length
      : null

  return (
    <Panel>
      <PanelHeader className="border-b-0 pb-2">
        <PanelTitle className="flex items-center gap-2">
          <GithubMark className="size-4" /> Repository access
        </PanelTitle>
      </PanelHeader>
      <PanelContent className="pt-1">
        {accessQuery.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : accessQuery.isError ? (
          <button
            className="text-muted-foreground hover:text-foreground text-sm underline"
            onClick={() => void accessQuery.refetch()}
          >
            Couldn’t load access — retry
          </button>
        ) : access?.grant.status !== 'active' ? (
          <p className="text-sm">
            {access?.grant.status === 'unavailable'
              ? 'GitHub access is unavailable.'
              : 'GitHub is not connected.'}
          </p>
        ) : (
          <div className="flex items-start gap-2.5">
            <ShieldCheck className="text-status-running mt-0.5 size-4 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {access.policy.mode === 'all'
                  ? 'All granted repositories'
                  : selected === 0
                    ? 'Repository work disabled'
                    : `${selected} selected ${selected === 1 ? 'repository' : 'repositories'}`}
              </p>
              {effective[0] ? (
                <p className="text-muted-foreground mt-0.5 truncate text-xs">
                  {effective[0].full_name}
                  {effective.length > 1 ? ` +${effective.length - 1}` : ''}
                </p>
              ) : null}
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={onOpenSettings}
          className="text-muted-foreground hover:text-foreground mt-3 inline-flex items-center gap-1 text-xs font-medium"
        >
          Manage access <ChevronRight className="size-3" />
        </button>
      </PanelContent>
    </Panel>
  )
}

export function RepositoryTaskSuggestion({ agentId }: { agentId: string }) {
  const { data } = useRepositoryAccess(agentId)
  const repo = data?.effective_repositories?.[0]
  if (!repo) return null
  return (
    <div className="border-border bg-muted/30 flex items-start gap-3 rounded-lg border px-3 py-2.5">
      <GitPullRequest className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div>
        <p className="text-xs font-medium">Try a repository task</p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          In{' '}
          <span className="text-foreground font-mono">{repo.full_name},</span>{' '}
          add a setup note and open a pull request.
        </p>
      </div>
    </div>
  )
}
