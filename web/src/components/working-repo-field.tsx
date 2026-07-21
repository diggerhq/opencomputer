import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Select as SelectPrimitive } from 'radix-ui'
import { Check, ChevronDown, GitBranch, X } from 'lucide-react'
import { getDeployApp, getRepositoryAccess } from '@/api/client'
import { GithubMark } from '@/components/github-mark'
import { markFloatingLayerPointerDismiss } from '@/components/ui/floating-layer'
import { cn } from '@/lib/utils'
import { repositoryAccessQueryKey } from '@/lib/repository-access'
import {
  selectedWorkingRepo,
  workingRepoValue,
  type WorkingRepoValue,
} from '@/lib/working-repo'

// The WORKING repo a session checks out and opens PRs from (design 010 §2). Deliberately SEPARATE
// from the agent's config/"connected" repo (prompt + skills) — an agent is typically configured
// from one repo and works across others, so this never defaults to the connected repo. Optional:
// a session starts fine with none; when set, the agent can publish PRs.

export interface WorkingRepo extends WorkingRepoValue {
  repo: string // stable repo_ id for Flue; "owner/repo" for legacy runtimes
  fullName?: string // display coordinate when repo is a stable id
  ref: string // branch
}

function splitRepo(full: string): [owner: string, name: string] {
  const i = full.indexOf('/')
  return i === -1 ? ['', full] : [full.slice(0, i), full.slice(i + 1)]
}

/**
 * Inline, secondary working-repo control for the session composer. A compact, GitHub-marked
 * dropdown — unselected by default (short "Working repo" placeholder); starting a session works
 * empty. Selecting a repo reveals a branch pill (prefilled with the repo's default branch) and a
 * clear (✕). Flue reads the agent's effective repository policy; legacy runtimes retain the
 * installation-wide getDeployApp list. Custom-styled on the Radix primitive (no new dependency)
 * so it reads as a deliberate control, not stock.
 */
