import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, MessagesSquare, Pencil, Send } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import {
  getAgent,
  updateAgent,
  getSessions,
  createSession,
  getCredentials,
  createCredential,
} from '@/api/client'
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
import { SlackConnect } from '@/components/slack-connect'

// Mirrors the curated list in Agents.tsx (the create flow). The API wants a
// provider-prefixed model id.
const MODELS = [
  { value: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8' },
  { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
]

// Agents run on the "claude" runtime → anthropic credentials. Sentinel for the
// "create one inline" choice in the credential picker.
const CRED_PROVIDER = 'anthropic'
const NEW_CRED = '__new__'

type EditField = 'model' | 'prompt' | 'credential'

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

  // This agent's sessions. The API has no per-agent filter, so scope client-side.
  const { data: allSessions, isLoading: loadingSessions } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => getSessions(),
  })
  const sessions = (allSessions ?? []).filter((s) => s.agent_id === agentId)

  // Credentials for the switch picker + to label the current one.
  const { data: credentials } = useQuery({
    queryKey: ['credentials'],
    queryFn: getCredentials,
  })
  const anthropicCreds = (credentials ?? []).filter(
    (c) => c.provider === CRED_PROVIDER,
  )
  const credLabel = (id: string) => {
    const c = anthropicCreds.find((x) => x.id === id)
    if (!c) return id
    return `${c.name || 'Unnamed'}${c.last4 ? ` ·· ${c.last4}` : ''}${
      c.is_default ? ' (default)' : ''
    }`
  }

  // ── Start a session (inline composer) ─────────────────────────────────────
  const [task, setTask] = useState('')
  const startMutation = useMutation({
    mutationFn: () =>
      createSession({ agent: agentId, input: task.trim() }, crypto.randomUUID()),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
      void navigate(`/sessions/${session.id}`)
    },
    onError: (e) => notifyError("Couldn't start the session.", e),
  })

  // ── Field-by-field inline edit ────────────────────────────────────────────
  // One field at a time; the pencil on a row opens just that row's editor.
  const [editField, setEditField] = useState<EditField | null>(null)
  const [draftModel, setDraftModel] = useState('')
  const [draftPrompt, setDraftPrompt] = useState('')
  const [draftCred, setDraftCred] = useState('') // credential id or NEW_CRED
  const [newCredName, setNewCredName] = useState('')
  const [newCredKey, setNewCredKey] = useState('')

  const startEdit = (field: EditField) => {
    if (!agent) return
    if (field === 'model') setDraftModel(agent.model)
    if (field === 'prompt') setDraftPrompt(agent.prompt ?? '')
    if (field === 'credential') {
      setDraftCred(agent.credential_id ?? anthropicCreds[0]?.id ?? NEW_CRED)
      setNewCredName('')
      setNewCredKey('')
    }
    setEditField(field)
  }
  const cancelEdit = () => {
    setEditField(null)
    setNewCredKey('') // never leave a model key in state
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!agent) throw new Error('no agent loaded')
      if (editField === 'model')
        return updateAgent(agent.id, { model: draftModel.trim() })
      if (editField === 'prompt')
        return updateAgent(agent.id, { prompt: draftPrompt.trim() })
      // credential: switch to a chosen one, or mint a new one then switch.
      let credentialId = draftCred
      if (draftCred === NEW_CRED) {
        const cred = await createCredential({
          key: newCredKey.trim(),
          provider: CRED_PROVIDER,
          name: newCredName.trim() || undefined,
          is_default: !anthropicCreds.some((c) => c.is_default),
        })
        credentialId = cred.id
      }
      return updateAgent(agent.id, { credential: credentialId })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent', agentId] })
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      void queryClient.invalidateQueries({ queryKey: ['credentials'] })
      cancelEdit()
    },
    onError: (e) => notifyError("Couldn't update the agent.", e),
  })

  // Whether the open editor has a saveable value.
  const canSave =
    editField === 'model'
      ? draftModel.trim().length > 0
      : editField === 'prompt'
        ? draftPrompt.trim().length > 0
        : editField === 'credential'
          ? draftCred === NEW_CRED
            ? newCredKey.trim().length > 0
            : draftCred.length > 0
          : false

  const credOptions = [
    ...anthropicCreds.map((c) => ({ value: c.id, label: credLabel(c.id) })),
    { value: NEW_CRED, label: '＋ New credential…' },
  ]

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
              sdk: 'oc.sessions.create()',
              docs: 'https://docs.opencomputer.dev/agent-sessions/sessions',
            }}
          />

          {/* Configuration — each field edits in place. */}
          <Panel className="px-5 py-1.5">
            {/* Read-only identity rows */}
            <Row label="Agent ID">
              <span className="text-foreground font-mono text-sm">
                {agent.id}
              </span>
            </Row>
            <Row label="Runtime">
              <span className="text-foreground text-sm capitalize">
                {agent.runtime}
              </span>
            </Row>
            <Row label="Revision">
              <span className="text-foreground font-mono text-sm">
                {agent.revision ?? 1}
              </span>
            </Row>

            {/* Model */}
            <EditRow
              label="Model"
              editing={editField === 'model'}
              onEdit={() => startEdit('model')}
              onCancel={cancelEdit}
              onSave={() => saveMutation.mutate()}
              saving={saveMutation.isPending}
              canSave={canSave}
              display={
                <span className="text-foreground font-mono text-sm">
                  {agent.model}
                </span>
              }
            >
              <Select
                value={draftModel}
                onValueChange={setDraftModel}
                options={
                  MODELS.some((m) => m.value === draftModel) || !draftModel
                    ? MODELS
                    : [{ value: draftModel, label: draftModel }, ...MODELS]
                }
              />
            </EditRow>

            {/* Prompt — now shown, edited in place */}
            <EditRow
              label="Prompt"
              editing={editField === 'prompt'}
              onEdit={() => startEdit('prompt')}
              onCancel={cancelEdit}
              onSave={() => saveMutation.mutate()}
              saving={saveMutation.isPending}
              canSave={canSave}
              display={
                <p className="text-foreground text-sm whitespace-pre-wrap">
                  {agent.prompt || (
                    <span className="text-muted-foreground">No prompt set</span>
                  )}
                </p>
              }
            >
              <Textarea
                value={draftPrompt}
                onChange={(e) => setDraftPrompt(e.target.value)}
                placeholder="You are a meticulous code reviewer…"
                className="min-h-32"
              />
            </EditRow>

            {/* Credential — switch (pick existing / create new), not rotate */}
            <EditRow
              label="Credential"
              editing={editField === 'credential'}
              onEdit={() => startEdit('credential')}
              onCancel={cancelEdit}
              onSave={() => saveMutation.mutate()}
              saving={saveMutation.isPending}
              canSave={canSave}
              display={
                <span className="text-foreground text-sm">
                  {agent.credential_id ? (
                    credLabel(agent.credential_id)
                  ) : (
                    <span className="text-muted-foreground">
                      None — uses the org default
                    </span>
                  )}
                </span>
              }
            >
              <div className="space-y-3">
                <Select
                  value={draftCred}
                  onValueChange={setDraftCred}
                  options={credOptions}
                  placeholder="Choose a credential"
                />
                {draftCred === NEW_CRED ? (
                  <div className="border-border bg-panel-2 grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2">
                    <Field label="Credential name" htmlFor="new-cred-name">
                      <Input
                        id="new-cred-name"
                        value={newCredName}
                        onChange={(e) => setNewCredName(e.target.value)}
                        placeholder="e.g. Production"
                      />
                    </Field>
                    <Field
                      label="Anthropic API key"
                      htmlFor="new-cred-key"
                      description="Encrypted in a dedicated secret store."
                    >
                      <Input
                        id="new-cred-key"
                        type="password"
                        value={newCredKey}
                        onChange={(e) => setNewCredKey(e.target.value)}
                        placeholder="sk-ant-…"
                      />
                    </Field>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    Switches which credential this agent runs on. To change a
                    key's value, rotate it on the Credentials page.
                  </p>
                )}
              </div>
            </EditRow>
          </Panel>

          {/* Slack — kept above Sessions so it's visible without scrolling */}
          <SlackConnect agentId={agent.id} agentName={agent.name} />

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

// A read-only configuration row: a fixed-width label + value.
function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="border-border/60 flex items-baseline gap-4 border-b py-3 last:border-0">
      <span className="text-muted-foreground w-28 shrink-0 text-xs">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

// An editable configuration row: shows the value with a subtle pencil; clicking
// swaps in the editor (the children) with Save / Cancel. One row edits at a time.
function EditRow({
  label,
  editing,
  onEdit,
  onCancel,
  onSave,
  saving,
  canSave,
  display,
  children,
}: {
  label: string
  editing: boolean
  onEdit: () => void
  onCancel: () => void
  onSave: () => void
  saving: boolean
  canSave: boolean
  display: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="border-border/60 flex gap-4 border-b py-3 last:border-0">
      <span className="text-muted-foreground w-28 shrink-0 pt-1 text-xs">
        {label}
      </span>
      {!editing ? (
        <div className="flex min-w-0 flex-1 items-start justify-between gap-2">
          <div className="min-w-0">{display}</div>
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${label.toLowerCase()}`}
            className="text-muted-foreground hover:text-foreground -mt-0.5 shrink-0 rounded p-1"
          >
            <Pencil className="size-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex-1 space-y-2.5">
          {children}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={onSave}
              disabled={saving || !canSave}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
