import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { MessagesSquare, Plus } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import { useHalted } from '@/hooks/useHalted'
import { getSessions, getAgents, createSession, ApiError } from '@/api/client'
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
import { Field, Label, Select } from '@/components/form'
import { Input } from '@/components/ui/input'
import {
  WorkingRepoField,
  type WorkingRepo,
} from '@/components/working-repo-field'
import { ChatTextarea } from '@/components/chat-textarea'
import { StatusBadge } from '@/components/status-badge'
import { RuntimeBadge } from '@/components/runtime-badge'
import { EmptyState } from '@/components/empty-state'
import { ResourceTable, type Column } from '@/components/resource-table'
import { formatSpend } from '@/lib/usage'

export default function Sessions() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const halted = useHalted() // out of credits → gate starting a session (out-of-credits doc, B3)
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
  // Optional per-session model override — empty inherits the agent's model
  // (cleared when the agent changes, since a model is runtime-specific).
  const [model, setModel] = useState('')
  // Optional working repo — explicitly chosen, per-agent (cleared when the agent changes).
  const [workingRepo, setWorkingRepo] = useState<WorkingRepo | null>(null)

  const selectedAgent = agents?.find((a) => a.id === agentId)
  // flue agents pin their model in the deployed artifact — no per-session override.
  const isFlueAgent = selectedAgent?.runtime === 'flue'

  const openStart = () => {
    setAgentId(agents?.[0]?.id ?? '')
    setMessage('')
    setModel('')
    setWorkingRepo(null)
    setShowStart(true)
  }

  const startMutation = useMutation({
    mutationFn: () =>
      createSession(
        {
          agent: agentId,
          input: message.trim(),
          // Only send a model when overridden — omitting it inherits the agent's.
          ...(model.trim() && !isFlueAgent ? { model: model.trim() } : {}),
          ...(workingRepo
            ? { sources: [{ repo: workingRepo.repo, ref: workingRepo.ref }] }
            : {}),
        },
        crypto.randomUUID(),
      ),
    onSuccess: (session) => {
      setShowStart(false)
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
      void navigate(`/sessions/${session.id}`)
    },
    onError: (e) => {
      if (e instanceof ApiError && e.type === 'insufficient_credits') {
        void queryClient.invalidateQueries({ queryKey: ['autumn-billing'] })
      }
      notifyError("Couldn't start the session.", e)
    },
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
      key: 'runtime',
      header: 'Runtime',
      cell: (s) => <RuntimeBadge runtime={s.agent_snapshot?.runtime} />,
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
      key: 'spend',
      header: 'Spend',
      align: 'right',
      cell: (s) => (
        <span className="text-muted-foreground font-mono text-xs tabular-nums">
          {formatSpend(s.usage)}
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
          <Button
            onClick={openStart}
            disabled={halted}
            title={halted ? 'Out of credits — top up to resume' : undefined}
          >
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
                <Button
                  size="sm"
                  onClick={openStart}
                  disabled={halted}
                  title={halted ? 'Out of credits — top up to resume' : undefined}
                >
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
                  onValueChange={(v) => {
                    setAgentId(v)
                    setModel('') // a model override is per-agent (runtime-specific)
                    setWorkingRepo(null) // a working repo is per-agent
                  }}
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
                <ChatTextarea
                  id="start-message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onSend={() => {
                    if (agentId && message.trim() && !startMutation.isPending) {
                      startMutation.mutate()
                    }
                  }}
                  placeholder="Review PR #412 and open a follow-up if anything needs fixing."
                  className="min-h-24"
                />
              </Field>
              {agentId && !isFlueAgent ? (
                <Field
                  label="Model"
                  htmlFor="start-model"
                  description={
                    selectedAgent?.model
                      ? `Optional — overrides just this session. Defaults to the agent's model (${selectedAgent.model}).`
                      : "Optional — overrides just this session. Defaults to the agent's model."
                  }
                >
                  <Input
                    id="start-model"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={selectedAgent?.model ?? 'provider/model'}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              ) : null}
              {agentId ? (
                <WorkingRepoField
                  value={workingRepo}
                  onChange={setWorkingRepo}
                />
              ) : null}
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
