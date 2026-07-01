import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { GitBranch, X, ExternalLink } from 'lucide-react'
import { getDeployApp } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/form'

// The WORKING repo a session checks out and opens PRs from (design 010 §2). It is deliberately
// SEPARATE from the agent's config/"connected" repo (where prompt + skills come from) — an agent
// is typically configured from one repo and works across others, so this never defaults to the
// connected repo. Optional: a session starts fine with none (chat/analysis need no repo); when
// set, the agent can publish + (later) watch PRs against it.

export interface WorkingRepo {
  repo: string // "owner/repo"
  ref: string // branch
}

const lastKey = (agentId: string) => `oc.workingRepo.${agentId}`

/** Remember the last working repo chosen FOR THIS AGENT — offered as a suggestion next time,
 *  never auto-applied (a working repo is always an explicit choice). Best-effort; ignore quota. */
function readLast(agentId: string): WorkingRepo | null {
  try {
    const raw = localStorage.getItem(lastKey(agentId))
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<WorkingRepo>
    return v.repo && v.ref ? { repo: v.repo, ref: v.ref } : null
  } catch {
    return null
  }
}
export function rememberWorkingRepo(agentId: string, wr: WorkingRepo): void {
  try {
    localStorage.setItem(lastKey(agentId), JSON.stringify(wr))
  } catch {
    /* ignore */
  }
}

/**
 * Inline, secondary working-repo control for the session composer. Unset → a quiet ghost chip
 * ("Working repo"); starting works empty. Set → a solid removable chip (owner/repo · branch).
 * Clicking either opens a lightweight picker over the repos the OpenComputer App can reach.
 */
export function WorkingRepoField({
  agentId,
  value,
  onChange,
}: {
  agentId: string
  value: WorkingRepo | null
  onChange: (v: WorkingRepo | null) => void
}) {
  const [open, setOpen] = useState(false)
  const { data: app, isLoading } = useQuery({
    queryKey: ['deploy-app'],
    queryFn: getDeployApp,
    enabled: open,
    staleTime: 30_000,
  })

  const repoOptions = useMemo(
    () => (app?.repositories ?? []).map((r) => ({ value: r.full_name, label: r.full_name })),
    [app],
  )
  const suggestion = useMemo(() => readLast(agentId), [agentId, open])

  // Draft state while the picker is open.
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('')
  useEffect(() => {
    if (open) {
      setRepo(value?.repo ?? '')
      setBranch(value?.ref ?? '')
    }
  }, [open, value])

  const pickRepo = (fullName: string) => {
    setRepo(fullName)
    const r = app?.repositories.find((x) => x.full_name === fullName)
    setBranch((b) => b || r?.default_branch || 'main')
  }

  const apply = () => {
    if (!repo || !branch.trim()) return
    const wr = { repo, ref: branch.trim() }
    rememberWorkingRepo(agentId, wr)
    onChange(wr)
    setOpen(false)
  }

  // ── The chip (collapsed state) ──────────────────────────────────────────────
  if (!open) {
    if (value) {
      return (
        <span className="border-border bg-panel-2 inline-flex items-center gap-1.5 rounded-full border py-1 pr-1 pl-2.5 text-xs">
          <button
            type="button"
            className="text-foreground hover:text-foreground/80 inline-flex items-center gap-1.5"
            title="Change working repo"
            onClick={() => setOpen(true)}
          >
            <GitBranch className="size-3 shrink-0" />
            <span className="font-mono">
              {value.repo} · {value.ref}
            </span>
          </button>
          <button
            type="button"
            title="Remove working repo"
            className="text-muted-foreground hover:text-foreground hover:bg-accent rounded-full p-0.5"
            onClick={() => onChange(null)}
          >
            <X className="size-3" />
          </button>
        </span>
      )
    }
    return (
      <button
        type="button"
        className="border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 inline-flex items-center gap-1.5 rounded-full border border-dashed px-2.5 py-1 text-xs transition-colors"
        title="Attach a repo for the agent to work in and open PRs from (optional)"
        onClick={() => setOpen(true)}
      >
        <GitBranch className="size-3 shrink-0" />
        Working repo
      </button>
    )
  }

  // ── The picker (expanded state) ─────────────────────────────────────────────
  return (
    <div className="border-border bg-panel-2 w-full max-w-md space-y-2 rounded-md border p-2.5 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-foreground font-medium">Working repo</span>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setOpen(false)}
          title="Close"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <p className="text-muted-foreground">
        The repo this session checks out and opens PRs from. Separate from where the agent gets
        its prompt + skills.
      </p>

      {isLoading ? (
        <p className="text-muted-foreground">Loading repos…</p>
      ) : !app?.installed ? (
        <div className="space-y-2">
          <p className="text-muted-foreground">
            Connect the OpenComputer GitHub App to pick a repo.
          </p>
          {app?.install_url ? (
            <Button size="sm" variant="outline" asChild>
              <a href={app.install_url} target="_blank" rel="noreferrer">
                <ExternalLink className="size-3.5" />
                Connect GitHub
              </a>
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          {suggestion && suggestion.repo !== repo ? (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 underline-offset-2 hover:underline"
              onClick={() => {
                setRepo(suggestion.repo)
                setBranch(suggestion.ref)
              }}
            >
              Recently used: <span className="font-mono">{suggestion.repo}</span>
            </button>
          ) : null}
          <Select
            value={repo}
            onValueChange={pickRepo}
            placeholder={repoOptions.length ? 'Select a repo' : 'No repos available'}
            disabled={repoOptions.length === 0}
            options={repoOptions}
          />
          <div className="flex items-center gap-2">
            <Input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              className="max-w-40"
              aria-label="Branch"
            />
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={!repo || !branch.trim()} onClick={apply}>
                Use repo
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
