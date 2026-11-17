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
import { cn } from '@/lib/utils'
import {
  archiveManagedProject,
  getManagedProjects,
  restoreManagedProject,
} from './api'
import ProjectOnboarding from './ProjectOnboarding'
import { AuthContext } from '@/hooks/useAuth'

/**
 * The automation project list. At `/` (`list` unset) an organization without
 * projects goes to its computer, unless an administrator selected a landing
 * experience. At `/automations` it always sees the project list.
 */
export default function ProjectsHome({ list = false }: { list?: boolean }) {
  // The computer is behind a rollout flag (work 052); no auth, no computer.
  const user = useContext(AuthContext)?.user
  const computerEnabled = user?.computerEnabled ?? false
  const onboardingExperience = user?.onboardingExperience
  const redirectToComputer =
    !list && onboardingExperience === 'computer' && computerEnabled
  const redirectToAutomations = !list && onboardingExperience === 'automations'
  const needsProjects = !redirectToComputer && !redirectToAutomations
  const queryClient = useQueryClient()
  // Always read afresh: projects are created elsewhere too (the CLI, a
  // template deploy), and an empty list sends the organization away to its
  // computer, so a stale cached [] must never decide that.
  const projects = useQuery({
    queryKey: ['managed-projects'],
    enabled: needsProjects,
    queryFn: () => getManagedProjects(),
    refetchOnMount: 'always',
  })
  const archivedProjects = useQuery({
    queryKey: ['managed-projects', 'archived'],
    enabled: needsProjects,
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
  const allSelected = selected.size === items.length
  const selectedProjects = items.filter((project) => selected.has(project.id))
  const restore = useMutation({
    mutationFn: restoreManagedProject,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['managed-projects'] })
      notifySuccess('Project restored.')
    },
    onError: (error) => notifyError("Couldn't restore the project.", error),
  })

  // An administrator can send an existing workspace into onboarding without
  // deleting its projects. Explicit /automations visits always keep the list.
  // Decide before project loading/errors: an override does not depend on them.
  if (redirectToComputer) {
    return <Navigate to="/computer" replace />
  }
  if (redirectToAutomations) {
    return <Navigate to="/automations" replace />
  }

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
        // Actions sit under the description until there is room beside it,
        // so the reserved selection width never squeezes the text.
        className="sm:flex-col lg:flex-row lg:items-start lg:justify-between"
        title="Automation projects"
        description="Open one to see its agent playground, deployments, sessions, and resources."
        actions={
          // Both sets of actions always occupy the slot, one of them hidden,
          // so it is as wide in either mode: the description beside it wraps
          // the same and the list below never moves.
          <div className="grid justify-items-start lg:justify-items-end">
            <div
              className={cn(
                'col-start-1 row-start-1 flex flex-wrap items-center gap-2',
                !selecting && 'invisible',
              )}
            >
              <span className="text-muted-foreground mr-1 min-w-20 text-right text-sm tabular-nums">
                {selected.size} selected
              </span>
              <Button
                variant="ghost"
                onClick={() =>
                  setSelected(
                    allSelected
                      ? new Set()
                      : new Set(items.map((project) => project.id)),
                  )
                }
              >
                {/* Sized for the longer label, so toggling it can't reflow. */}
                <span className="grid">
                  <span
                    className={cn(
                      'col-start-1 row-start-1',
                      allSelected && 'invisible',
                    )}
                  >
                    Select all
                  </span>
                  <span
                    className={cn(
                      'col-start-1 row-start-1',
                      !allSelected && 'invisible',
                    )}
                  >
                    Select none
                  </span>
                </span>
              </Button>
              <Button variant="outline" onClick={stopSelecting}>
                Cancel
              </Button>
              <Button
                disabled={selected.size === 0}
                onClick={() =>
                  setPendingArchive(
                    selectedProjects.map(({ id, name }) => ({ id, name })),
                  )
                }
              >
                <Archive aria-hidden />
                Archive
              </Button>
            </div>
            <div
              className={cn(
                'col-start-1 row-start-1 flex flex-wrap items-center gap-2',
                selecting && 'invisible',
              )}
            >
              {items.length > 1 && (
                <Button variant="outline" onClick={() => setSelecting(true)}>
                  <CheckSquare /> Select
                </Button>
              )}
              <Button asChild>
                <Link to="/new">
                  <Plus /> New project
                </Link>
              </Button>
            </div>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((project) => {
          const isSelected = selected.has(project.id)
          // Both modes render the same card: only the leading tile turns into
          // a checkbox and the trailing controls hide, keeping their space.
          const card = (
            <Panel
              className={cn(
                'h-full transition-colors',
                isSelected
                  ? 'border-primary/60 bg-primary/5'
                  : 'group-hover:border-foreground/20 group-hover:bg-muted/25',
              )}
            >
              <PanelContent className="flex items-center gap-3">
                <div
                  aria-hidden={selecting}
                  className={cn(
                    'flex size-10 shrink-0 items-center justify-center rounded-lg transition-colors',
                    selecting && isSelected
                      ? 'bg-primary text-primary-foreground'
                      : selecting
                        ? 'bg-muted text-muted-foreground'
                        : 'bg-primary/10 text-primary',
                  )}
                >
                  {selecting ? (
                    isSelected ? (
                      <Check className="size-4" />
                    ) : (
                      <span className="border-muted-foreground/60 size-4 rounded-[4px] border" />
                    )
                  ) : (
                    <FolderKanban className="size-4" aria-hidden />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{project.name}</p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {project.agents.length}{' '}
                    {project.agents.length === 1 ? 'agent' : 'agents'} ·{' '}
                    {project.environments.length === 1
                      ? 'single environment'
                      : `${project.environments.length} environments`}
                  </p>
                </div>
                {selecting ? (
                  <span aria-hidden className="size-8 shrink-0" />
                ) : (
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
                )}
                <ChevronRight
                  aria-hidden
                  className={cn(
                    'text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5',
                    selecting && 'invisible',
                  )}
                />
              </PanelContent>
            </Panel>
          )
          return selecting ? (
            <button
              key={project.id}
              type="button"
              aria-pressed={isSelected}
              aria-label={`Select ${project.name}`}
              onClick={() => toggleSelected(project.id)}
              className="group focus-visible:ring-ring/50 rounded-lg text-left outline-none focus-visible:ring-3"
            >
              {card}
            </button>
          ) : (
            <Link
              key={project.id}
              to={`/projects/${encodeURIComponent(project.id)}`}
              className="group focus-visible:ring-ring/50 rounded-lg outline-none focus-visible:ring-3"
            >
              {card}
            </Link>
          )
        })}
      </div>

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
