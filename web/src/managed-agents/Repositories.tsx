import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ExternalLink,
  FolderGit2,
  Loader2,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { ApiError } from '@/api/client'
import { ConfirmDialog } from '@/components/confirm-dialog'
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
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/form'
import { notifyError, notifySuccess } from '@/lib/errors'
import { cn } from '@/lib/utils'
import {
  connectProjectGithub,
  createProjectGithubManifest,
  deleteProjectGithubApp,
  detachProjectGithub,
  getProjectGithub,
  getProjectGithubRepositories,
  putProjectGithubRepositories,
  setProjectGithubAppPrivateKey,
  setProjectGithubAppWebhookSecret,
  type ProjectGithubEnvironment,
  type ProjectGithubRepositories,
  type ProjectGithubSelectedRepository,
  type ProjectGithubStatus,
} from './api'
import {
  defaultProjectGithubScopeMode,
  isNarrowingProjectGithubScope,
  projectGithubQueryKey,
  projectGithubRepositoriesQueryKey,
  projectGithubScopeCandidates,
  sameProjectGithubScopePolicy,
  selectedProjectGithubRepoIds,
  toggleProjectGithubScopeRepository,
  type ProjectGithubScopePolicy,
} from './github-scope'

type Environment = 'development' | 'production'

const BOTH_ENVIRONMENTS: Environment[] = ['development', 'production']
const NEW_INSTALLATION = '__new__'

function githubErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined
  const code = error.details?.code
  return typeof code === 'string' ? code : error.type
}

/** GitHub's app-manifest flow requires a browser form POST with a single
 * `manifest` field; submit it into a new tab without leaving this page. */
function postManifestToGithub(
  action: string,
  manifest: Record<string, unknown>,
) {
  const form = document.createElement('form')
  form.method = 'post'
  form.action = action
  form.target = '_blank'
  const field = document.createElement('input')
  field.type = 'hidden'
  field.name = 'manifest'
  field.value = JSON.stringify(manifest)
  form.appendChild(field)
  document.body.appendChild(form)
  form.submit()
  form.remove()
}

function GithubWizardSteps({
  current,
  steps,
}: {
  current: number
  steps: string[]
}) {
  return (
    <ol className="flex items-center gap-2 pt-2">
      {steps.map((label, index) => (
        <li key={label} className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
              index <= current
                ? 'bg-foreground text-background'
                : 'bg-secondary text-muted-foreground',
            )}
          >
            {index < current ? <Check className="size-3" /> : index + 1}
          </span>
          <span
            className={cn(
              'truncate text-xs',
              index === current
                ? 'text-foreground font-medium'
                : 'text-muted-foreground',
            )}
          >
            {label}
          </span>
          {index < steps.length - 1 ? (
            <span className="bg-border h-px w-4 shrink-0" />
          ) : null}
        </li>
      ))}
    </ol>
  )
}

/** The tradeoffs of the shared OpenComputer app, stated instead of enforced. */
function SharedAppNotice() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-200">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p>
        The shared OpenComputer app uses one bot identity across every attached
        project, GitHub shows a single grant with no per-project breakdown, and
        a single project's access cannot be revoked from GitHub's side — only
        narrowed here. Create a dedicated app for production.
      </p>
    </div>
  )
}

function GithubWaiting({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-3">
      <Loader2 className="mt-0.5 size-5 animate-spin" aria-hidden />
      <div>
        <p className="text-sm font-medium">Waiting for GitHub…</p>
        <p className="text-muted-foreground text-sm">{message}</p>
      </div>
    </div>
  )
}

function EnvironmentLimitCheckbox({
  environment,
  onlyCurrent,
  onChange,
}: {
  environment: Environment
  onlyCurrent: boolean
  onChange: (onlyCurrent: boolean) => void
}) {
  return (
    <div className="space-y-1">
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <Checkbox
          checked={onlyCurrent}
          onCheckedChange={(next) => onChange(next === true)}
        />
        Only connect the {environment} environment
      </label>
      <p className="text-muted-foreground text-xs">
        By default both development and production are connected. Each
        environment keeps its own attachment and can be switched or disconnected
        independently.
      </p>
    </div>
  )
}

function GithubConnected({ environment }: { environment: Environment }) {
  return (
    <div className="flex items-start gap-3">
      <Check className="mt-0.5 size-5 text-emerald-600" aria-hidden />
      <div>
        <p className="text-sm font-medium">GitHub connected</p>
        <p className="text-muted-foreground text-sm">
          The installation landed for {environment}. Review the repository scope
          to control what agents can reach.
        </p>
      </div>
    </div>
  )
}