export function WorkingRepoField({
  agentId,
  runtime,
  value,
  onChange,
}: {
  agentId?: string
  runtime?: string | null
  value: WorkingRepo | null
  onChange: (v: WorkingRepo | null) => void
}) {
  const useFluePolicy = runtime === 'flue' && Boolean(agentId)
  const {
    data: app,
    isLoading: appLoading,
    isError: appError,
    refetch: refetchApp,
  } = useQuery({
    queryKey: ['deploy-app'],
    queryFn: getDeployApp,
    enabled: !useFluePolicy,
    staleTime: 30_000,
  })
  const {
    data: access,
    isLoading: accessLoading,
    isError: accessError,
    refetch: refetchAccess,
  } = useQuery({
    queryKey: repositoryAccessQueryKey(agentId ?? ''),
    queryFn: () => getRepositoryAccess(agentId!),
    enabled: useFluePolicy,
    staleTime: 15_000,
    refetchOnWindowFocus: 'always',
  })
  const repoOptions = useMemo(
    () =>
      useFluePolicy
        ? (access?.effective_repositories ?? [])
        : (app?.repositories ?? []),
    [access, app, useFluePolicy],
  )
  const isLoading = useFluePolicy ? accessLoading : appLoading
  const isError = useFluePolicy ? accessError : appError
  const refetch = useFluePolicy ? refetchAccess : refetchApp
  const installed = useFluePolicy
    ? access?.grant.status === 'active'
    : app?.installed !== false // treat "still loading" as installed
  const installUrl = useFluePolicy
    ? access?.grant.install_url
    : app?.install_url
  const policyDisabled =
    useFluePolicy &&
    access?.policy.mode === 'selected' &&
    access.policy.repository_ids.length === 0
  const disabled = !installed || repoOptions.length === 0

  const pickRepo = (repoValue: string) => {
    const r = repoOptions.find((x) =>
      useFluePolicy ? x.id === repoValue : x.full_name === repoValue,
    )
    if (!r) return
    // Keep the current branch when re-picking the same repo; else the repo's default.
    onChange(selectedWorkingRepo(r, useFluePolicy, value))
  }

  // Load failed → an explicit retry, not a silent "No repos available" dead-end.
  if (isError) {
    return (
      <button
        type="button"
        onClick={() => void refetch()}
        className="border-border inline-flex h-8 items-center gap-2 rounded-md border border-dashed px-2.5 text-sm text-red-600 transition-colors hover:border-red-400 dark:text-red-500"
        title="Couldn't load your repos — click to retry"
      >
        <GithubMark className="size-3.5" />
        Couldn’t load repos — retry
      </button>
    )
  }

  // Not installed → a quiet connect affordance instead of a dead control.
  if (installed === false && installUrl) {
    const unavailable = useFluePolicy && access?.grant.status === 'unavailable'
    return (
      <a
        href={installUrl}
        target="_blank"
        rel="noreferrer"
        className="border-border text-muted-foreground hover:text-foreground hover:border-foreground/25 inline-flex h-8 items-center gap-2 rounded-md border border-dashed px-2.5 text-sm transition-colors"
        title={
          unavailable
            ? 'The GitHub installation is unavailable — reconnect it to work in a repo'
            : 'Connect the OpenComputer GitHub App to work in a repo'
        }
      >
        <GithubMark className="size-3.5" />
        {unavailable ? 'GitHub unavailable' : 'Connect GitHub'}
      </a>
    )
  }

  const displayRepo = value?.fullName ?? value?.repo ?? ''
  const [owner, name] = value ? splitRepo(displayRepo) : ['', '']

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <SelectPrimitive.Root
        value={value?.repo ?? ''}
        onValueChange={pickRepo}
        disabled={disabled}
      >
        <SelectPrimitive.Trigger
          aria-label="Working repo"
          title="Optional — the repo the agent works in and opens PRs from"
          className={cn(
            'border-border bg-panel-2 hover:border-foreground/25 focus-visible:border-foreground/40 data-[state=open]:border-foreground/35 group inline-flex h-8 max-w-64 min-w-40 items-center gap-2 rounded-md border px-2.5 text-sm transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-60',
          )}
        >
          <GithubMark className="text-muted-foreground group-hover:text-foreground/70 size-3.5 shrink-0 transition-colors" />
          <span className="min-w-0 flex-1 truncate text-left">
            {value ? (
              <span className="font-medium">
                <span className="text-muted-foreground">{owner}/</span>
                {name}
              </span>
            ) : (
              <span className="text-muted-foreground">
                {disabled
                  ? isLoading
                    ? 'Loading repos…'
                    : policyDisabled
                      ? 'Repository access disabled'
                      : 'No repos available'
                  : 'Working repo'}
              </span>
            )}
          </span>
          <ChevronDown className="text-muted-foreground/50 size-3.5 shrink-0" />
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            position="popper"
            sideOffset={5}
            onPointerDownOutside={markFloatingLayerPointerDismiss}
            className="bg-popover text-popover-foreground ring-foreground/10 shadow-overlay data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) origin-(--radix-select-content-transform-origin) overflow-hidden rounded-lg p-1 ring-1 duration-100"
          >
            <SelectPrimitive.Viewport>
              {repoOptions.map((r) => {
                const [o, n] = splitRepo(r.full_name)
                const repoValue = workingRepoValue(r, useFluePolicy)
                return (
                  <SelectPrimitive.Item
                    key={repoValue}
                    value={repoValue}
                    className="focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm outline-hidden select-none"
                  >
                    <GithubMark className="text-muted-foreground size-3.5 shrink-0" />
                    <SelectPrimitive.ItemText>
                      <span className="text-muted-foreground">{o}/</span>
                      {n}
                    </SelectPrimitive.ItemText>
                    <span className="absolute right-2 flex items-center">
                      <SelectPrimitive.ItemIndicator>
                        <Check className="size-4" />
                      </SelectPrimitive.ItemIndicator>
                    </span>
                  </SelectPrimitive.Item>
                )
              })}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>

      {value ? (
        <span className="border-border bg-panel-2 focus-within:border-foreground/40 inline-flex h-8 items-center gap-1 rounded-md border pr-1 pl-2 transition-colors">
          <GitBranch className="text-muted-foreground size-3.5 shrink-0" />
          <input
            value={value.ref}
            onChange={(e) => onChange({ ...value, ref: e.target.value })}
            placeholder="main"
            aria-label="Branch"
            spellCheck={false}
            className="w-24 bg-transparent font-mono text-xs outline-none"
          />
          <button
            type="button"
            title="Clear working repo"
            className="text-muted-foreground hover:text-foreground hover:bg-accent rounded p-0.5"
            onClick={() => onChange(null)}
          >
            <X className="size-3.5" />
          </button>
        </span>
      ) : null}
    </div>
  )
}
