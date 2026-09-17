import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  ChevronRight,
  FolderKanban,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Panel, PanelContent } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { notifyError, notifySuccess } from '@/lib/errors'
import { deleteManagedProject, getManagedProjects } from './api'
import ProjectOnboarding from './ProjectOnboarding'

/** What the delete stopped on its way out, phrased for someone reading a toast. */
function torndown(stopped: { sessions: number; connections: number }): string {
  const parts = [
    stopped.sessions > 0
      ? `${stopped.sessions} running ${stopped.sessions === 1 ? 'session' : 'sessions'}`
      : '',
    stopped.connections > 0
      ? `${stopped.connections} ${stopped.connections === 1 ? 'connection' : 'connections'}`
      : '',
  ].filter(Boolean)
  return parts.length ? `Stopped ${parts.join(' and ')}.` : ''
}

export default function ProjectsHome() {
  const queryClient = useQueryClient()
  const projects = useQuery({
    queryKey: ['managed-projects'],
    queryFn: getManagedProjects,
  })
  const items = projects.data ?? []
  // The project the confirm dialog is open for, held whole so the dialog can
  // name it after the list behind it has already been invalidated.
  const [pendingDelete, setPendingDelete] = useState<{
    id: string
    name: string
  } | null>(null)
  const remove = useMutation({
    mutationFn: deleteManagedProject,
    onSuccess: async (result) => {
      setPendingDelete(null)
      await queryClient.invalidateQueries({ queryKey: ['managed-projects'] })
      notifySuccess('Project deleted.', torndown(result.stopped) || undefined)
    },
    // A project whose runtime could not be stopped is refused outright and
    // nothing is deleted, so the dialog stays open for another attempt.
    onError: (error) => notifyError("Couldn't delete the project.", error),
  })

  if (projects.isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    )
  }

  if (projects.isError) {
    return (
      <Panel>
        <EmptyState
          icon={FolderKanban}
          title="Your projects are temporarily unavailable"
          description="Try loading the projects page again."
          action={
            <Button variant="outline" onClick={() => void projects.refetch()}>
              Try again
            </Button>
          }
        />
      </Panel>
    )
  }

  if (items.length === 0) return <ProjectOnboarding />

  return (
    <div className="space-y-8">
      <PageHeader
        title="Projects"
        description="Choose a project to open its agent playground, deployments, sessions, and resources."
        actions={
          <Button asChild>
            <Link to="/new">
              <Plus /> New project
            </Link>
          </Button>
        }
      />

      <section className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((project) => (
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
                      {project.environments.length} environments
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${project.name}`}
                    className="text-muted-foreground hover:text-destructive size-8 shrink-0"
                    onClick={(event) => {
                      // The whole card is a link to the project; deleting it
                      // must not navigate into what is about to be removed.
                      event.preventDefault()
                      event.stopPropagation()
                      setPendingDelete({ id: project.id, name: project.name })
                    }}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                  <ChevronRight className="text-muted-foreground size-4 transition-transform group-hover:translate-x-0.5" />
                </PanelContent>
              </Panel>
            </Link>
          ))}
        </div>
      </section>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        title={`Delete ${pendingDelete?.name ?? 'this project'}?`}
        description="This deletes the project and everything under it — its agents, deployments, secrets and connections — and stops any session still running. It cannot be undone."
        confirmLabel="Delete project"
        destructive
        pending={remove.isPending}
        onConfirm={() => {
          if (pendingDelete) remove.mutate(pendingDelete.id)
        }}
      />
    </div>
  )
}
