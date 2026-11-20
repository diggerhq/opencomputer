import { useState, type ReactNode } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { ApiError } from '@/api/errors'
import {
  SettingsAction,
  SettingsRow,
  SettingsRowSkeleton,
  SettingsSection,
} from '@/components/settings'
import { Button } from '@/components/ui/button'
import { relativeTime } from '../computer-state'
import type { Repository } from './api'
import { repositoryName, repositoryProblem } from './board'
import {
  useGrantingInstallations,
  useOpenItems,
  useRepository,
} from './queries'
import { ConnectGitHubButton, RepositoryCombobox } from './RepositorySetting'

// The knowledge repository setting, as one self-contained section in the
// settings anatomy (components/settings.tsx), so it can be mounted on any
// settings surface: which repository holds the working docs (the Repository
// row is the picker itself), its branch, how the board's reading of it
// stands, and the one action that fixes each problem the server reports.

/** `id` goes on the section, as a link target. */
export function KnowledgeRepositorySection({ id }: { id?: string }) {
  const repository = useRepository()
  // Open from a fix ("Choose another repository") as well as the trigger.
  const [choosing, setChoosing] = useState(false)

  let rows: ReactNode
  if (repository.isPending) {
    rows = (
      <div role="status" aria-label="Loading" className="divide-y">
        <SettingsRowSkeleton />
        <SettingsRowSkeleton />
        <SettingsRowSkeleton />
      </div>
    )
  } else if (repository.isError) {
    const missing =
      repository.error instanceof ApiError && repository.error.status === 404
    rows = (
      <SettingsRow>
        <span className="text-muted-foreground">
          {missing
            ? 'Tracked work is not available here yet.'
            : 'Could not load the knowledge repository. Try loading this page again.'}
        </span>
      </SettingsRow>
    )
  } else if (!repository.data) {
    rows = (
      <SettingsRow label="Repository">
        <RepositoryCombobox current={null} />
      </SettingsRow>
    )
  } else {
    const r = repository.data
    const problem = repositoryProblem(r)
    rows = (
      <>
        <SettingsRow
          label="Repository"
          action={
            <SettingsAction size="icon-sm" asChild>
              <a
                href={`https://github.com/${r.owner}/${r.name}`}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${repositoryName(r)} on GitHub`}
                title="Open on GitHub"
              >
                <ExternalLink />
              </a>
            </SettingsAction>
          }
        >
          <RepositoryCombobox
            current={r}
            open={choosing}
            onOpenChange={setChoosing}
          />
        </SettingsRow>
        <SettingsRow label="Branch">
          <span className="font-mono text-[13px]">{r.branch}</span>
        </SettingsRow>
        <SettingsRow label="State">
          {problem ? (
            <span className="text-status-error">{problem}</span>
          ) : (
            <ReadState repository={r} />
          )}
        </SettingsRow>
        {problem ? (
          <Fix repository={r} onChoose={() => setChoosing(true)} />
        ) : null}
      </>
    )
  }

  return (
    <SettingsSection
      id={id}
      title="Knowledge repository"
      description="The GitHub repository where agents keep working docs. The board shows the items in it."
    >
      {rows}
    </SettingsSection>
  )
}

/** How fresh the board's reading is, from the open-items poll. */
function ReadState({ repository: r }: { repository: Repository }) {
  const open = useOpenItems()
  const page = open.data?.page
  if (!page) return <span className="text-muted-foreground">…</span>
  if (page.building) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Loader2
          className="text-muted-foreground size-3.5 animate-spin"
          aria-hidden
        />
        Reading the working docs for the first time…
      </span>
    )
  }
  if (!page.asOf) {
    return <span className="text-muted-foreground">Not read yet</span>
  }
  return (
    <span>
      Up to date
      <span className="text-muted-foreground">
        {' '}
        · read{' '}
        <span className="tabular-nums" title={page.asOf}>
          {relativeTime(page.asOf)}
        </span>
        {page.head ? (
          <>
            {' '}
            at{' '}
            <a
              href={`https://github.com/${r.owner}/${r.name}/commit/${page.head}`}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground font-mono text-xs"
            >
              {page.head.slice(0, 7)}
            </a>
          </>
        ) : null}
      </span>
    </span>
  )
}

/**
 * The one action that fixes the problem, by the server's code (its
 * RepositoryProblem): reconnect a lost installation, grant access to a
 * repository it no longer reaches, or choose again.
 */
function Fix({
  repository: r,
  onChoose,
}: {
  repository: Repository
  onChoose: () => void
}) {
  const code = r.problem ?? ''
  const needsAccess =
    code === 'repository_not_found' || code === 'access_denied'
  // Only the access fix needs the installation's settings page.
  const installations = useGrantingInstallations(needsAccess)
  const settingsUrl = installations.data?.find(
    (i) => i.id === String(r.installationId),
  )?.settingsUrl
  // Quiet beside the fix itself; the button when it is the only way out.
  const another = (alone = false) =>
    alone ? (
      <Button size="sm" onClick={onChoose}>
        Choose another repository
      </Button>
    ) : (
      <SettingsAction onClick={onChoose}>
        Choose another repository
      </SettingsAction>
    )

  if (code === 'installation_removed' || code === 'installation_suspended') {
    return (
      <FixRow
        hint={
          code === 'installation_suspended'
            ? 'Unsuspend the GitHub App, or connect it again, then come back.'
            : 'Connect the GitHub App again, then come back.'
        }
      >
        <ConnectGitHubButton label="Reconnect GitHub" variant="default" />
        {another()}
      </FixRow>
    )
  }
  if (needsAccess) {
    return (
      <FixRow hint="Grant the GitHub App this repository again, or pick another one.">
        {settingsUrl ? (
          <Button size="sm" asChild>
            <a href={settingsUrl} target="_blank" rel="noreferrer">
              Adjust GitHub App access
              <ExternalLink aria-hidden />
            </a>
          </Button>
        ) : null}
        {another(!settingsUrl)}
      </FixRow>
    )
  }
  if (code === 'branch_not_found') {
    return (
      <FixRow
        hint={`The ${r.branch} branch is gone. Choose the repository again to use its default branch.`}
      >
        <Button size="sm" onClick={onChoose}>
          Choose again
        </Button>
      </FixRow>
    )
  }
  if (code === 'github_app_not_configured') {
    return (
      <FixRow hint="This is on our side, not yours; the board reads again once it is fixed." />
    )
  }
  return <FixRow>{another(true)}</FixRow>
}

function FixRow({ hint, children }: { hint?: string; children?: ReactNode }) {
  // In the value column, the hint over its buttons: a full sentence and two
  // buttons do not fit one line beside each other.
  return (
    <SettingsRow indent className="py-3">
      <div className="space-y-2.5">
        {hint ? <p className="text-muted-foreground">{hint}</p> : null}
        {children ? (
          <div className="flex flex-wrap items-center gap-2">{children}</div>
        ) : null}
      </div>
    </SettingsRow>
  )
}
