import { useQuery } from '@tanstack/react-query'
import { Link, useLocation, useParams } from 'react-router-dom'
import { AlertTriangle, FolderKanban, Loader2 } from 'lucide-react'
import { ApiError } from '@/api/errors'
import { EmptyState } from '@/components/empty-state'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import ManagedAgentDetail from './Detail'
import { getManagedProject } from './api'
import { selectedProjectAgentId } from './project-context'

export default function ProjectDetail() {
  const { projectId = '', projectAgentId } = useParams()
  const location = useLocation()
  const project = useQuery({
    queryKey: ['managed-project', projectId],
    queryFn: () => getManagedProject(projectId),
    enabled: Boolean(projectId),
    refetchInterval: 1_500,
  })

  if (project.isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    )
  }
  // A poll that fails (laptop woke up, session cookie expired, network blip)
  // keeps the last good project as stale `data` — keep rendering it rather
  // than replacing the page with "not found". Only a fetch with nothing cached
  // decides between a real 404 and a load failure.
  if (!project.data) {
    if (project.isError && !isNotFound(project.error)) {
      return (
        <Panel>
          <EmptyState
            icon={AlertTriangle}
            title="Couldn't load this project"
            description={project.error.message}
            action={
              <Button variant="outline" onClick={() => void project.refetch()}>
                Retry
              </Button>
            }
          />
        </Panel>
      )
    }
    return (
      <Panel>
        <EmptyState
          icon={FolderKanban}
          title="Project not found"
          description="This project is not available in your organization."
          action={
            <Button asChild variant="outline">
              <Link to="/">Back to projects</Link>
            </Button>
          }
        />
      </Panel>
    )
  }

  const agentId = selectedProjectAgentId(
    projectAgentId
      ? `/projects/${encodeURIComponent(projectId)}/playground/${encodeURIComponent(projectAgentId)}`
      : location.pathname,
    location.search,
    project.data.project.agents,
  )
  if (!agentId) {
    return (
      <Panel>
        <EmptyState
          icon={FolderKanban}
          title="This project has no agents yet"
          description="Initialize the hello-world starter locally and deploy its first agent."
        />
      </Panel>
    )
  }
  return <ManagedAgentDetail agentId={agentId} project={project.data} />
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404
}
