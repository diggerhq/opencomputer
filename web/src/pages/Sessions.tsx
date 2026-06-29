import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { MessagesSquare, Plus } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import { getSessions, getAgents, createSession } from '@/api/client'
import type { Session } from '@/api/client'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, Label, Select, Textarea } from '@/components/form'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ResourceTable, type Column } from '@/components/resource-table'

export default function Sessions() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => getSessions(),
  })
  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: getAgents,
  })
  const agentName = (id?: string | null) =>
    agents?.find((a) => a.id === id)?.name ?? id ?? '—'

  const [showStart, setShowStart] = useState(false)
  const [agentId, setAgentId] = useState('')
  const [message, setMessage] = useState('')

  const openStart = () => {
    setAgentId(agents?.[0]?.id ?? '')
    setMessage('')
    setShowStart(true)
  }

  const startMutation = useMutation({
    mutationFn: () =>
      createSession(
        { agent: agentId, input: message.trim() },
        crypto.randomUUID(),
      ),
    onSuccess: (session) => {
      setShowStart(false)
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
      void navigate(`/sessions/${session.id}`)
    },
    onError: (e) => notifyError("Couldn't start the session.", e),
  })

  const sessions = data ?? []
  const hasAgents = (agents?.length ?? 0) > 0

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
          {s.head ?? 0}
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
        title="Agent sessions"
        description="Durable agent runs — an append-only event log you can steer."
        api={{
          method: 'POST',
          path: '/v3/sessions',
          sdk: 'oc.sessions.create()',
          docs: 'https://docs.opencomputer.dev/agent-sessions/sessions',
        }}
        actions={
          <Button onClick={openStart}>
            <Plus className="size-4" />
            Start session
          </Button>
        }
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
              action={
                <Button size="sm" onClick={openStart}>
                  <Plus className="size-4" />
                  Start session
                </Button>
              }
            />
          }
        />
      </Panel>

      <Dialog open={showStart} onOpenChange={setShowStart}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start session</DialogTitle>
            <DialogDescription>
              Pick an agent and give it a first task. The session runs durably
              and you can steer it as it goes.
            </DialogDescription>
          </DialogHeader>

          {!hasAgents ? (
            <p className="text-muted-foreground py-2 text-sm">
              You need an agent first.{' '}
              <Link
                to="/agents"
                className="text-foreground font-medium underline underline-offset-4"
              >
                Create an agent
              </Link>
              .
            </p>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (agentId && message.trim()) startMutation.mutate()
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="start-agent">Agent</Label>
                <Select
                  id="start-agent"
                  value={agentId}
                  onValueChange={setAgentId}
                  options={(agents ?? []).map((a) => ({
                    value: a.id,
                    label: a.name,
                  }))}
                />
              </div>
              <Field
                label="First task"
                htmlFor="start-message"
                description="What should the agent do? (required)"
              >
                <Textarea
                  id="start-message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Review PR #412 and open a follow-up if anything needs fixing."
                  className="min-h-24"
                />
              </Field>
              <DialogFooter className="mt-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setShowStart(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    startMutation.isPending || !agentId || !message.trim()
                  }
                >
                  {startMutation.isPending ? 'Starting…' : 'Start session'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
