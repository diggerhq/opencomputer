import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, MessagesSquare, Pencil, Send } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import { getAgent, updateAgent, getSessions, createSession } from '@/api/client'
import type { Session } from '@/api/schemas'
import { PageHeader } from '@/components/page-header'
import {
  Panel,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/form'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ResourceTable, type Column } from '@/components/resource-table'
import { Skeleton } from '@/components/ui/skeleton'

// Mirrors the curated list in Agents.tsx (the create flow). /v3 wants a
// provider-prefixed model id.
const MODELS = [
  { value: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8' },
  { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
]

export default function AgentDetail() {
  const { agentId = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const {
    data: agent,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['agent', agentId],
    queryFn: () => getAgent(agentId),
    enabled: !!agentId,
  })

  // This agent's sessions. /v3 has no per-agent filter, so scope client-side.
  const { data: allSessions, isLoading: loadingSessions } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => getSessions(),
  })
  const sessions = (allSessions ?? []).filter((s) => s.agent_id === agentId)

  // ── Start a session (inline composer) ─────────────────────────────────────
  const [task, setTask] = useState('')
  const startMutation = useMutation({
    mutationFn: () =>
      createSession(
        { agent: agentId, input: task.trim() },
        crypto.randomUUID(),
      ),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
      void navigate(`/sessions/${session.id}`)
    },
    onError: (e) => notifyError("Couldn't start the session.", e),
  })

  // ── Edit (inline, no popup) ───────────────────────────────────────────────
  const [editing, setEditing] = useState(false)
  const [editModel, setEditModel] = useState('')
  const [editPrompt, setEditPrompt] = useState('')
  const [editKey, setEditKey] = useState('')

  const openEdit = () => {
    if (!agent) return
    setEditModel(agent.model)
    setEditPrompt('')
    setEditKey('')
    setEditing(true)
  }
  const closeEdit = () => {
    setEditing(false)
    setEditKey('') // never leave a model key in state
  }

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!agent) throw new Error('no agent loaded')
      const body: { model?: string; prompt?: string; key?: string } = {}
      if (editModel.trim() && editModel.trim() !== agent.model)
        body.model = editModel.trim()
      if (editPrompt.trim()) body.prompt = editPrompt.trim()
      if (editKey.trim()) body.key = editKey.trim()
      return updateAgent(agent.id, body)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent', agentId] })
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      closeEdit()
    },
    onError: (e) => notifyError("Couldn't update the agent.", e),
  })

  const sessionColumns: Column<Session>[] = [
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
    <div className="max-w-4xl">
      <Link
        to="/agents"
        className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1.5 text-sm"
      >
        <ArrowLeft className="size-4" />
        Agents
      </Link>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : isError || !agent ? (
        <EmptyState
          icon={MessagesSquare}
          title="Agent not found"
          description="This agent doesn't exist or you don't have access to it."
          action={
            <Button size="sm" onClick={() => void navigate('/agents')}>
              Back to agents
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          <PageHeader
            title={agent.name}
            description="A reusable definition. Sessions pin a snapshot of it at create time."
            api={{
              method: 'POST',
              path: '/v3/sessions',
              sdk: 'oc.sessions.create()',
              docs: 'https://docs.opencomputer.dev/agent-sessions/sessions',
            }}
            actions={
              !editing ? (
                <Button variant="outline" size="sm" onClick={openEdit}>
                  <Pencil className="size-4" />
                  Edit
                </Button>
              ) : null
            }
          />

          {/* Overview */}
          <Panel className="p-5">
            <div className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              <span>Agent ID</span>
              <span className="text-foreground font-mono">{agent.id}</span>
              <span>Model</span>
              <span className="text-foreground font-mono">{agent.model}</span>
              <span>Runtime</span>
              <span className="text-foreground capitalize">
                {agent.runtime}
              </span>
              <span>Revision</span>
              <span className="text-foreground font-mono">
                {agent.revision ?? 1}
              </span>
              <span>Credential</span>
              <span className="text-foreground">
                {agent.credential_id ? 'Set' : 'None'}
              </span>
              <span>Created</span>
              <span className="text-foreground">
                {new Date(agent.created_at).toLocaleString()}
              </span>
            </div>

            {editing ? (
              <form
                className="mt-5 space-y-4 border-t pt-5"
                onSubmit={(e) => {
                  e.preventDefault()
                  updateMutation.mutate()
                }}
              >
                <Field label="Model" htmlFor="edit-model">
                  <Select
                    id="edit-model"
                    value={editModel}
                    onValueChange={setEditModel}
                    options={
                      MODELS.some((m) => m.value === editModel) || !editModel
                        ? MODELS
                        : [{ value: editModel, label: editModel }, ...MODELS]
                    }
                  />
                </Field>
                <Field
                  label="New prompt"
                  htmlFor="edit-prompt"
                  description="Leave blank to keep the current prompt (it isn't shown)."
                >
                  <Textarea
                    id="edit-prompt"
                    value={editPrompt}
                    onChange={(e) => setEditPrompt(e.target.value)}
                    placeholder="Replace the system prompt…"
                    className="min-h-24"
                  />
                </Field>
                <Field
                  label="Rotate Anthropic API key"
                  htmlFor="edit-key"
                  description="Leave blank to keep the current credential."
                >
                  <Input
                    id="edit-key"
                    type="password"
                    value={editKey}
                    onChange={(e) => setEditKey(e.target.value)}
                    placeholder="sk-ant-…"
                  />
                </Field>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={closeEdit}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={updateMutation.isPending}>
                    {updateMutation.isPending ? 'Saving…' : 'Save changes'}
                  </Button>
                </div>
              </form>
            ) : null}
          </Panel>

          {/* Sessions */}
          <Panel className="overflow-hidden">
            <PanelHeader>
              <PanelTitle>Sessions</PanelTitle>
              <Link
                to="/sessions"
                className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
              >
                All sessions
              </Link>
            </PanelHeader>

            <PanelContent className="border-b">
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (task.trim()) startMutation.mutate()
                }}
              >
                <Textarea
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  placeholder="Give this agent a task — it runs durably as a new session…"
                  className="min-h-20"
                />
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={startMutation.isPending || !task.trim()}
                  >
                    <Send className="size-4" />
                    {startMutation.isPending ? 'Starting…' : 'Start session'}
                  </Button>
                </div>
              </form>
            </PanelContent>

            <ResourceTable
              columns={sessionColumns}
              rows={sessions}
              rowKey={(s) => s.id}
              loading={loadingSessions}
              empty={
                <EmptyState
                  icon={MessagesSquare}
                  title="No sessions yet"
                  description="Start a session above to give this agent a durable task."
                />
              }
            />
          </Panel>
        </div>
      )}
    </div>
  )
}
