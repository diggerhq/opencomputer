import { useState, type ReactNode } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { ApiError } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { relativeTime } from '../computer-state'
import type { Repository } from './api'
import { repositoryName, repositoryProblem } from './board'
import {
  useGrantingInstallations,
  useOpenItems,
  useRepository,
} from './queries'
import { ConnectGitHubButton, RepositoryPicker } from './RepositorySetting'

// The knowledge repository setting, as one self-contained section that can be
// mounted on any settings surface: which repository holds the working docs,
// how the board's reading of it stands, Change (with a confirmation when it
// switches), and the one action that fixes each problem the server reports.

/** `id` goes on the section, as a link target. */
export function KnowledgeRepositorySection({ id }: { id?: string }) {
  const repository = useRepository()
  const [editing, setEditing] = useState(false)

  let body: ReactNode
  if (repository.isPending) {
    body = (
      <p role="status" className="text-muted-foreground flex items-center">
        <Loader2 className="size-4 animate-spin" aria-label="Loading" />
      </p>
    )
  } else if (repository.isError) {
    const missing =
      repository.error instanceof ApiError && repository.error.status === 404
    body = (
      <p className="text-muted-foreground">
        {missing
          ? 'Tracked work is not available here yet.'
          : 'Could not load the knowledge repository. Try loading this page again.'}
      </p>
    )
  } else if (!repository.data) {
    body = <RepositoryPicker current={null} />
  } else if (editing) {
    body = (
      <RepositoryPicker
        current={repository.data}
        onDone={() => setEditing(false)}
        onCancel={() => setEditing(false)}
      />
    )
  } else {
    body = (
      <Current repository={repository.data} onChange={() => setEditing(true)} />
    )
  }

  return (
    <section id={id} aria-labelledby="knowledge-repository-title">
      <h2
        id="knowledge-repository-title"
        className="mb-1 text-sm font-semibold"
      >
        Knowledge repository
      </h2>
      <p className="text-muted-foreground mb-3 text-sm">
        The GitHub repository where agents keep working docs. The board shows
        the items in it.
      </p>
      <div className="bg-panel rounded-lg border px-5 py-4 text-sm">{body}</div>
    </section>
  )
}

/** The chosen repository, how the board's reading of it stands, and its fix. */
function Current({
  repository: r,
  onChange,
}: {
  repository: Repository
  onChange: () => void
}) {
  const problem = repositoryProblem(r)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <dl className="grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-1.5">
          <dt className="text-muted-foreground">Repository</dt>
          <dd className="min-w-0">
            <a
              href={`https://github.com/${r.owner}/${r.name}`}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground inline-flex items-center gap-1 font-medium"
            >
              {repositoryName(r)}
              <ExternalLink
                className="text-muted-foreground size-3"
                aria-hidden
              />
            </a>
          </dd>
          <dt className="text-muted-foreground">Branch</dt>
          <dd>{r.branch}</dd>
          <dt className="text-muted-foreground">State</dt>
          <dd>
            {problem ? (
              <span className="text-status-error">{problem}</span>
            ) : (
              <ReadState repository={r} />
            )}
          </dd>
        </dl>
        {problem ? null : (
          <Button size="sm" variant="outline" onClick={onChange}>
            Change
          </Button>
        )}
      </div>
      {problem ? <Fix repository={r} onChange={onChange} /> : null}
    </div>
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
  onChange,
}: {
  repository: Repository
  onChange: () => void
}) {
  const code = r.problem ?? ''
  const needsAccess =
    code === 'repository_not_found' || code === 'access_denied'
  // Only the access fix needs the installation's settings page.
  const installations = useGrantingInstallations(needsAccess)
  const settingsUrl = installations.data?.find(
    (i) => i.id === String(r.installationId),
  )?.settingsUrl

  if (code === 'installation_removed' || code === 'installation_suspended') {
    return (
      <Actions
        hint={
          code === 'installation_suspended'
            ? 'Unsuspend the GitHub App, or connect it again, then come back.'
            : 'Connect the GitHub App again, then come back.'
        }
      >
        <ConnectGitHubButton label="Reconnect GitHub" variant="default" />
        <Button size="sm" variant="ghost" onClick={onChange}>
          Choose another repository
        </Button>
      </Actions>
    )
  }
  if (needsAccess) {
    return (
      <Actions hint="Grant the GitHub App this repository again, or pick another one.">
        {settingsUrl ? (
          <Button size="sm" asChild>
            <a href={settingsUrl} target="_blank" rel="noreferrer">
              Adjust GitHub App access
              <ExternalLink aria-hidden />
            </a>
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={settingsUrl ? 'outline' : 'default'}
          onClick={onChange}
        >
          Choose another repository
        </Button>
      </Actions>
    )
  }
  if (code === 'branch_not_found') {
    return (
      <Actions
        hint={`The ${r.branch} branch is gone. Choose the repository again to use its default branch.`}
      >
        <Button size="sm" onClick={onChange}>
          Change
        </Button>
      </Actions>
    )
  }
  if (code === 'github_app_not_configured') {
    return (
      <Actions hint="This is on our side, not yours; the board reads again once it is fixed." />
    )
  }
  return (
    <Actions>
      <Button size="sm" variant="outline" onClick={onChange}>
        Change
      </Button>
    </Actions>
  )
}

function Actions({ hint, children }: { hint?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-4">
      {hint ? <p className="text-muted-foreground flex-1">{hint}</p> : null}
      {children ? <div className="flex gap-2">{children}</div> : null}
    </div>
  )
}
