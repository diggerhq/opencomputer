import { useEffect, useRef, useState } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Unplug, ExternalLink, RotateCw } from 'lucide-react'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  ApiError,
  getDeployApp,
  getDeploymentSource,
  linkDeploymentSource,
  unlinkDeploymentSource,
} from '@/api/client'
import type { DeploymentSource } from '@/api/schemas'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/form'
import { GithubMark } from '@/components/github-mark'
import { SourceProfileChangedRecovery } from '@/components/source-profile-changed-recovery'
import type { RepositorySeed } from '@/lib/repository-onboarding'

function repositoryStatus(source: DeploymentSource): string {
  switch (source.status) {
    case 'active':
      return `Pushes to ${source.production_ref} create deployments automatically.`
    case 'auth_required':
      return 'Reconnect GitHub to resume automatic deployments.'
    case 'repo_not_selected':
      return 'Grant this repository to the GitHub App to resume deployments.'
    case 'app_suspended':
      return 'The GitHub App installation is suspended.'
    case 'path_missing':
      return 'The configured root directory is missing.'
    case 'ref_missing':
      return 'The configured production branch is missing.'
    default:
      return 'This repository connection needs attention.'
  }
}

/**
 * A reviewed repository import is profile-pinned. It can be inspected,
 * authorized, or unlinked here, but never switched in place through the
 * legacy free-form picker because a new source must pass repository review.
 */
export function PinnedRepositorySource({
  source,
  configureUrl,
  installUrl,
  pending,
  onUnlink,
}: {
  source: DeploymentSource
  configureUrl?: string | null
  installUrl?: string | null
  pending: boolean
  onUnlink: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const githubUrl = configureUrl ?? installUrl
  const githubLabel = configureUrl ? 'Configure GitHub' : 'Reconnect GitHub'

  return (
    <>
      <Panel id="repository-source" className="overflow-hidden">
        <PanelHeader>
          <div className="min-w-0">
            <PanelTitle>Repository</PanelTitle>
            <PanelDescription className="mt-1 text-xs">
              {repositoryStatus(source)}
            </PanelDescription>
          </div>
          <GithubMark className="text-muted-foreground size-4 shrink-0" />
        </PanelHeader>
        <PanelContent className="space-y-4">
          <dl className="space-y-3 text-xs">
            <div className="space-y-1">
              <dt className="text-muted-foreground">Repository</dt>
              <dd className="font-mono text-sm break-all">
                {source.full_name ?? source.repo_id}
              </dd>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0 space-y-1">
                <dt className="text-muted-foreground">Production branch</dt>
                <dd className="truncate font-mono">{source.production_ref}</dd>
              </div>
              <div className="min-w-0 space-y-1">
                <dt className="text-muted-foreground">Root directory</dt>
                <dd className="truncate font-mono">
                  {source.path || 'Repository root'}
                </dd>
              </div>
            </div>
          </dl>

          <div className="flex flex-wrap gap-2">
            {githubUrl ? (
              <Button size="sm" variant="outline" asChild>
                <a href={githubUrl} target="_blank" rel="noreferrer">
                  {githubLabel}
                  <ExternalLink className="size-3.5" />
                </a>
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() => setConfirming(true)}
            >
              <Unplug className="size-4" />
              Unlink repository
            </Button>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Unlinking stops deploy-on-push. It does not delete this agent, its
            active revision, or its sessions.
          </p>
        </PanelContent>
      </Panel>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Unlink this repository?"
        description={`Push-to-deploy from ${source.full_name ?? 'this repository'} will stop. The existing agent, active revision, and sessions will remain available. You can then import this repository into another agent.`}
        confirmLabel="Unlink repository"
        destructive
        pending={pending}
        onConfirm={onUnlink}
      />
    </>
  )
}

// A connect / redeploy kicks off a GitHub deploy that runs ASYNC — the new revision (prompt +
// skills) isn't live until it activates. Poll the source until the deploy lands
// (active_deployed_sha caught up to latest_seen_sha), keeping the card in step, then refresh the
// dependent views so the Overview + Skills update without a manual page reload. Bounded (~60s).
async function pollDeployUntilActive(
  agentId: string,
  queryClient: QueryClient,
) {
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 2500))
    try {
      const src = (await getDeploymentSource(agentId)).source
      queryClient.setQueryData(['agent-deploy-source', agentId], src)
      if (
        src?.active_deployed_sha &&
        src.active_deployed_sha === src.latest_seen_sha
      ) {
        void queryClient.invalidateQueries({ queryKey: ['agent', agentId] })
        void queryClient.invalidateQueries({
          queryKey: ['agent-skills', agentId],
        })
        void queryClient.invalidateQueries({
          queryKey: ['agent-revisions', agentId],
        })
        return
      }
    } catch {
      return
    }
  }
}