function GithubConnectDialog({
  projectId,
  environment,
  status,
  connected,
  onOpenChange,
  onAwaitGithub,
  onCreateDedicated,
}: {
  projectId: string
  environment: Environment
  status: ProjectGithubStatus
  connected: boolean
  onOpenChange: (open: boolean) => void
  onAwaitGithub: () => void
  onCreateDedicated: () => void
}) {
  const queryClient = useQueryClient()
  const installations = status.installations
  const [installationId, setInstallationId] = useState(
    installations[0]?.id ?? NEW_INSTALLATION,
  )
  const [onlyCurrentEnv, setOnlyCurrentEnv] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const chosen = installations.find(
    (installation) => installation.id === installationId,
  )
  const chosenAppMode = chosen ? (chosen.app?.mode ?? 'oc_app') : 'oc_app'
  const sharedPath = chosenAppMode === 'oc_app'
  const newInstallBlocked = !chosen && !status.ocAppAvailable

  const connect = useMutation({
    mutationFn: () =>
      connectProjectGithub({
        projectId,
        environments: onlyCurrentEnv ? [environment] : BOTH_ENVIRONMENTS,
        ...(chosen ? { installationId: chosen.id } : {}),
        scopeMode: defaultProjectGithubScopeMode(chosenAppMode),
      }),
    onSuccess: async (result) => {
      if ('installUrl' in result) {
        window.open(result.installUrl, '_blank', 'noopener')
        setWaiting(true)
        onAwaitGithub()
        return
      }
      await queryClient.invalidateQueries({
        queryKey: projectGithubQueryKey(projectId),
      })
      await queryClient.invalidateQueries({
        queryKey: projectGithubRepositoriesQueryKey(projectId, environment),
      })
      notifySuccess(
        'GitHub connected.',
        'Review the repository scope below to control what agents can reach.',
      )
      onOpenChange(false)
    },
    onError: (error) => notifyError("Couldn't connect GitHub.", error),
  })

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect GitHub</DialogTitle>
          <DialogDescription>
            Agents reach GitHub through short-lived installation tokens scoped
            to this project's repository selection — no personal access tokens.
          </DialogDescription>
        </DialogHeader>
        {waiting ? (
          <div className="space-y-4">
            {connected ? (
              <GithubConnected environment={environment} />
            ) : (
              <GithubWaiting message="Pick the repositories to grant in the GitHub tab. This page updates automatically once the installation lands." />
            )}
            <DialogFooter>
              <Button
                variant={connected ? 'default' : 'outline'}
                onClick={() => onOpenChange(false)}
              >
                {connected ? 'Done' : 'Close'}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            {installations.length ? (
              <Field
                label="Installation"
                htmlFor="github-connect-installation"
                description="Use an installation this account already has, or start a fresh install of the shared OpenComputer app."
              >
                <Select
                  id="github-connect-installation"
                  value={installationId}
                  onValueChange={setInstallationId}
                  options={[
                    ...installations.map((installation) => ({
                      value: installation.id,
                      label: `${installation.accountLogin} · ${installation.app?.name ?? 'GitHub app'}`,
                      hint: installation.accountType,
                    })),
                    ...(status.ocAppAvailable
                      ? [
                          {
                            value: NEW_INSTALLATION,
                            label: 'Install the OpenComputer app…',
                          },
                        ]
                      : []),
                  ]}
                />
              </Field>
            ) : null}
            {newInstallBlocked ? (
              <p className="text-muted-foreground text-sm">
                The shared OpenComputer app is not available here. Create a
                dedicated GitHub app for this project instead.
              </p>
            ) : null}
            {sharedPath && !newInstallBlocked ? <SharedAppNotice /> : null}
            <EnvironmentLimitCheckbox
              environment={environment}
              onlyCurrent={onlyCurrentEnv}
              onChange={setOnlyCurrentEnv}
            />
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              {newInstallBlocked ? (
                <Button onClick={onCreateDedicated}>
                  Create a dedicated app
                </Button>
              ) : (
                <Button
                  disabled={connect.isPending}
                  onClick={() => connect.mutate()}
                >
                  {connect.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <GithubMark className="size-4" />
                  )}
                  {chosen ? 'Attach installation' : 'Continue on GitHub'}
                </Button>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

const WIZARD_STEPS = ['Account', 'Create app', 'Install']

function GithubDedicatedAppWizard({
  projectId,
  environment,
  connected,
  onOpenChange,
  onAwaitGithub,
}: {
  projectId: string
  environment: Environment
  connected: boolean
  onOpenChange: (open: boolean) => void
  onAwaitGithub: () => void
}) {
  const [step, setStep] = useState<'target' | 'create' | 'install'>('target')
  const [organization, setOrganization] = useState('')
  const [onlyCurrentEnv, setOnlyCurrentEnv] = useState(false)

  const manifest = useMutation({
    mutationFn: () =>
      createProjectGithubManifest({
        projectId,
        environments: onlyCurrentEnv ? [environment] : BOTH_ENVIRONMENTS,
        ...(organization.trim() ? { organization: organization.trim() } : {}),
        scopeMode: 'all',
      }),
    onSuccess: () => setStep('create'),
    onError: (error) =>
      notifyError("Couldn't prepare the GitHub app manifest.", error),
  })

  const stepIndex = step === 'target' ? 0 : step === 'create' ? 1 : 2

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create a dedicated GitHub app</DialogTitle>
          <DialogDescription>
            A dedicated app gives this project its own bot identity, its own
            GitHub-side grant, and GitHub-side revocability. No credential is
            ever pasted — GitHub hands the app back to OpenComputer directly.
          </DialogDescription>
          <GithubWizardSteps current={stepIndex} steps={WIZARD_STEPS} />
        </DialogHeader>

        {step === 'target' ? (
          <form
            className="space-y-4"
            onSubmit={(event: FormEvent) => {
              event.preventDefault()
              manifest.mutate()
            }}
          >
            <Field
              label="GitHub organization (optional)"
              htmlFor="github-app-organization"
              description="Leave blank to create the app under your personal GitHub account. Creating an org-owned app requires organization owner rights."
            >
              <Input
                id="github-app-organization"
                value={organization}
                onChange={(event) => setOrganization(event.target.value)}
                placeholder="my-org"
                autoComplete="off"
              />
            </Field>
            <EnvironmentLimitCheckbox
              environment={environment}
              onlyCurrent={onlyCurrentEnv}
              onChange={setOnlyCurrentEnv}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={manifest.isPending}>
                {manifest.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : null}
                Next: create app
              </Button>
            </DialogFooter>
          </form>
        ) : step === 'create' ? (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              GitHub will show a pre-filled app manifest. The suggested name
              comes from this project, but GitHub requires a globally unique
              name and lets you edit it — whatever name you land on is accepted
              here. The app stays private to its owner account.
            </p>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setStep('target')}>
                Back
              </Button>
              <Button
                disabled={!manifest.data}
                onClick={() => {
                  if (!manifest.data) return
                  postManifestToGithub(
                    manifest.data.action,
                    manifest.data.manifest,
                  )
                  onAwaitGithub()
                  setStep('install')
                }}
              >
                <ExternalLink /> Create app on GitHub
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            {connected ? (
              <GithubConnected environment={environment} />
            ) : (
              <GithubWaiting message="Finish in the GitHub tab: confirm the app, then install it on the account and pick the repositories to grant. This page updates automatically once the installation lands." />
            )}
            <DialogFooter>
              <Button
                variant={connected ? 'default' : 'outline'}
                onClick={() => onOpenChange(false)}
              >
                {connected ? 'Done' : 'Close'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function DormantRepositoryLabel({
  repository,
  unknownGrant,
}: {
  repository: { granted: boolean; repoId: number }
  unknownGrant: Set<number>
}) {
  if (unknownGrant.has(repository.repoId)) {
    return (
      <span className="text-muted-foreground block text-xs">
        Beyond the enumerated repositories — selection kept.
      </span>
    )
  }
  if (!repository.granted) {
    return (
      <span className="block text-xs text-amber-700 dark:text-amber-400">
        No longer granted on GitHub — kept, so access resumes if it is granted
        again.
      </span>
    )
  }
  return null
}

function GithubScopeEditor({
  projectId,
  environment,
}: {
  projectId: string
  environment: Environment
}) {
  const queryClient = useQueryClient()
  const queryKey = projectGithubRepositoriesQueryKey(projectId, environment)
  const repositories = useQuery({
    queryKey,
    queryFn: () => getProjectGithubRepositories(projectId, environment),
  })
  const [draft, setDraft] = useState<ProjectGithubScopePolicy>()
  const save = useMutation({
    mutationFn: (policy: ProjectGithubScopePolicy) =>
      putProjectGithubRepositories({
        projectId,
        environment,
        mode: policy.mode,
        ...(policy.mode === 'selected'
          ? { repositories: policy.repositories }
          : {}),
      }),
    onSuccess: async () => {
      setDraft(undefined)
      await queryClient.invalidateQueries({ queryKey })
      await queryClient.invalidateQueries({
        queryKey: projectGithubQueryKey(projectId),
      })
      notifySuccess(
        'Repository access updated.',
        'The next minted token uses this scope.',
      )
    },
    onError: (error) => {
      if (githubErrorCode(error) === 'repository_not_granted') {
        notifyError(
          'A selected repository is no longer granted to the installation.',
          error,
        )
        return
      }
      notifyError("Couldn't update repository access.", error)
    },
  })

  const renderRetainedSelection = (
    selected: ProjectGithubSelectedRepository[],
  ) =>
    selected.length ? (
      <div className="divide-y rounded-md border">
        {selected.map((repository) => (
          <div
            key={repository.repoId}
            className="flex min-w-0 items-center gap-3 px-3 py-2.5"
          >
            <GithubMark className="text-muted-foreground size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">
              {repository.fullName}
            </span>
            {!repository.granted ? (
              <span className="shrink-0 text-xs text-amber-700 dark:text-amber-400">
                No longer granted
              </span>
            ) : null}
          </div>
        ))}
      </div>
    ) : null

  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>Repository access</PanelTitle>
          <PanelDescription className="mt-1 max-w-3xl">
            What agents in {environment} can reach through githubApp()
            connections. Scope changes apply to the next minted token;
            already-issued tokens can stay valid for up to an hour.
          </PanelDescription>
        </div>
        <span className="bg-muted rounded-md px-2 py-1 text-xs capitalize">
          {environment}
        </span>
      </PanelHeader>
      {repositories.isLoading ? (
        <PanelContent className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Enumerating granted
          repositories…
        </PanelContent>
      ) : repositories.isError || repositories.data?.state === 'unavailable' ? (
        <PanelContent className="space-y-4">
          <div className="flex items-start gap-3">
            <TriangleAlert
              className="mt-0.5 size-5 text-amber-600"
              aria-hidden
            />
            <div>
              <p className="text-sm font-medium">
                GitHub can't be reached right now
              </p>
              <p className="text-muted-foreground text-sm">
                This is a temporary GitHub failure. The connection and the saved
                scope below are unchanged — nothing needs to be reconnected.
              </p>
            </div>
          </div>
          {repositories.data?.state === 'unavailable'
            ? renderRetainedSelection(repositories.data.selected)
            : null}
          <Button
            variant="outline"
            disabled={repositories.isFetching}
            onClick={() => void repositories.refetch()}
          >
            <RefreshCw
              className={cn(repositories.isFetching && 'animate-spin')}
            />
            Retry
          </Button>
        </PanelContent>
      ) : repositories.data?.state === 'connected' ? (
        <GithubScopeForm
          data={repositories.data}
          draft={draft}
          setDraft={setDraft}
          pending={save.isPending}
          onSave={(policy) => save.mutate(policy)}
        />
      ) : (
        <PanelContent className="text-muted-foreground text-sm">
          GitHub is not connected for {environment}.
        </PanelContent>
      )}
    </Panel>
  )
}

function GithubScopeForm({
  data,
  draft,
  setDraft,
  pending,
  onSave,
}: {
  data: Extract<ProjectGithubRepositories, { state: 'connected' }>
  draft: ProjectGithubScopePolicy | undefined
  setDraft: (policy: ProjectGithubScopePolicy | undefined) => void
  pending: boolean
  onSave: (policy: ProjectGithubScopePolicy) => void
}) {
  const serverPolicy: ProjectGithubScopePolicy =
    data.scopeMode === 'all'
      ? { mode: 'all' }
      : {
          mode: 'selected',
          repositories: data.selected.map(({ repoId, fullName }) => ({
            repoId,
            fullName,
          })),
        }
  const policy = draft ?? serverPolicy
  const candidates = projectGithubScopeCandidates(data.grant, data.selected)
  const selectedIds = new Set(selectedProjectGithubRepoIds(policy))
  const unknownGrant = new Set(data.unavailableSelected)
  const dirty = !sameProjectGithubScopePolicy(policy, serverPolicy)
  const narrowing = isNarrowingProjectGithubScope(serverPolicy, policy)

  return (
    <PanelContent className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setDraft({ mode: 'all' })}
          className={cn(
            'rounded-md border p-3 text-left transition-colors',
            policy.mode === 'all'
              ? 'border-foreground'
              : 'hover:border-muted-foreground/40',
          )}
        >
          <p className="text-sm font-medium">All repositories</p>
          <p className="text-muted-foreground mt-1 text-xs leading-5">
            Everything the installation is granted, including repositories added
            on GitHub later. Tokens are install-wide — the boundary is the
            GitHub grant itself, and OpenComputer adds nothing beyond it.
          </p>
        </button>
        <button
          type="button"
          // Stored selections survive an `all` interlude — switching back
          // restores them instead of starting empty.
          onClick={() =>
            setDraft({
              mode: 'selected',
              repositories: data.selected.map(({ repoId, fullName }) => ({
                repoId,
                fullName,
              })),
            })
          }
          className={cn(
            'rounded-md border p-3 text-left transition-colors',
            policy.mode === 'selected'
              ? 'border-foreground'
              : 'hover:border-muted-foreground/40',
          )}
        >
          <p className="text-sm font-medium">Selected repositories</p>
          <p className="text-muted-foreground mt-1 text-xs leading-5">
            Every minted token carries exactly these repository ids, so GitHub
            itself enforces the boundary on each call — renames included.
          </p>
        </button>
      </div>

      {policy.mode === 'selected' ? (
        <div className="space-y-2">
          {data.truncated ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Showing the first 500 repositories from GitHub. Repositories
              beyond this limit are not listed, and selections among them are
              kept — never treated as revoked.
            </p>
          ) : null}
          <div className="max-h-72 overflow-y-auto rounded-md border">
            {candidates.length ? (
              candidates.map((repository) => (
                <label
                  key={repository.repoId}
                  className="hover:bg-muted/40 flex min-w-0 cursor-pointer items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
                >
                  <Checkbox
                    checked={selectedIds.has(repository.repoId)}
                    onCheckedChange={(next) =>
                      setDraft(
                        toggleProjectGithubScopeRepository(
                          policy,
                          {
                            repoId: repository.repoId,
                            fullName: repository.fullName,
                          },
                          next === true,
                        ),
                      )
                    }
                  />
                  <GithubMark className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate font-mono text-xs"
                      title={repository.fullName}
                    >
                      {repository.fullName}
                    </span>
                    <DormantRepositoryLabel
                      repository={repository}
                      unknownGrant={unknownGrant}
                    />
                  </span>
                  {repository.private ? (
                    <span className="text-muted-foreground shrink-0 text-[10px] font-medium uppercase">
                      Private
                    </span>
                  ) : null}
                </label>
              ))
            ) : (
              <p className="text-muted-foreground px-3 py-4 text-sm">
                The installation has no granted repositories yet. Grant some on
                GitHub, then retry.
              </p>
            )}
          </div>
          {selectedIds.size === 0 ? (
            <p className="text-muted-foreground text-xs">
              No repositories selected — GitHub access is off for this
              environment while everything else keeps working.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!dirty || pending} onClick={() => onSave(policy)}>
          {pending ? <Loader2 className="animate-spin" /> : null}
          Save scope
        </Button>
        {dirty ? (
          <Button variant="ghost" onClick={() => setDraft(undefined)}>
            Reset
          </Button>
        ) : null}
        {dirty && narrowing ? (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Narrowing applies to the next minted token; tokens already issued
            can stay valid for up to an hour.
          </p>
        ) : null}
      </div>
    </PanelContent>
  )
}

function GithubConnectionCard({
  projectId,
  environment,
  envState,
  status,
  onSwitch,
  onCreateDedicated,
}: {
  projectId: string
  environment: Environment
  envState: ProjectGithubEnvironment
  status: ProjectGithubStatus
  onSwitch: () => void
  onCreateDedicated: () => void
}) {
  const queryClient = useQueryClient()
  const app = envState.app
  const installation = envState.installation
  const fullApp = status.apps.find((candidate) => candidate.id === app?.id)
  const htmlUrl = fullApp?.htmlUrl
  const dedicated = app?.mode === 'dedicated'
  const [confirmDetach, setConfirmDetach] = useState(false)
  const [confirmDeleteApp, setConfirmDeleteApp] = useState(false)
  const [secretOpen, setSecretOpen] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)
  const [webhookSecret, setWebhookSecret] = useState('')
  const [privateKey, setPrivateKey] = useState('')

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: projectGithubQueryKey(projectId),
    })
    await queryClient.invalidateQueries({
      queryKey: projectGithubRepositoriesQueryKey(projectId, environment),
    })
  }
  const detach = useMutation({
    mutationFn: () => detachProjectGithub(projectId, environment),
    onSuccess: async () => {
      setConfirmDetach(false)
      notifySuccess(
        `GitHub disconnected from ${environment}.`,
        'Other environments and the GitHub installation are unaffected.',
      )
      await invalidate()
    },
    onError: (error) => notifyError("Couldn't disconnect GitHub.", error),
  })
  const removeApp = useMutation({
    mutationFn: () => deleteProjectGithubApp(projectId, app!.id),
    onSuccess: async () => {
      setConfirmDeleteApp(false)
      notifySuccess('GitHub app removed.')
      await invalidate()
    },
    onError: (error) => notifyError("Couldn't remove the GitHub app.", error),
  })
  const saveWebhookSecret = useMutation({
    mutationFn: () =>
      setProjectGithubAppWebhookSecret(projectId, app!.id, webhookSecret),
    onSuccess: async () => {
      setSecretOpen(false)
      setWebhookSecret('')
      notifySuccess(
        'Webhook secret saved.',
        'Deliveries verify against the new secret from now on.',
      )
      await invalidate()
    },
    onError: (error) => notifyError("Couldn't save the webhook secret.", error),
  })
  const savePrivateKey = useMutation({
    mutationFn: () =>
      setProjectGithubAppPrivateKey(projectId, app!.id, privateKey),
    onSuccess: async () => {
      setKeyOpen(false)
      setPrivateKey('')
      notifySuccess(
        'Private key saved.',
        'App authentication uses the new key from now on.',
      )
      await invalidate()
    },
    onError: (error) => notifyError("Couldn't save the private key.", error),
  })

  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>GitHub connection</PanelTitle>
          <PanelDescription className="mt-1">
            The app and installation this environment mints repository-scoped
            tokens against.
          </PanelDescription>
        </div>
        <span className="bg-muted rounded-md px-2 py-1 text-xs capitalize">
          {environment}
        </span>
      </PanelHeader>
      <PanelContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-md">
              <GithubMark className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {app?.name ?? 'GitHub app'}
              </p>
              <p className="text-muted-foreground truncate text-xs">
                {app?.mode === 'oc_app'
                  ? 'Shared OpenComputer app'
                  : 'Dedicated app'}
                {app ? ` · @${app.slug}` : ''}
                {installation
                  ? ` · installed on ${installation.accountLogin} (${installation.accountType})`
                  : ''}
              </p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {envState.scopeMode === 'all'
                  ? 'Scope: all granted repositories (install-wide tokens)'
                  : `Scope: ${envState.selectedRepositoryCount ?? 0} selected ${
                      (envState.selectedRepositoryCount ?? 0) === 1
                        ? 'repository'
                        : 'repositories'
                    }`}
              </p>
            </div>
          </div>
          {envState.state === 'connected' ? (
            <StatusBadge status="connected" />
          ) : envState.state === 'auth_required' ? (
            <StatusBadge status="auth_required" />
          ) : envState.state === 'app_suspended' ? (
            <StatusBadge status="error" label="Suspended" />
          ) : (
            <StatusBadge status="error" label="App deleted" />
          )}
        </div>

        {envState.state === 'auth_required' ? (
          <div className="flex items-start gap-2 rounded-md border px-3 py-2.5 text-xs leading-5">
            <TriangleAlert
              className="text-destructive mt-0.5 size-3.5 shrink-0"
              aria-hidden
            />
            <p>
              GitHub authorization needs attention: the app's private key is
              invalid, or newly requested permissions have not been accepted on
              GitHub yet. Review the app on GitHub
              {dedicated ? ' or re-enter its private key below' : ''}; access
              resumes automatically once GitHub accepts.
            </p>
          </div>
        ) : envState.state === 'app_suspended' ? (
          <div className="flex items-start gap-2 rounded-md border px-3 py-2.5 text-xs leading-5">
            <TriangleAlert
              className="text-destructive mt-0.5 size-3.5 shrink-0"
              aria-hidden
            />
            <p>
              This installation is suspended on GitHub, so no tokens can be
              minted. Unsuspend it in the GitHub account's installed-apps
              settings — nothing needs to change here, and access resumes
              automatically.
            </p>
          </div>
        ) : envState.state === 'app_deleted' ? (
          <div className="flex items-start gap-2 rounded-md border px-3 py-2.5 text-xs leading-5">
            <TriangleAlert
              className="text-destructive mt-0.5 size-3.5 shrink-0"
              aria-hidden
            />
            <p>
              This dedicated app was deleted on GitHub, so its stored key can no
              longer authenticate — this is different from uninstalling. Remove
              the app here, then create a new dedicated app.
            </p>
          </div>
        ) : null}

        {app?.mode === 'oc_app' ? <SharedAppNotice /> : null}

        <div className="flex flex-wrap items-center gap-2">
          {htmlUrl ? (
            <Button asChild variant="outline" size="sm">
              <a href={htmlUrl} target="_blank" rel="noreferrer">
                Configure on GitHub <ExternalLink />
              </a>
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={onSwitch}>
            Switch installation
          </Button>
          {envState.state === 'app_deleted' ? (
            <Button variant="outline" size="sm" onClick={onCreateDedicated}>
              Create a dedicated app
            </Button>
          ) : null}
          {dedicated ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSecretOpen(true)}
              >
                Re-enter webhook secret
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setKeyOpen(true)}
              >
                Re-enter private key
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDeleteApp(true)}
              >
                <Trash2 /> Delete app
              </Button>
            </>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDetach(true)}
          >
            Disconnect
          </Button>
        </div>
      </PanelContent>

      <Dialog open={secretOpen} onOpenChange={setSecretOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-enter webhook secret</DialogTitle>
            <DialogDescription>
              GitHub offers no API to read or rotate a webhook secret. If you
              changed it on GitHub, paste the new value so event deliveries
              verify again.
            </DialogDescription>
          </DialogHeader>
          <Field label="Webhook secret" htmlFor="github-webhook-secret">
            <Input
              id="github-webhook-secret"
              type="password"
              value={webhookSecret}
              onChange={(event) => setWebhookSecret(event.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSecretOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!webhookSecret.trim() || saveWebhookSecret.isPending}
              onClick={() => saveWebhookSecret.mutate()}
            >
              {saveWebhookSecret.isPending ? (
                <Loader2 className="animate-spin" />
              ) : null}
              Save secret
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={keyOpen} onOpenChange={setKeyOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Re-enter private key</DialogTitle>
            <DialogDescription>
              Generate a new private key in the app's GitHub settings, then
              paste the PEM here. The key is stored encrypted and never shown
              again.
            </DialogDescription>
          </DialogHeader>
          <Field label="Private key (PEM)" htmlFor="github-private-key">
            <Textarea
              id="github-private-key"
              value={privateKey}
              onChange={(event) => setPrivateKey(event.target.value)}
              placeholder={'-----BEGIN RSA PRIVATE KEY-----'}
              className="min-h-40 font-mono text-xs"
              autoComplete="off"
            />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setKeyOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!privateKey.trim() || savePrivateKey.isPending}
              onClick={() => savePrivateKey.mutate()}
            >
              {savePrivateKey.isPending ? (
                <Loader2 className="animate-spin" />
              ) : null}
              Save key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDetach}
        onOpenChange={setConfirmDetach}
        title={`Disconnect GitHub from ${environment}?`}
        description="Agents in this environment will fail GitHub calls with github_not_connected. Only this environment is detached — the other environment and the GitHub installation keep working."
        confirmLabel="Disconnect"
        destructive
        pending={detach.isPending}
        onConfirm={() => detach.mutate()}
      />

      <ConfirmDialog
        open={confirmDeleteApp}
        onOpenChange={setConfirmDeleteApp}
        title="Delete this GitHub app?"
        description="Its stored private key and webhook secret are removed, its installations are forgotten, and every environment attached through it is disconnected. Agent GitHub calls fail with github_not_connected until a new connection exists. The app itself remains on GitHub until you also delete it there."
        confirmLabel="Delete app"
        destructive
        pending={removeApp.isPending}
        onConfirm={() => removeApp.mutate()}
      />
    </Panel>
  )
}

export function ManagedProjectRepositories({
  projectId,
  environment,
}: {
  projectId: string
  environment: Environment
}) {
  const queryClient = useQueryClient()
  // Snapshot of the environment's attachment when a GitHub tab was opened
  // (undefined = no flow in flight). Success is a *transition* away from it —
  // an already-connected environment starting a fresh install must not read
  // its old attachment as the new one landing.
  const [awaitBaseline, setAwaitBaseline] = useState<string>()
  const [connectOpen, setConnectOpen] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(false)
  const attachmentKey = (data: ProjectGithubStatus | undefined) => {
    const row = data?.environments.find(
      (candidate) => candidate.environment === environment,
    )
    return `${row?.state ?? 'none'}:${row?.installation?.id ?? ''}`
  }
  const flowSettled = (data: ProjectGithubStatus | undefined) => {
    if (awaitBaseline === undefined) return false
    const key = attachmentKey(data)
    return key !== awaitBaseline && key.startsWith('connected:')
  }
  const status = useQuery({
    queryKey: projectGithubQueryKey(projectId),
    queryFn: () => getProjectGithub(projectId),
    // The install/manifest flows finish in a GitHub tab; refresh eagerly when
    // the user comes back, and poll while a flow is in flight.
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) =>
      awaitBaseline !== undefined && !flowSettled(query.state.data)
        ? 3_000
        : false,
  })
  const envState = status.data?.environments.find(
    (candidate) => candidate.environment === environment,
  )
  const beginAwaitGithub = () => setAwaitBaseline(attachmentKey(status.data))
  // Closing either flow (Done, Cancel, or Escape) settles it: stop polling and
  // refresh the grant enumeration so a just-landed installation shows fresh.
  const closeGithubFlows = () => {
    setConnectOpen(false)
    setWizardOpen(false)
    setAwaitBaseline(undefined)
    void queryClient.invalidateQueries({
      queryKey: projectGithubRepositoriesQueryKey(projectId, environment),
    })
  }

  if (status.isLoading) {
    return (
      <Panel>
        <PanelContent className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading GitHub status…
        </PanelContent>
      </Panel>
    )
  }
  if (status.isError || !status.data) {
    return (
      <Panel>
        <PanelContent className="space-y-3">
          <p className="text-muted-foreground text-sm">
            The GitHub status is temporarily unavailable. Any existing
            connection is unchanged.
          </p>
          <Button variant="outline" onClick={() => void status.refetch()}>
            <RefreshCw /> Retry
          </Button>
        </PanelContent>
      </Panel>
    )
  }

  const sharedPathAvailable =
    status.data.ocAppAvailable || status.data.installations.length > 0

  return (
    <div className="space-y-8">
      {!envState || envState.state === 'not_connected' ? (
        <Panel>
          <EmptyState
            icon={FolderGit2}
            title={`GitHub is not connected for ${environment}`}
            description="Install a GitHub App so agents reach repositories through short-lived, repository-scoped tokens minted per call — never a personal access token."
            action={
              <div className="flex flex-col items-center gap-3">
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {sharedPathAvailable ? (
                    <Button onClick={() => setConnectOpen(true)}>
                      <GithubMark className="size-4" /> Connect GitHub
                    </Button>
                  ) : null}
                  <Button
                    variant={sharedPathAvailable ? 'outline' : 'default'}
                    onClick={() => setWizardOpen(true)}
                  >
                    Create a dedicated app
                  </Button>
                </div>
                {!sharedPathAvailable ? (
                  <p className="text-muted-foreground max-w-sm text-xs">
                    The shared OpenComputer app is not available here, so this
                    project needs its own dedicated GitHub app.
                  </p>
                ) : null}
              </div>
            }
          />
        </Panel>
      ) : (
        <>
          <GithubConnectionCard
            projectId={projectId}
            environment={environment}
            envState={envState}
            status={status.data}
            onSwitch={() => setConnectOpen(true)}
            onCreateDedicated={() => setWizardOpen(true)}
          />
          {envState.state === 'connected' ? (
            <GithubScopeEditor
              projectId={projectId}
              environment={environment}
            />
          ) : null}
        </>
      )}

      {connectOpen ? (
        <GithubConnectDialog
          projectId={projectId}
          environment={environment}
          status={status.data}
          connected={flowSettled(status.data)}
          onOpenChange={(open) => {
            if (!open) closeGithubFlows()
          }}
          onAwaitGithub={beginAwaitGithub}
          onCreateDedicated={() => {
            setConnectOpen(false)
            setWizardOpen(true)
          }}
        />
      ) : null}
      {wizardOpen ? (
        <GithubDedicatedAppWizard
          projectId={projectId}
          environment={environment}
          connected={flowSettled(status.data)}
          onOpenChange={(open) => {
            if (!open) closeGithubFlows()
          }}
          onAwaitGithub={beginAwaitGithub}
        />
      ) : null}
    </div>
  )
}
