import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ExternalLink,
  Loader2,
  Lock,
  RefreshCw,
  Search,
} from 'lucide-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Input, Select } from '@/components/form'
import { GithubMark } from '@/components/github-mark'
import { Button } from '@/components/ui/button'
import { notifyError, notifySuccess } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { addManagedGitHubConnection } from '../api'
import { launchAuthorizationWindow } from '../authorization-window'
import { relativeTime } from '../computer-state'
import {
  putRepository,
  useOrg,
  workKeys,
  type GrantedRepository,
  type GrantingInstallation,
  type Repository,
} from './api'
import { repositoryName } from './board'
import { useGrantingInstallations } from './queries'

// Which repository holds the organization's working docs (tech design 3.1):
// one per organization, chosen from what its GitHub connection can reach.
// The first choice can be made on the board itself (`FirstRepository`); the
// setting with its state and fixes is KnowledgeRepositorySection.

/** The board's empty state: choose the repository, and the board loads. */
export function FirstRepository() {
  return (
    <section aria-labelledby="work-repository-title">
      <h2 id="work-repository-title" className="mb-3 text-sm font-semibold">
        Knowledge repository
      </h2>
      <div className="bg-panel rounded-lg border px-5 py-3 text-sm">
        <RepositoryPicker current={null} />
      </div>
    </section>
  )
}

/**
 * Starts the managed GitHub App install in a new window, as Connections and
 * the Computer page do. Coming back, the picker and the repository are read
 * again on focus.
 */
export function ConnectGitHubButton({
  label = 'Connect GitHub',
  variant = 'outline',
}: {
  label?: string
  variant?: 'default' | 'outline'
}) {
  const [starting, setStarting] = useState(false)
  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      disabled={starting}
      onClick={() => {
        setStarting(true)
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
        <Loader2 className="animate-spin" aria-hidden />
      ) : (
        <GithubMark className="size-3.5" />
      )}
      {label}
    </Button>
  )
}

// About six rows show; the rest scroll.
const LIST_HEIGHT = 'max-h-[16.5rem]'

/**
 * The repositories the organization's GitHub installations grant, most
 * recently pushed first, filtered as you type. Selecting one saves it on its
 * default branch. The list is read again when the window regains focus, so
 * coming back from granting access on GitHub shows the new repository.
 */
