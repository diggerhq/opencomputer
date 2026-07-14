import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Bot, Plus } from 'lucide-react'
import { getAgents, type Agent } from '@/api/client'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { ResourceTable, type Column } from '@/components/resource-table'
import { Button } from '@/components/ui/button'

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
        description="Reusable definitions: a prompt, model, and runtime a session runs."
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
