import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { Bot, Plus } from 'lucide-react'
import { getAgents, getDeployApp, type Agent } from '@/api/client'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { ResourceTable, type Column } from '@/components/resource-table'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { agentDeploymentDisplayStatus } from '@/lib/agent-deployment-status'

export default function Agents() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: agents, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: getAgents,
  })

  const columns: Column<Agent>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (agent) => (
        <Link
          to={`/agents/${agent.id}`}
          className="text-foreground font-medium underline-offset-4 hover:underline"
        >
          {agent.name}
        </Link>
      ),
    },
    {
      key: 'model',
      header: 'Model',
      cell: (agent) => (
        <code className="text-muted-foreground font-mono text-xs">
          {agent.model}
        </code>
      ),
    },
    {
      key: 'runtime',
      header: 'Runtime',
      cell: (agent) => (
        <span className="text-muted-foreground text-xs capitalize">
          {agent.runtime}
        </span>
      ),
    },
    {
      key: 'deployment',
      header: 'Deployment',
      cell: (agent) => {
        const status = agentDeploymentDisplayStatus(agent)
        const deploymentId = agent.deployment_status?.deployment_id
        if (!deploymentId) return <StatusBadge status={status} />
        return (
          <Link
            to={`/agents/${agent.id}/deployments/${deploymentId}`}
            aria-label={`Open latest deployment for ${agent.name}: ${status.replace(/_/g, ' ')}`}
            className="focus-visible:ring-ring/50 inline-flex rounded-md outline-none focus-visible:ring-3"
          >
            <StatusBadge status={status} />
          </Link>
        )
      },
    },
    {
      key: 'revision',
      header: 'Active revision',
      align: 'right',
      cell: (agent) => (
        <span className="text-muted-foreground font-mono text-xs">
          {agent.active_revision
            ? `#${agent.active_revision.number}`
            : agent.revision && agent.revision > 0
              ? `#${agent.revision}`
              : 'Not deployed'}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      cell: (agent) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(agent.created_at).toLocaleDateString()}
        </span>
      ),
    },
  ]

  const prefetchCreate = () => {
    void import('@/pages/AgentNew')
    void queryClient.prefetchQuery({
      queryKey: ['deploy-app'],
      queryFn: getDeployApp,
      staleTime: 30_000,
    })
  }
  const openCreate = () => {
    prefetchCreate()
    void navigate('/agents/new')
  }

  const createIntentProps = {
    onPointerEnter: prefetchCreate,
    onFocus: prefetchCreate,
  }

  return (
    <div>
      <PageHeader
        title="Agents"
        description="Reusable agents, from built-in prompts to Flue code deployed from a repository."
        api={{
          method: 'POST',
          path: '/v3/agents',
          sdk: 'oc.agents.create()',
          docs: 'https://docs.opencomputer.dev/agent-sessions/agents',
        }}
        actions={
          <Button onClick={openCreate} {...createIntentProps}>
            <Plus className="size-4" />
            Create agent
          </Button>
        }
      />

      <Panel className="overflow-hidden">
        <ResourceTable
          columns={columns}
          rows={agents ?? []}
          rowKey={(agent) => agent.id}
          loading={isLoading}
          empty={
            <EmptyState
              icon={Bot}
              title="No agents yet"
              description="Define an agent once, then start durable sessions from it."
              action={
                <Button size="sm" onClick={openCreate} {...createIntentProps}>
                  <Plus className="size-4" />
                  Create agent
                </Button>
              }
            />
          }
        />
      </Panel>
    </div>
  )
}
