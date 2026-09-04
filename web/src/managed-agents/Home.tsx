import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ChevronRight, FolderKanban, Loader2, Plus } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Panel, PanelContent } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { getManagedProjects } from './api'
import ProjectOnboarding from './ProjectOnboarding'

export default function ProjectsHome() {
  const projects = useQuery({
    queryKey: ['managed-projects'],
    queryFn: getManagedProjects,
  })
  const items = projects.data ?? []

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
                  <ChevronRight className="text-muted-foreground size-4 transition-transform group-hover:translate-x-0.5" />
                </PanelContent>
              </Panel>
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
