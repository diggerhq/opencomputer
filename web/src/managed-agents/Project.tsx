import { useQuery } from '@tanstack/react-query'
import { Link, useLocation, useParams } from 'react-router-dom'
import { FolderKanban, Loader2 } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import ManagedAgentDetail from './Detail'
import { ApiError } from '@/api/client'
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
  // A failed poll keeps the last good snapshot on screen; only a missing
  // project (404, or nothing ever loaded) is "not found".
  if (!project.data) {
    const missing =
      !project.isError ||
      (project.error instanceof ApiError && project.error.status === 404)
    return (
      <Panel>
        <EmptyState
          icon={FolderKanban}
          title={
            missing
              ? 'Project not found'
              : 'This project is temporarily unavailable'
          }
          description={
            missing
              ? 'This project is not available in your organization.'
              : 'Try loading the project again.'
          }
          action={
            missing ? (
              <Button asChild variant="outline">
                <Link to="/">Back to projects</Link>
              </Button>
            ) : (
              <Button variant="outline" onClick={() => void project.refetch()}>
                Try again
              </Button>
            )
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
