import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, MessagesSquare, Send } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import {
  getAgent,
  updateAgent,
  getSessions,
  createSession,
  getCredentials,
  createCredential,
  type Agent,
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
import { ChatTextarea } from '@/components/chat-textarea'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ResourceTable, type Column } from '@/components/resource-table'
import { Skeleton } from '@/components/ui/skeleton'
import { SlackConnect } from '@/components/slack-connect'
import { AgentSkills } from '@/components/agent-skills'
import { AgentRevisions } from '@/components/agent-revisions'
import { getRuntime } from '@/lib/runtimes'

// Sentinels for the non-credential choices in the picker. The model list +
// credential provider come from the agent's runtime (see @/lib/runtimes).
const ORG_DEFAULT = '__default__' // no pinned credential → org default resolves
const NEW_CRED = '__new__' // create one inline
const MANAGED = 'managed' // run via OpenComputer, no BYO key (token-billing §6.6)

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

  // This agent's sessions — filtered server-side (not a client slice of an unfiltered
  // first page, which would drop older sessions once the org is busy).
  const { data: sessions = [], isLoading: loadingSessions } = useQuery({
    queryKey: ['sessions', { agent: agentId }],
    queryFn: () => getSessions({ agent: agentId }),
  })

  // Credentials for the switch picker + to label the current one.
  const { data: credentials } = useQuery({
    queryKey: ['credentials'],
    queryFn: getCredentials,
  })
  // Model list + credential provider follow the agent's runtime (immutable after
  // create): claude→anthropic, codex→openai. Falls back to claude while loading.
  const rt = getRuntime(agent?.runtime)
  const providerCreds = (credentials ?? []).filter(
    (c) => c.provider === rt.provider,
  )
  const credLabel = (id: string) => {
    const c = providerCreds.find((x) => x.id === id)
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

  // ── Live config controls (no edit mode) ───────────────────────────────────
  // Dropdowns autosave on change (optimistic → no flicker); the prompt is a draft
  // with Save/Discard that enable only when it differs from what's saved.
  const settleAgent = () => {
    void queryClient.invalidateQueries({ queryKey: ['agent', agentId] })
    void queryClient.invalidateQueries({ queryKey: ['agents'] })
    // A prompt/model save creates a new revision → refresh the Revisions panel too.
    void queryClient.invalidateQueries({ queryKey: ['agent-revisions', agentId] })
    void queryClient.invalidateQueries({ queryKey: ['agent-deploys', agentId] })
  }
  const optimistic = async (patch: Partial<Agent>) => {
    await queryClient.cancelQueries({ queryKey: ['agent', agentId] })
    const prev = queryClient.getQueryData<Agent>(['agent', agentId])
    queryClient.setQueryData<Agent>(['agent', agentId], (old) =>
      old ? { ...old, ...patch } : old,
    )
    return prev
  }
  const rollback = (prev?: Agent) => {
    if (prev) queryClient.setQueryData(['agent', agentId], prev)
  }

  const modelMutation = useMutation({
    mutationFn: (model: string) => updateAgent(agentId, { model }),
    onMutate: (model) => optimistic({ model }),
    onError: (e, _v, prev) => {
      rollback(prev)
      notifyError("Couldn't update the model.", e)
    },
    onSettled: settleAgent,
  })

  const [promptDraft, setPromptDraft] = useState<string | undefined>(undefined)
  const promptMutation = useMutation({
    mutationFn: (prompt: string) => updateAgent(agentId, { prompt }),
    onMutate: (prompt) => optimistic({ prompt }),
    onError: (e, _v, prev) => {
      rollback(prev)
      notifyError("Couldn't update the prompt.", e)
    },
    onSuccess: () => setPromptDraft(undefined), // re-sync to saved
    onSettled: settleAgent,
  })

  const switchCredMutation = useMutation({
    mutationFn: (credential: string | null) =>
      updateAgent(agentId, { credential }),
    onMutate: (credential) => optimistic({ credential_id: credential }),
    onError: (e, _v, prev) => {
      rollback(prev)
      notifyError("Couldn't switch the credential.", e)
    },
    onSettled: settleAgent,
  })

  // Create a new credential inline, then switch the agent to it.
  const [credNew, setCredNew] = useState(false)
  const [newCredName, setNewCredName] = useState('')
  const [newCredKey, setNewCredKey] = useState('')
  const addCredMutation = useMutation({
    mutationFn: async () => {
      const cred = await createCredential({
        key: newCredKey.trim(),
        provider: rt.provider,
        name: newCredName.trim() || undefined,
        is_default: !providerCreds.some((c) => c.is_default),
      })
      return updateAgent(agentId, { credential: cred.id })
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['agent', agentId], data)
      void queryClient.invalidateQueries({ queryKey: ['credentials'] })
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      setCredNew(false)
      setNewCredName('')
      setNewCredKey('')
    },
    onError: (e) => notifyError("Couldn't add the credential.", e),
  })

  const credSaving = switchCredMutation.isPending || addCredMutation.isPending

  // Derived control values.
  const modelOptions = rt.models.some((m) => m.value === agent?.model)
    ? rt.models
    : [{ value: agent?.model ?? '', label: agent?.model ?? '' }, ...rt.models]
  const savedPrompt = agent?.prompt ?? ''
  const promptValue = promptDraft ?? savedPrompt
  const promptDirty = promptDraft !== undefined && promptDraft !== savedPrompt
  const credSelectValue = credNew
    ? NEW_CRED
    : (agent?.credential_id ?? ORG_DEFAULT)
  // Managed is always offered (every org carries a managed credential); it has no provider.
  const credOptions = [
    { value: ORG_DEFAULT, label: 'Org default (no pinned credential)' },
    { value: MANAGED, label: 'Managed · no key needed' },
    ...providerCreds.map((c) => ({ value: c.id, label: credLabel(c.id) })),
    { value: NEW_CRED, label: '＋ New credential…' },
  ]
  // ORG_DEFAULT → clear the pin (null); MANAGED → the "managed" sentinel; else a cred id.
  const onCredChange = (v: string) => {
    if (v === NEW_CRED) {
      setCredNew(true)
      return
    }
    setCredNew(false)
    switchCredMutation.mutate(v === ORG_DEFAULT ? null : v)
  }

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
              method: 'GET',
              path: '/v3/agents/{id}',
              sdk: 'oc.agents.get()',
              docs: 'https://docs.opencomputer.dev/agent-sessions/agents',
            }}
          />

          {/* Configuration — live controls; changes save in place. */}
          <Panel className="space-y-5 p-5">
            <div className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              <span>Agent ID</span>
              <span className="text-foreground font-mono">{agent.id}</span>
              <span>Runtime</span>
              <span className="text-foreground capitalize">{agent.runtime}</span>
              <span>Active revision</span>
              <span className="text-foreground font-mono">
                #{agent.active_revision?.number ?? agent.revision ?? 1}
              </span>
              <span>Created</span>
              <span className="text-foreground">
                {new Date(agent.created_at).toLocaleString()}
              </span>
            </div>

            <div className="space-y-5 border-t pt-5">
              {/* Model — autosaves */}
              <Field label="Model" htmlFor="agent-model">
                <div className="flex items-center gap-3">
                  <Select
                    id="agent-model"
                    value={agent.model}
                    onValueChange={(m) => modelMutation.mutate(m)}
                    options={modelOptions}
                    className="max-w-xs"
                  />
                  <Saving show={modelMutation.isPending} />
                </div>
              </Field>

              {/* Prompt — draft with Save/Discard */}
              <Field label="System prompt" htmlFor="agent-prompt">
                <Textarea
                  id="agent-prompt"
                  value={promptValue}
                  onChange={(e) => setPromptDraft(e.target.value)}
                  placeholder="You are a meticulous code reviewer…"
                  className="min-h-32"
                />
                <div className="mt-2 flex items-center gap-3">
                  <p className="text-muted-foreground text-xs">
                    How the agent behaves. Saving bumps the agent's revision.
                  </p>
                  <div className="ml-auto flex items-center gap-2">
                    <Saving show={promptMutation.isPending} />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!promptDirty || promptMutation.isPending}
                      onClick={() => setPromptDraft(undefined)}
                    >
                      Discard
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={
                        !promptDirty ||
                        promptMutation.isPending ||
                        !promptValue.trim()
                      }
                      onClick={() => promptMutation.mutate(promptValue.trim())}
                    >
                      Save prompt
                    </Button>
                  </div>
                </div>
              </Field>

              {/* Credential — switch (autosaves) or create new inline */}
              <Field
                label="Credential"
                htmlFor="agent-cred"
                description="Which credential this agent runs on. To change a key's value, rotate it on the Credentials page."
              >
                <div className="flex items-center gap-3">
                  <Select
                    id="agent-cred"
                    value={credSelectValue}
                    onValueChange={onCredChange}
                    options={credOptions}
                    className="max-w-md"
                  />
                  <Saving show={credSaving} />
                </div>
                {credNew ? (
                  <div className="border-border bg-panel-2 mt-3 grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2">
                    <Field label="Credential name" htmlFor="new-cred-name">
                      <Input
                        id="new-cred-name"
                        value={newCredName}
                        onChange={(e) => setNewCredName(e.target.value)}
                        placeholder="e.g. Production"
                      />
                    </Field>
                    <Field
                      label={rt.keyLabel}
                      htmlFor="new-cred-key"
                      description="Encrypted in a dedicated secret store."
                    >
                      <Input
                        id="new-cred-key"
                        type="password"
                        value={newCredKey}
                        onChange={(e) => setNewCredKey(e.target.value)}
                        placeholder={rt.keyPlaceholder}
                      />
                    </Field>
                    <div className="flex justify-end gap-2 sm:col-span-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setCredNew(false)
                          setNewCredName('')
                          setNewCredKey('')
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={
                          !newCredKey.trim() || addCredMutation.isPending
                        }
                        onClick={() => addCredMutation.mutate()}
                      >
                        {addCredMutation.isPending ? 'Adding…' : 'Add & use'}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </Field>
            </div>
          </Panel>

          {/* Slack — kept above Sessions so it's visible without scrolling */}
          <SlackConnect agentId={agent.id} agentName={agent.name} />

          {/* Skills — current files + upload-a-zip to deploy a new revision */}
          <AgentSkills agentId={agent.id} />

          {/* Revisions — deploy history + active pointer + rollback */}
          <AgentRevisions agentId={agent.id} />

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
                <ChatTextarea
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  onSend={() => {
                    if (task.trim() && !startMutation.isPending) {
                      startMutation.mutate()
                    }
                  }}
                  placeholder="Give this agent a task — it runs durably as a new session…"
                  className="min-h-20"
                />
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    size="sm"
                    title="Enter to start · Shift+Enter for newline"
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

// Subtle inline "Saving…" shown while an autosave is in flight.
function Saving({ show }: { show: boolean }) {
  if (!show) return null
  return <span className="text-muted-foreground text-xs">Saving…</span>
}