export function RepositoryPicker({
  current,
  onDone,
  onCancel,
}: {
  current: Repository | null
  onDone?: () => void
  onCancel?: () => void
}) {
  const qc = useQueryClient()
  const org = useOrg()
  const list = useGrantingInstallations()
  // A switch away from a set repository waits for a confirmation.
  const [pending, setPending] = useState<Choice | null>(null)
  const installations = list.data ?? []
  const [chosen, setChosen] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const want = chosen ?? (current ? String(current.installationId) : '')
  const installation =
    installations.find((i) => i.id === want) ?? installations[0]

  const save = useMutation({
    mutationFn: ({ installationId, repository: r }: Choice) =>
      putRepository({
        installationId,
        owner: r.owner,
        name: r.name,
        branch: r.defaultBranch,
      }),
    onSuccess: (repository) => {
      qc.setQueryData(workKeys.repository(org), repository)
      void qc.invalidateQueries({ queryKey: ['work', org] })
      notifySuccess('Knowledge repository saved.')
      setPending(null)
      onDone?.()
    },
    onError: (e) => notifyError('Could not save the repository', e),
  })

  if (list.isSuccess && installations.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground">
          Connect GitHub first: working docs live in one of its repositories.
        </p>
        <ConnectGitHubButton />
      </div>
    )
  }

  const isCurrent = (r: GrantedRepository) =>
    !!current &&
    !!installation &&
    String(current.installationId) === installation.id &&
    current.owner.toLowerCase() === r.owner.toLowerCase() &&
    current.name.toLowerCase() === r.name.toLowerCase()
  const needle = q.trim().toLowerCase()
  const shown = (installation?.repositories ?? []).filter((r) =>
    r.name.toLowerCase().includes(needle),
  )

  return (
    <div className="space-y-3 py-1">
      <p className="text-muted-foreground">
        Pick the repository where agents keep working docs for tracked items.
        Everyone in the organization can read them.
      </p>
      <div className="flex gap-2">
        {installations.length > 1 ? (
          <div className="w-44 shrink-0">
            <Select
              id="work-repo-account"
              value={installation?.id ?? ''}
              onValueChange={(v) => {
                setChosen(v)
                setQ('')
              }}
              options={installations.map((i) => ({
                value: i.id,
                label: i.accountLogin,
              }))}
            />
          </div>
        ) : null}
        <div className="relative min-w-0 flex-1">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
            aria-hidden
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQ('')}
            placeholder="Search repositories"
            aria-label="Search repositories"
            autoComplete="off"
            className="pl-8"
          />
        </div>
        <Button
          type="button"
          size="icon"
          variant="outline"
          onClick={() => void list.refetch()}
          disabled={list.isFetching}
          aria-label="Refresh the list"
          title="Refresh the list"
        >
          <RefreshCw
            className={cn('size-3.5', list.isFetching && 'animate-spin')}
          />
        </Button>
      </div>
      <div className={cn('overflow-y-auto rounded-md border', LIST_HEIGHT)}>
        {list.isPending ? (
          <p
            role="status"
            className="text-muted-foreground flex items-center justify-center gap-2 px-3 py-10"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading repositories from GitHub…
          </p>
        ) : !installation ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
            <p className="text-muted-foreground">
              Could not load the repositories from GitHub.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void list.refetch()}
              disabled={list.isFetching}
            >
              Try again
            </Button>
          </div>
        ) : installation.problem ? (
          <p className="text-status-error px-3 py-8 text-center">
            {installation.problemMessage ??
              `GitHub would not list the repositories of ${installation.accountLogin}.`}
          </p>
        ) : installation.repositories.length === 0 ? (
          <p className="text-muted-foreground px-3 py-8 text-center">
            The GitHub App cannot reach any repository of{' '}
            {installation.accountLogin} yet. Grant it one, then come back.
          </p>
        ) : shown.length === 0 ? (
          <p className="text-muted-foreground px-3 py-8 text-center">
            No repository matches &ldquo;{q.trim()}&rdquo;.
          </p>
        ) : (
          <ul className="divide-y" aria-label="Repositories">
            {shown.map((r) => (
              <RepositoryRow
                key={r.id}
                repository={r}
                selected={isCurrent(r)}
                saving={save.isPending && save.variables.repository.id === r.id}
                disabled={save.isPending}
                onSelect={() => {
                  const choice = {
                    installationId: installation.id,
                    repository: r,
                  }
                  if (current) setPending(choice)
                  else save.mutate(choice)
                }}
              />
            ))}
            {installation.truncated ? (
              <li className="text-muted-foreground px-3 py-2 text-xs">
                Only the first {installation.repositories.length} repositories
                are listed.
              </li>
            ) : null}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {installation ? (
          <MissingRepository installation={installation} />
        ) : (
          <span />
        )}
        {onCancel ? (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
      {current ? (
        <ConfirmDialog
          open={pending !== null}
          onOpenChange={(open) => !open && setPending(null)}
          title={`Switch the board to ${pending ? `${pending.repository.owner}/${pending.repository.name}` : ''}?`}
          description={
            <>
              The board is rebuilt from{' '}
              {pending
                ? `${pending.repository.owner}/${pending.repository.name}`
                : ''}{' '}
              on its {pending?.repository.defaultBranch} branch, and the items
              in {repositoryName(current)} stop showing here. Nothing is deleted
              or changed in either repository, and you can switch back.
            </>
          }
          confirmLabel="Switch"
          pending={save.isPending}
          onConfirm={() => pending && save.mutate(pending)}
        />
      ) : null}
    </div>
  )
}

type Choice = { installationId: string; repository: GrantedRepository }

function RepositoryRow({
  repository: r,
  selected,
  saving,
  disabled,
  onSelect,
}: {
  repository: GrantedRepository
  selected: boolean
  saving: boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate font-medium">{r.name}</span>
        {r.private ? (
          <Lock
            className="text-muted-foreground size-3 shrink-0"
            aria-label="Private"
          />
        ) : null}
      </span>
      {r.pushedAt ? (
        <span
          className="text-muted-foreground shrink-0 text-xs tabular-nums"
          title={new Date(r.pushedAt).toLocaleString()}
        >
          {relativeTime(r.pushedAt)}
        </span>
      ) : null}
      {selected ? (
        <span className="text-muted-foreground inline-flex h-7 w-20 shrink-0 items-center justify-center gap-1 text-[0.8rem]">
          <Check className="size-3.5" aria-hidden />
          Selected
        </span>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-20 shrink-0"
          onClick={onSelect}
          disabled={disabled}
          aria-label={`Select ${r.name}`}
        >
          {saving ? <Loader2 className="animate-spin" /> : null}
          Select
        </Button>
      )}
    </li>
  )
}

function MissingRepository({
  installation,
}: {
  installation: GrantingInstallation
}) {
  return (
    <p className="text-muted-foreground text-xs">
      Missing a repository?{' '}
      <a
        href={installation.settingsUrl}
        target="_blank"
        rel="noreferrer"
        className="hover:text-foreground inline-flex items-center gap-0.5 underline underline-offset-4"
      >
        Adjust GitHub App access
        <ExternalLink className="size-3" aria-hidden />
      </a>
    </p>
  )
}
