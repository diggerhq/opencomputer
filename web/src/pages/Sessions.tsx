import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { MessagesSquare } from 'lucide-react'
import { getSessions, getAgents } from '@/api/client'
import type { Session } from '@/api/client'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ResourceTable, type Column } from '@/components/resource-table'

export default function Sessions() {
  const { data, isLoading } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => getSessions(),
  })
  // Resolve agent_id → name for display (cheap, cached alongside the Agents page).
  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: getAgents,
  })
  const agentName = (id?: string | null) =>
    agents?.find((a) => a.id === id)?.name ?? id ?? '—'

  const sessions = data?.sessions ?? []

  const columns: Column<Session>[] = [
    {
      key: 'id',
      header: 'Session',
      cell: (s) => (
        <Link
          to={`/sessions/${s.id}`}
          className="text-foreground font-mono text-[13px] underline-offset-4 hover:underline"
        >
          {s.id}
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (s) => <StatusBadge status={s.status} />,
    },
    {
      key: 'agent',
      header: 'Agent',
      cell: (s) => (
        <span className="text-muted-foreground text-sm">
          {agentName(s.agent_id)}
        </span>
      ),
    },
    {
      key: 'events',
      header: 'Events',
      align: 'right',
      cell: (s) => (
        <span className="text-muted-foreground font-mono text-xs">
          {s.event_seq ?? 0}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      cell: (s) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(s.created_at).toLocaleString()}
        </span>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Sessions"
        description="Durable agent runs — an append-only event log you can steer."
      />

      <Panel className="overflow-hidden">
        <ResourceTable
          columns={columns}
          rows={sessions}
          rowKey={(s) => s.id}
          loading={isLoading}
          empty={
            <EmptyState
              icon={MessagesSquare}
              title="No sessions yet"
              description="Start a session from an agent to give it a task; it runs durably and streams events here."
            />
          }
        />
      </Panel>
    </div>
  )
}
