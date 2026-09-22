import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Archive,
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

export default function ProjectsHome() {
  const queryClient = useQueryClient()
  const projects = useQuery({
    queryKey: ['managed-projects'],
    queryFn: () => getManagedProjects(),
  })
  const archivedProjects = useQuery({
    queryKey: ['managed-projects', 'archived'],
    queryFn: () => getManagedProjects({ archived: true }),
  })
  const items = projects.data ?? []
  const archivedItems = archivedProjects.data ?? []
  // The project the confirm dialog is open for, held whole so the dialog can
  // name it after the list behind it has already been invalidated.
  const [pendingArchive, setPendingArchive] = useState<{
    id: string
    name: string
  } | null>(null)
  const archive = useMutation({
    mutationFn: archiveManagedProject,
    onSuccess: async () => {
      setPendingArchive(null)
      await queryClient.invalidateQueries({ queryKey: ['managed-projects'] })
      notifySuccess('Project archived.', 'You can restore it at any time.')
    },
    onError: (error) => notifyError("Couldn't archive the project.", error),
  })
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

  if (items.length === 0 && archivedItems.length === 0) {
    return <ProjectOnboarding />
  }

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
                    aria-label={`Archive ${project.name}`}
                    className="text-muted-foreground size-8 shrink-0"
                    onClick={(event) => {
                      // The whole card is a link; archiving must not navigate.
                      event.preventDefault()
                      event.stopPropagation()
                      setPendingArchive({ id: project.id, name: project.name })
                    }}
                  >
                    <Archive className="size-4" aria-hidden />
                  </Button>
                  <ChevronRight className="text-muted-foreground size-4 transition-transform group-hover:translate-x-0.5" />
                </PanelContent>
              </Panel>
            </Link>
          ))}
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
        title={`Archive ${pendingArchive?.name ?? 'this project'}?`}
        description="This hides the project and stops its running sessions. Its agents, deployments, secrets and connections are preserved, and you can restore it later."
        confirmLabel="Archive project"
        pending={archive.isPending}
        onConfirm={() => {
          if (pendingArchive) archive.mutate(pendingArchive.id)
        }}
      />
    </div>
  )
}
