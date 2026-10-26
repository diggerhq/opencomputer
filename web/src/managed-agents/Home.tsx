import { useContext, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Navigate } from 'react-router-dom'
import {
  Archive,
  Check,
  CheckSquare,
  ChevronRight,
  FolderKanban,
  Loader2,
  Plus,
  RotateCcw,
} from 'lucide-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Panel, PanelContent } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  archiveManagedProject,
  getManagedProjects,
  restoreManagedProject,
} from './api'
import ProjectOnboarding from './ProjectOnboarding'
import { AuthContext } from '@/hooks/useAuth'

/**
 * The automation project list. At `/` (`list` unset) an organization without
 * projects goes to its computer; at `/automations` it sees the empty list.
 */
export default function ProjectsHome({ list = false }: { list?: boolean }) {
  // The computer is behind a rollout flag (work 052); no auth, no computer.
  const computerEnabled =
    useContext(AuthContext)?.user?.computerEnabled ?? false
  const queryClient = useQueryClient()
  // Always read afresh: projects are created elsewhere too (the CLI, a
  // template deploy), and an empty list sends the organization away to its
  // computer, so a stale cached [] must never decide that.
  const projects = useQuery({
    queryKey: ['managed-projects'],
    queryFn: () => getManagedProjects(),
    refetchOnMount: 'always',
  })
  const archivedProjects = useQuery({
    queryKey: ['managed-projects', 'archived'],
    queryFn: () => getManagedProjects({ archived: true }),
    refetchOnMount: 'always',
  })
  const items = projects.data ?? []
  const archivedItems = archivedProjects.data ?? []
  // The projects the confirm dialog is open for, held whole so the dialog can
  // name them after the list behind it has already been invalidated.
  const [pendingArchive, setPendingArchive] = useState<
    { id: string; name: string }[] | null
  >(null)
  // Selection mode turns the cards into checkboxes for archiving many at once.
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const stopSelecting = () => {
    setSelecting(false)
    setSelected(new Set())
  }
  const archive = useMutation({
    // One request per project; each is archived or fails on its own.
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map(archiveManagedProject))
      const failed = ids.filter((_, i) => results[i].status === 'rejected')
      const rejection = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      return { failed, error: rejection?.reason as unknown }
    },
    onSuccess: async ({ failed, error }, ids) => {
      setPendingArchive(null)
      await queryClient.invalidateQueries({ queryKey: ['managed-projects'] })
      const archived = ids.length - failed.length
      if (failed.length === 0) {
        stopSelecting()
        notifySuccess(
          archived === 1
            ? 'Project archived.'
            : `${archived} projects archived.`,
          'You can restore them at any time.',
        )
        return
      }
      // Keep what failed selected so it can be retried.
      setSelected(new Set(failed))
      notifyError(
        ids.length === 1
          ? "Couldn't archive the project."
          : `Couldn't archive ${failed.length} of ${ids.length} projects.`,
        error,
      )
    },
    onError: (error) => notifyError("Couldn't archive the project.", error),
  })
  const toggleSelected = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const selectedProjects = items.filter((project) => selected.has(project.id))
  const restore = useMutation({
    mutationFn: restoreManagedProject,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['managed-projects'] })
      notifySuccess('Project restored.')
    },
    onError: (error) => notifyError("Couldn't restore the project.", error),
  })

  if (projects.isLoading || archivedProjects.isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    )
  }

  if (projects.isError || archivedProjects.isError) {
    return (
      <Panel>
        <EmptyState
          icon={FolderKanban}
          title="Your automation projects are temporarily unavailable"
          description="Try loading the automations page again."
          action={
            <Button variant="outline" onClick={() => void projects.refetch()}>
              Try again
            </Button>
          }
        />
      </Panel>
    )
  }

  // An organization without projects starts at its computer (017, work 052),
  // every time: the computer page is its onboarding. Project onboarding
  // stays at /new, linked quietly from there.
  if (items.length === 0 && archivedItems.length === 0 && list) {
    return (
      <div className="space-y-8">
        <PageHeader title="Automation projects" />
        <Panel>
          <EmptyState
            icon={FolderKanban}
            title="No automations yet"
            description="Ask your computer in Slack to automate something you do every week, or create a project yourself."
            action={
              <Button asChild variant="outline">
                <Link to="/new">
                  <Plus /> New project
                </Link>
              </Button>
            }
          />
        </Panel>
      </div>
    )
  }

  if (items.length === 0 && archivedItems.length === 0) {
    // A cached empty list is still being checked: wait for the answer.
    if (
      computerEnabled &&
      (projects.isFetching || archivedProjects.isFetching)
    ) {
      return (
        <div className="flex min-h-64 items-center justify-center">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      )
    }
    return computerEnabled ? (
      <Navigate to="/computer" replace />
    ) : (
      <ProjectOnboarding />
    )
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Automation projects"
        description="Open one to see its agent playground, deployments, sessions, and resources."
        actions={
          <>
            {items.length > 1 && !selecting && (
              <Button variant="outline" onClick={() => setSelecting(true)}>
                <CheckSquare /> Select
              </Button>
            )}
            <Button asChild>
              <Link to="/new">
                <Plus /> New project
              </Link>
            </Button>
          </>
        }
      />

      <section className="space-y-3">
        {selecting && (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-muted-foreground mr-auto text-sm">
              {selected.size} selected
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setSelected(
                  selected.size === items.length
                    ? new Set()
                    : new Set(items.map((project) => project.id)),
                )
              }
            >
              {selected.size === items.length ? 'Select none' : 'Select all'}
            </Button>
            <Button variant="ghost" size="sm" onClick={stopSelecting}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={selected.size === 0}
              onClick={() =>
                setPendingArchive(
                  selectedProjects.map(({ id, name }) => ({ id, name })),
                )
              }
            >
              <Archive aria-hidden />
              Archive
              {selected.size > 0 ? ` ${selected.size}` : ''}
            </Button>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((project) =>
            selecting ? (
              <button
                key={project.id}
                type="button"
                aria-pressed={selected.has(project.id)}
                aria-label={`Select ${project.name}`}
                onClick={() => toggleSelected(project.id)}
                className="focus-visible:ring-ring/50 rounded-lg text-left outline-none focus-visible:ring-3"
              >
                <Panel
                  className={
                    selected.has(project.id)
                      ? 'border-primary/60 bg-primary/5 h-full transition-colors'
                      : 'hover:border-foreground/20 hover:bg-muted/25 h-full transition-colors'
                  }
                >
                  <PanelContent className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className={
                        selected.has(project.id)
                          ? 'border-primary bg-primary text-primary-foreground flex size-4 shrink-0 items-center justify-center rounded-[4px] border'
                          : 'border-input flex size-4 shrink-0 items-center justify-center rounded-[4px] border'
                      }
                    >
                      {selected.has(project.id) && (
                        <Check className="size-3.5" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {project.name}
                      </p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {project.agents.length}{' '}
                        {project.agents.length === 1 ? 'agent' : 'agents'}
                      </p>
                    </div>
                  </PanelContent>
                </Panel>
              </button>
            ) : (
              <Link
                key={project.id}
                to={`/projects/${encodeURIComponent(project.id)}`}
                className="group focus-visible:ring-ring/50 rounded-lg outline-none focus-visible:ring-3"
              >
                <Panel className="group-hover:border-foreground/20 group-hover:bg-muted/25 h-full transition-colors">
                  <PanelContent className="flex items-center gap-3">
                    <div className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-lg">
                      <FolderKanban className="size-4" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {project.name}
                      </p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {project.agents.length}{' '}
                        {project.agents.length === 1 ? 'agent' : 'agents'} ·{' '}
                        {project.environments.length === 1
                          ? 'single environment'
                          : `${project.environments.length} environments`}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Archive ${project.name}`}
                      className="text-muted-foreground size-8 shrink-0"
                      onClick={(event) => {
                        // The whole card is a link; archiving must not navigate.
                        event.preventDefault()
                        event.stopPropagation()
                        setPendingArchive([
                          { id: project.id, name: project.name },
                        ])
                      }}
                    >
                      <Archive className="size-4" aria-hidden />
                    </Button>
                    <ChevronRight className="text-muted-foreground size-4 transition-transform group-hover:translate-x-0.5" />
                  </PanelContent>
                </Panel>
              </Link>
            ),
          )}
        </div>
      </section>

      {archivedItems.length > 0 && (
        <details className="group space-y-3">
          <summary className="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm font-medium transition-colors [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
            Archived ({archivedItems.length})
          </summary>
          <div className="space-y-3 pt-1">
            <p className="text-muted-foreground text-xs">
              Archived projects keep their configuration and can be restored.
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {archivedItems.map((project) => (
                <Panel key={project.id} className="bg-muted/20">
                  <PanelContent className="flex items-center gap-3">
                    <div className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-lg">
                      <Archive className="size-4" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {project.name}
                      </p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        Archived
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={restore.isPending}
                      onClick={() => restore.mutate(project.id)}
                    >
                      <RotateCcw className="size-4" aria-hidden />
                      Restore
                    </Button>
                  </PanelContent>
                </Panel>
              ))}
            </div>
          </div>
        </details>
      )}

      <ConfirmDialog
        open={pendingArchive !== null}
        onOpenChange={(open) => {
          if (!open) setPendingArchive(null)
        }}
        title={
          pendingArchive && pendingArchive.length > 1
            ? `Archive ${pendingArchive.length} projects?`
            : `Archive ${pendingArchive?.[0]?.name ?? 'this project'}?`
        }
        description={
          pendingArchive && pendingArchive.length > 1 ? (
            <>
              This hides these projects and stops their running sessions. Their
              agents, deployments, secrets and connections are preserved, and
              you can restore them later.
              {/* Description renders a <p>, so block spans rather than a list.
                  Capped height keeps the confirm button on screen. */}
              <span className="mt-3 block max-h-48 overflow-y-auto rounded-md border px-3 py-2">
                {pendingArchive.map((p) => (
                  <span key={p.id} className="text-foreground block truncate">
                    {p.name}
                  </span>
                ))}
              </span>
            </>
          ) : (
            'This hides the project and stops its running sessions. Its agents, deployments, secrets and connections are preserved, and you can restore it later.'
          )
        }
        confirmLabel={
          pendingArchive && pendingArchive.length > 1
            ? `Archive ${pendingArchive.length} projects`
            : 'Archive project'
        }
        pending={archive.isPending}
        onConfirm={() => {
          if (pendingArchive) archive.mutate(pendingArchive.map((p) => p.id))
        }}
      />
    </div>
  )
}
