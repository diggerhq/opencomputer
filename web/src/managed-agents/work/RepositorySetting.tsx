import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronsUpDown,
  ExternalLink,
  Loader2,
  Lock,
  RefreshCw,
  Search,
} from 'lucide-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { GithubMark } from '@/components/github-mark'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
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
import { useGrantingInstallations } from './queries'

// Which repository holds the organization's working docs (tech design 3.1):
// one per organization, chosen from what its GitHub connection can reach.
// One control shows the choice and opens a searchable list of what the
// installations grant, as GitHub's and Vercel's repository pickers do. The
// first-time state uses it; the setting with its
// state and fixes is KnowledgeRepositorySection.

/**
 * Starts the managed GitHub App install in a new window, as Connections and
 * the Computer page do. Coming back, the list and the repository are read
 * again on focus.
 */
export function ConnectGitHubButton({
  label = 'Connect GitHub',
  variant = 'outline',
  size = 'sm',
}: {
  label?: string
  variant?: 'default' | 'outline'
  size?: 'sm' | 'default'
}) {
  const [starting, setStarting] = useState(false)
  return (
    <Button
      type="button"
      size={size}
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

type Choice = { installationId: string; repository: GrantedRepository }

const fullName = (r: { owner: string; name: string }) => `${r.owner}/${r.name}`

const sameRepository = (current: Repository | null, c: Choice) =>
  !!current &&
  String(current.installationId) === c.installationId &&
  current.owner.toLowerCase() === c.repository.owner.toLowerCase() &&
  current.name.toLowerCase() === c.repository.name.toLowerCase()

/**
 * The repository, as one control: the trigger shows the choice, and opens the
 * repositories the organization's GitHub installations grant, most recently
 * pushed first, grouped by account when there are several, filtered as you
 * type. Choosing one saves it on its default branch, after a confirmation
 * when it replaces another. The list is read when first wanted, again on
 * every open and whenever the window regains focus, so coming back from
 * granting access on GitHub shows the new repository.
 *
 * `open`/`onOpenChange` let a fix elsewhere ("Choose another repository")
 * open it.
 */
export function RepositoryCombobox({
  current,
  prominent = false,
  open: openProp,
  onOpenChange,
}: {
  current: Repository | null
  /** Full width and a little taller, for a first choice. */
  prominent?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const org = useOrg()
  const [innerOpen, setInnerOpen] = useState(false)
  const open = openProp ?? innerOpen
  // Read the list once it is wanted: a first choice needs it to know whether
  // GitHub is connected at all; otherwise hovering the trigger is enough.
  const [wanted, setWanted] = useState(!current)
  const list = useGrantingInstallations(wanted || open)
  const [pending, setPending] = useState<Choice | null>(null)

  const setOpen = (next: boolean) => {
    if (next) {
      setWanted(true)
      if (list.isFetched && !list.isFetching) void list.refetch()
    }
    setInnerOpen(next)
    onOpenChange?.(next)
  }

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
    },
    onError: (e) => notifyError('Could not save the repository', e),
  })

  const choose = (c: Choice) => {
    setOpen(false)
    // The same repository again: nothing to do, unless it has a problem
    // (choosing it again saves its default branch, the fix for a lost one).
    if (sameRepository(current, c)) {
      if (current?.problem) save.mutate(c)
      return
    }
    if (current) setPending(c)
    else save.mutate(c)
  }

  if (!current && list.isSuccess && list.data.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          Connect GitHub first: working docs live in one of its repositories.
        </p>
        <ConnectGitHubButton />
      </div>
    )
  }

  // What the trigger shows: the saving choice, else the current one.
  const shown = save.isPending
    ? save.variables.repository
    : (current &&
        list.data
          ?.find((i) => i.id === String(current.installationId))
          ?.repositories.find(
            (r) =>
              r.owner.toLowerCase() === current.owner.toLowerCase() &&
              r.name.toLowerCase() === current.name.toLowerCase(),
          )) ||
      current

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-haspopup="listbox"
            disabled={save.isPending}
            onPointerEnter={() => setWanted(true)}
            onFocus={() => setWanted(true)}
            // Dressed as the Input beside it: same height, border and
            // (transparent) background.
            className={cn(
              'border-input h-8 w-full justify-between gap-2 bg-transparent px-2.5 font-normal hover:bg-transparent aria-expanded:bg-transparent',
              !prominent && 'max-w-80',
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <GithubMark className="text-muted-foreground size-3.5 shrink-0" />
              {shown ? (
                <span className="truncate font-medium">{fullName(shown)}</span>
              ) : (
                <span className="text-muted-foreground">
                  Select a repository
                </span>
              )}
              {shown && 'private' in shown && shown.private ? (
                <Lock
                  className="text-muted-foreground size-3 shrink-0"
                  aria-label="Private"
                />
              ) : null}
            </span>
            {save.isPending ? (
              <Loader2
                className="text-muted-foreground size-3.5 animate-spin"
                aria-label="Saving"
              />
            ) : (
              <ChevronsUpDown
                className="text-muted-foreground size-3.5"
                aria-hidden
              />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-(--radix-popover-trigger-width) rounded-lg border p-0 shadow-md ring-0"
          // The search takes focus, not the first link.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <RepositoryList
            current={current}
            installations={list.data}
            loading={list.isPending}
            failed={list.isError && !list.data}
            fetching={list.isFetching}
            onRefresh={() => void list.refetch()}
            onChoose={choose}
          />
        </PopoverContent>
      </Popover>
      {current ? (
        <ConfirmDialog
          open={pending !== null}
          onOpenChange={(o) => !o && !save.isPending && setPending(null)}
          title={`Switch the board to ${pending ? fullName(pending.repository) : ''}?`}
          description={
            <>
              The board is rebuilt from{' '}
              {pending ? fullName(pending.repository) : ''} on its{' '}
              {pending?.repository.defaultBranch} branch, and the items in{' '}
              {fullName(current)} stop showing here. Nothing is deleted or
              changed in either repository, and you can switch back.
            </>
          }
          confirmLabel="Switch"
          pending={save.isPending}
          onConfirm={() => pending && save.mutate(pending)}
        />
      ) : null}
    </>
  )
}

/** The popover's body: search, the grouped list, and the access footer. */
function RepositoryList({
  current,
  installations,
  loading,
  failed,
  fetching,
  onRefresh,
  onChoose,
}: {
  current: Repository | null
  installations: GrantingInstallation[] | undefined
  loading: boolean
  failed: boolean
  fetching: boolean
  onRefresh: () => void
  onChoose: (c: Choice) => void
}) {
  const listId = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const all = installations ?? []
  const grouped = all.length > 1
  const groups = all.map((installation) => ({
    installation,
    rows: installation.repositories.filter((r) =>
      r.name.toLowerCase().includes(needle),
    ),
  }))
  const options: Choice[] = groups.flatMap((g) =>
    g.rows.map((repository) => ({
      installationId: g.installation.id,
      repository,
    })),
  )
  const optionId = (c: Choice) =>
    `${listId}-${c.installationId}-${c.repository.id}`

  // The active row starts on the current choice, then follows the keys and
  // the pointer; a new search starts again at the top.
  const [active, setActive] = useState<number | null>(null)
  const start = Math.max(
    0,
    options.findIndex((c) => sameRepository(current, c)),
  )
  const at =
    options.length === 0
      ? -1
      : Math.min(active ?? (needle ? 0 : start), options.length - 1)
  const activeId = at >= 0 ? optionId(options[at]) : undefined

  useEffect(() => {
    searchRef.current?.focus()
  }, [])
  useEffect(() => {
    if (activeId) {
      document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [activeId])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (options.length === 0) return
    const move = (to: number) => {
      e.preventDefault()
      setActive((to + options.length) % options.length)
    }
    if (e.key === 'ArrowDown') move(at + 1)
    else if (e.key === 'ArrowUp') move(at - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(options.length - 1)
    else if (e.key === 'Enter' && at >= 0) {
      e.preventDefault()
      onChoose(options[at])
    }
  }

  const indexOf = new Map(options.map((c, n) => [optionId(c), n]))
  let body
  if (loading) {
    body = (
      <p
        role="status"
        className="text-muted-foreground flex items-center justify-center gap-2 px-3 py-8 text-sm"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading repositories…
      </p>
    )
  } else if (failed) {
    body = (
      <p className="text-muted-foreground px-3 py-8 text-center text-sm">
        Could not load repositories ·{' '}
        <button
          type="button"
          onClick={onRefresh}
          className="text-foreground underline underline-offset-4"
        >
          Try again
        </button>
      </p>
    )
  } else {
    body = (
      <div id={listId} role="listbox" aria-label="Repositories">
        {groups.map(({ installation: i, rows }) => {
          // While searching, an account with nothing matching steps aside.
          if (needle && rows.length === 0) return null
          return (
            <div
              key={i.id}
              role="group"
              aria-label={i.accountLogin}
              className="not-first:mt-1"
            >
              {grouped ? (
                // Indented to the names, past the check's slot.
                <div className="text-muted-foreground flex h-7 items-center justify-between gap-2 pr-2 pl-8 text-xs">
                  <span className="truncate font-medium">{i.accountLogin}</span>
                  <AccessLink installation={i}>Adjust access</AccessLink>
                </div>
              ) : null}
              {i.problem ? (
                <p className="text-muted-foreground py-1.5 pr-2 pl-8 text-xs">
                  {i.problemMessage ??
                    `GitHub would not list the repositories of ${i.accountLogin}.`}
                </p>
              ) : i.repositories.length === 0 ? (
                <p className="text-muted-foreground py-1.5 pr-2 pl-8 text-xs">
                  The GitHub App cannot reach any repository of {i.accountLogin}{' '}
                  yet.
                </p>
              ) : null}
              {rows.map((r) => {
                const c = { installationId: i.id, repository: r }
                const n = indexOf.get(optionId(c)) ?? -1
                const selected = sameRepository(current, c)
                return (
                  <div
                    key={r.id}
                    id={optionId(c)}
                    role="option"
                    aria-selected={selected}
                    data-active={n === at}
                    // Keep the focus in the search while clicking.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => n !== at && setActive(n)}
                    onClick={() => onChoose(c)}
                    // The keys work from the search (aria-activedescendant);
                    // this is for a row that got focus some other way.
                    tabIndex={-1}
                    onKeyDown={(e) => e.key === 'Enter' && onChoose(c)}
                    className="data-[active=true]:bg-muted flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm"
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      {selected ? (
                        <Check className="size-3.5" aria-hidden />
                      ) : null}
                    </span>
                    <span className="truncate">{r.name}</span>
                    {r.private ? (
                      <Lock
                        className="text-muted-foreground size-3 shrink-0"
                        aria-label="Private"
                      />
                    ) : null}
                    {r.pushedAt ? (
                      <span
                        className="text-muted-foreground ml-auto shrink-0 pl-3 text-xs tabular-nums"
                        title={new Date(r.pushedAt).toLocaleString()}
                      >
                        {relativeTime(r.pushedAt)}
                      </span>
                    ) : null}
                  </div>
                )
              })}
              {i.truncated && !needle ? (
                <p className="text-muted-foreground py-1.5 pr-2 pl-8 text-xs">
                  Only the first {i.repositories.length} repositories are
                  listed.
                </p>
              ) : null}
            </div>
          )
        })}
        {needle && options.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-sm">
            No repository matches &ldquo;{q.trim()}&rdquo;.
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {/* The search's icon sits in the check's column of the rows. */}
      <div className="flex items-center gap-2 border-b px-3">
        <Search
          className="text-muted-foreground size-3.5 shrink-0"
          aria-hidden
        />
        <input
          ref={searchRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setActive(null)
          }}
          onKeyDown={onKeyDown}
          placeholder="Search repositories"
          aria-label="Search repositories"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          autoComplete="off"
          spellCheck={false}
          className="placeholder:text-muted-foreground h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
      </div>
      <div className="max-h-[260px] overflow-y-auto p-1">{body}</div>
      {all.length > 0 ? (
        // One line always: with several accounts their links are in the
        // group headers, and only Refresh is left here.
        <div className="text-muted-foreground flex h-9 items-center justify-between gap-2 border-t pr-1 pl-3 text-xs whitespace-nowrap">
          {grouped ? (
            <span />
          ) : (
            <p className="min-w-0 truncate">
              Missing a repository?{' '}
              <AccessLink installation={all[0]}>
                Adjust GitHub App access
              </AccessLink>
            </p>
          )}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            onClick={onRefresh}
            disabled={fetching}
            aria-label={grouped ? undefined : 'Refresh the list'}
            title="Refresh the list"
          >
            <RefreshCw className={cn(fetching && 'animate-spin')} aria-hidden />
            {grouped ? 'Refresh' : null}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** The installation's settings on GitHub, where access is granted. */
function AccessLink({
  installation,
  children,
}: {
  installation: GrantingInstallation
  children: ReactNode
}) {
  return (
    <a
      href={installation.settingsUrl}
      target="_blank"
      rel="noreferrer"
      className="text-foreground/80 hover:text-foreground inline-flex items-center gap-0.5 underline-offset-4 hover:underline"
    >
      {children}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  )
}