/**
 * Source card (Overview right rail) — minimal. Connect a GitHub repo as the agent's source:
 * not installed → a single Connect (install) button; installed → an editable repo / directory /
 * branch picker (pre-filled when already linked) + a quiet Disconnect + an "Add more repos" link.
 * Pushes to the branch create new revisions; re-applying the picker (Update) pulls HEAD into one.
 * No card title, no nested borders — just the lightweight controls that matter.
 */
export function AgentDeploySource({
  agentId,
  autoFocusPicker = false,
  profilePinned = false,
}: {
  agentId: string
  autoFocusPicker?: boolean
  /** Reviewed imports can be managed or unlinked, but not switched in place. */
  profilePinned?: boolean
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const pickerRef = useRef<HTMLDivElement>(null)
  const [repo, setRepo] = useState('')
  const [path, setPath] = useState('')
  const [branch, setBranch] = useState('main')
  // "You just connected" is a transient onboarding moment — only true when the App flips to
  // installed *within this session* (i.e. the user returned from the install tab). NOT set on a
  // fresh load of an already-installed agent, and cleared on Disconnect — so the "pick a repo"
  // nudge never lingers on unlinked/inline-only agents or reappears after an explicit disconnect.
  const [justConnected, setJustConnected] = useState(false)
  const [unlinkedImport, setUnlinkedImport] = useState<RepositorySeed | null>(
    null,
  )

  const { data: app, isLoading: appLoading } = useQuery({
    queryKey: ['deploy-app'],
    queryFn: getDeployApp,
    // The App is installed in another tab; refetch whenever the user returns so the
    // card flips to the repo picker immediately (staleTime would otherwise hide it).
    refetchOnWindowFocus: 'always',
  })
  const {
    data: source,
    isLoading: srcLoading,
    isError: srcError,
    refetch: refetchSource,
  } = useQuery({
    queryKey: ['agent-deploy-source', agentId],
    queryFn: async () => {
      try {
        return (await getDeploymentSource(agentId)).source
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null // not linked
        throw e // a real failure (500/auth/proxy) must not masquerade as "not connected"
      }
    },
    refetchOnWindowFocus: 'always',
  })

  // Detect the false→true install transition: latch "just connected" only if we saw the
  // not-installed state earlier this session (so a fresh load of an already-installed agent
  // doesn't look like a transition).
  const seenNotInstalled = useRef(false)
  useEffect(() => {
    if (!app) return
    if (!app.installed) seenNotInstalled.current = true
    else if (seenNotInstalled.current) setJustConnected(true)
  }, [app])

  // Pre-fill the picker from the current link once, so "connected" is an editable picker.
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (source && !profilePinned && !hydratedRef.current) {
      hydratedRef.current = true
      setRepo(source.full_name ?? '')
      setPath(source.path ?? '')
      setBranch(source.production_ref || 'main')
    }
  }, [profilePinned, source])

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ['agent-deploy-source', agentId],
    })
    void queryClient.invalidateQueries({
      queryKey: ['agent-revisions', agentId],
    })
    void queryClient.invalidateQueries({ queryKey: ['agent-skills', agentId] })
    void queryClient.invalidateQueries({ queryKey: ['agent', agentId] })
  }

  const link = useMutation({
    mutationFn: () =>
      linkDeploymentSource(agentId, {
        repo,
        path: path.trim(),
        production_ref: branch.trim() || 'main',
      }),
    onSuccess: (r) => {
      invalidate()
      if (r.deploy_error) {
        notifyError(
          `Connected, but the first revision couldn't be created (${r.deploy_error.message}).`,
          new Error(r.deploy_error.type),
        )
      } else {
        notifySuccess(
          source
            ? 'Redeploying — pulling the latest commit into a new revision.'
            : 'Connected — creating the first revision.',
        )
        // The GitHub deploy runs async — refresh the prompt + skills once it activates.
        void pollDeployUntilActive(agentId, queryClient)
      }
    },
    onError: (e) => notifyError("Couldn't connect the repo.", e),
  })
  const unlink = useMutation({
    mutationFn: (options?: { prepareReimport?: boolean }) => {
      void options
      return unlinkDeploymentSource(agentId)
    },
    onSuccess: (_result, options) => {
      if (options?.prepareReimport && source) {
        setUnlinkedImport({
          repo: source.repo_id,
          path: source.path,
          productionRef: source.production_ref,
        })
      }
      invalidate()
      hydratedRef.current = false
      setJustConnected(false) // an explicit disconnect is not an onboarding moment
      setRepo('')
      setPath('')
      setBranch('main')
      notifySuccess('Repository unlinked. Existing revisions are unchanged.')
    },
    onError: (e) => notifyError("Couldn't unlink the repository.", e),
  })

  const pickRepo = (fullName: string) => {
    setRepo(fullName)
    const r = app?.repositories.find((x) => x.full_name === fullName)
    if (r?.default_branch) setBranch(r.default_branch)
  }

  // Arrived via a setup CTA (?connect=github) → scroll the picker in + focus it (once).
  const focusedRef = useRef(false)
  useEffect(() => {
    if (
      autoFocusPicker &&
      !focusedRef.current &&
      app?.installed &&
      pickerRef.current
    ) {
      focusedRef.current = true
      pickerRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
      pickerRef.current
        .querySelector<HTMLElement>('button, [role="combobox"], input, select')
        ?.focus()
    }
  }, [autoFocusPicker, app?.installed])

  // Repo options — include the linked repo even if it's not in the installable list.
  const repoOptions = (app?.repositories ?? []).map((r) => ({
    value: r.full_name,
    label: r.full_name,
  }))
  if (
    source?.full_name &&
    !repoOptions.some((o) => o.value === source.full_name)
  ) {
    repoOptions.unshift({ value: source.full_name, label: source.full_name })
  }

  if (profilePinned && !unlinkedImport && !srcLoading && !srcError && !source) {
    return null
  }

  if (
    profilePinned &&
    !unlinkedImport &&
    !srcLoading &&
    !srcError &&
    source &&
    source.status !== 'source_profile_changed'
  ) {
    return (
      <PinnedRepositorySource
        source={source}
        configureUrl={app?.configure_url}
        installUrl={app?.install_url}
        pending={unlink.isPending}
        onUnlink={() => unlink.mutate({ prepareReimport: true })}
      />
    )
  }

  return (
    <Panel className="overflow-hidden">
      <PanelContent className="space-y-3">
        {unlinkedImport ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">Repository unlinked</p>
            <p className="text-muted-foreground text-xs">
              Push-to-deploy stopped. The existing agent, active revision, and
              sessions are unchanged.
            </p>
            <Button
              size="sm"
              onClick={() =>
                void navigate('/agents/new', {
                  state: { repositoryImport: unlinkedImport },
                })
              }
            >
              Import repository as new agent
            </Button>
          </div>
        ) : srcLoading || (!profilePinned && appLoading) ? (
          <p className="text-muted-foreground text-xs">Loading…</p>
        ) : srcError ? (
          <div className="space-y-2">
            <p className="text-xs text-red-600 dark:text-red-500">
              Couldn’t load the repo connection.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refetchSource()}
            >
              Retry
            </Button>
          </div>
        ) : source?.status === 'source_profile_changed' ? (
          <SourceProfileChangedRecovery
            source={source}
            pending={unlink.isPending}
            onUnlink={() => unlink.mutate({ prepareReimport: true })}
          />
        ) : !app?.installed ? (
          <div className="space-y-3">
            <Button
              size="sm"
              variant="outline"
              disabled={!app?.install_url}
              asChild
            >
              <a
                href={app?.install_url ?? '#'}
                target="_blank"
                rel="noreferrer"
              >
                <GithubMark className="size-4" />
                Connect repository
              </a>
            </Button>
            <p className="text-muted-foreground text-xs">
              Or use the CLI: <code className="font-mono">oc agent deploy</code>
            </p>
          </div>
        ) : (
          <div className="space-y-3" ref={pickerRef}>
            {justConnected && !source ? (
              <p className="text-xs">
                <span className="font-medium text-green-600 dark:text-green-500">
                  GitHub connected.
                </span>{' '}
                <span className="text-muted-foreground">
                  Last step — pick a repo to deploy from.
                </span>
              </p>
            ) : null}
            <Select
              value={repo}
              onValueChange={pickRepo}
              placeholder={
                repoOptions.length ? 'Select a repo' : 'No repos available'
              }
              disabled={repoOptions.length === 0}
              options={repoOptions}
            />
            <div className="flex gap-2">
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="directory"
              />
              <Input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                className="max-w-28"
              />
            </div>
            <div className="flex items-center gap-2">
              {source ? (
                <Button
                  size="sm"
                  variant="outline"
                  title="Redeploy — pull the latest commit into a new revision"
                  disabled={link.isPending || !repo}
                  onClick={() => link.mutate()}
                >
                  <RotateCw
                    className={`size-4 ${link.isPending ? 'animate-spin' : ''}`}
                  />
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={link.isPending || !repo}
                  onClick={() => link.mutate()}
                >
                  {link.isPending ? 'Deploying…' : 'Deploy'}
                </Button>
              )}
              {source ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground"
                  disabled={unlink.isPending}
                  onClick={() => unlink.mutate({ prepareReimport: false })}
                >
                  <Unplug className="size-4" />
                  Disconnect
                </Button>
              ) : null}
            </div>
            {app.configure_url ? (
              <a
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
                href={app.configure_url}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="size-3" />
                Add more repos
              </a>
            ) : null}
            <p className="text-muted-foreground text-xs">
              Or use the CLI: <code className="font-mono">oc agent deploy</code>
            </p>
          </div>
        )}
      </PanelContent>
    </Panel>
  )
}
