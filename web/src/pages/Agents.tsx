import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { Bot, Plus } from 'lucide-react'
import { getAgents, type Agent } from '@/api/client'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { ResourceTable, type Column } from '@/components/resource-table'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { agentDeploymentDisplayStatus } from '@/lib/agent-deployment-status'

export default function Agents() {
  const navigate = useNavigate()
  const { data: agents, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: getAgents,
  })

  const columns: Column<Agent>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (agent) => (
        <span className="text-foreground font-medium">{agent.name}</span>
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
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
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

  const openCreate = () => void navigate('/agents/new')

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
          <Button onClick={openCreate}>
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
          onRowClick={(agent) => void navigate(`/agents/${agent.id}`)}
          loading={isLoading}
          empty={
            <EmptyState
              icon={Bot}
              title="No agents yet"
              description="Define an agent once, then start durable sessions from it."
              action={
                <Button size="sm" onClick={openCreate}>
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
