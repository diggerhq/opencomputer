import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, MessagesSquare, Send, GitBranch, Rocket } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import {
  getAgent,
  updateAgent,
  getSessions,
  createSession,
  getCredentials,
  createCredential,
  getAgentDeploys,
  getDeploymentSource,
  type Agent,
  type AgentDeploy,
} from '@/api/client'
import type { Session } from '@/api/schemas'
import {
  Panel,
  PanelContent,
  PanelFooter,
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
import { AgentDeploySource } from '@/components/agent-deploy-source'
import { AgentRevisions } from '@/components/agent-revisions'
import { getRuntime } from '@/lib/runtimes'

// Sentinels for the non-credential choices in the picker.
const ORG_DEFAULT = '__default__' // no pinned credential → org default resolves
const NEW_CRED = '__new__' // create one inline
const MANAGED = 'managed' // run via OpenComputer, no BYO key (token-billing §6.6)

type Tab = 'overview' | 'deployments' | 'sessions'

export default function AgentDetail() {
  const { agentId = '', tab } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const active: Tab =
    tab === 'deployments' ? 'deployments' : tab === 'sessions' ? 'sessions' : 'overview'

  const {
    data: agent,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['agent', agentId],
    queryFn: () => getAgent(agentId),
    enabled: !!agentId,
  })

  // This agent's sessions — filtered server-side.
  const { data: sessions = [], isLoading: loadingSessions } = useQuery({
    queryKey: ['sessions', { agent: agentId }],
    queryFn: () => getSessions({ agent: agentId }),
  })

  // The deployment-source link (shared cache key with the GitHub card). null = not linked.
  // When linked, the repo is the source of truth, so the inline editor goes read-only.
  const { data: source } = useQuery({
    queryKey: ['agent-deploy-source', agentId],
    queryFn: async () => {
      try {
        return (await getDeploymentSource(agentId)).source
      } catch {
        return null
      }
    },
  })

  // Credentials for the switch picker + to label the current one.
  const { data: credentials } = useQuery({
    queryKey: ['credentials'],
    queryFn: getCredentials,
  })
  const rt = getRuntime(agent?.runtime)
  const providerCreds = (credentials ?? []).filter((c) => c.provider === rt.provider)
  const credLabel = (id: string) => {
    const c = providerCreds.find((x) => x.id === id)
    if (!c) return id
    return `${c.name || 'Unnamed'}${c.last4 ? ` ·· ${c.last4}` : ''}${
      c.is_default ? ' (default)' : ''
    }`
  }

  // ── Start a session (used by the Sessions tab composer) ────────────────────
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

  // ── Live config controls ───────────────────────────────────────────────────
  const settleAgent = () => {
    void queryClient.invalidateQueries({ queryKey: ['agent', agentId] })
    void queryClient.invalidateQueries({ queryKey: ['agents'] })
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
    onSuccess: () => setPromptDraft(undefined),
    onSettled: settleAgent,
  })

  const switchCredMutation = useMutation({
    mutationFn: (credential: string | null) => updateAgent(agentId, { credential }),
    onMutate: (credential) => optimistic({ credential_id: credential }),
    onError: (e, _v, prev) => {
      rollback(prev)
      notifyError("Couldn't switch the credential.", e)
    },
    onSettled: settleAgent,
  })

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
  const credSelectValue = credNew ? NEW_CRED : (agent?.credential_id ?? ORG_DEFAULT)
  const credOptions = [
    { value: ORG_DEFAULT, label: 'Org default (no pinned credential)' },
    { value: MANAGED, label: 'Managed · no key needed' },
    ...providerCreds.map((c) => ({ value: c.id, label: credLabel(c.id) })),
    { value: NEW_CRED, label: '＋ New credential…' },
  ]
  const onCredChange = (v: string) => {
    if (v === NEW_CRED) {
      setCredNew(true)
      return
    }
    setCredNew(false)
    switchCredMutation.mutate(v === ORG_DEFAULT ? null : v)
  }

  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl">
        <BackLink />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (isError || !agent) {
    return (
      <div className="mx-auto max-w-5xl">
        <BackLink />
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
      </div>
    )
  }

  const activeRev = agent.active_revision?.number ?? agent.revision ?? 1
  const base = `/agents/${agent.id}`

  return (
    <div className="mx-auto max-w-5xl">
      <BackLink />

      {/* Sticky header: identity + status + primary action, with the tab bar. */}
      <div className="bg-background sticky top-0 z-20 border-b">
        <div className="flex flex-wrap items-start justify-between gap-3 pb-3">
          <div className="min-w-0 space-y-1.5">
            <h1 className="text-foreground truncate text-lg font-semibold">{agent.name}</h1>
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="font-mono">{agent.id}</span>
              <span className="capitalize">{agent.runtime}</span>
              <span className="font-mono">rev #{activeRev}</span>
              <SourceChip source={source ?? null} />
            </div>
          </div>
          <Button asChild size="sm">
            <Link to={`${base}/sessions`}>
              <Send className="size-4" />
              New session
            </Link>
          </Button>
        </div>
        <nav className="-mb-px flex gap-1">
          <TabLink to={base} label="Overview" current={active === 'overview'} />
          <TabLink to={`${base}/deployments`} label="Deployments" current={active === 'deployments'} />
          <TabLink to={`${base}/sessions`} label="Sessions" current={active === 'sessions'} />
        </nav>
      </div>

      <div className="py-6">
        {active === 'overview' && (
          <div className="space-y-6">
            <div className="grid gap-4 lg:grid-cols-2">
              {/* Behavior — full width. Read-only when a repo drives the agent. */}
              <Panel className="lg:col-span-2">
                <PanelHeader>
                  <PanelTitle>Behavior</PanelTitle>
                  <span className="text-muted-foreground text-xs">
                    Editing the model or prompt creates a new revision.
                  </span>
                </PanelHeader>
                <PanelContent className="space-y-5">
                  {source ? (
                    <div className="space-y-4">
                      <div className="border-border bg-panel-2 flex items-start gap-2 rounded-md border px-3 py-2.5 text-xs">
                        <GitBranch className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                        <div className="space-y-0.5">
                          <p className="text-foreground">
                            Managed from a connected repo —{' '}
                            <span className="font-mono">
                              {source.path || 'root'}@{source.production_ref}
                            </span>
                          </p>
                          <p className="text-muted-foreground">
                            The repo is the source of truth. Edit there and push; or{' '}
                            <Link className="underline underline-offset-4" to={`${base}/deployments`}>
                              manage deployments
                            </Link>
                            .
                          </p>
                        </div>
                      </div>
                      <ReadOnlyField label="Model" value={agent.model} mono />
                      <ReadOnlyField label="System prompt" value={savedPrompt || '—'} pre />
                    </div>
                  ) : (
                    <>
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
                                !promptDirty || promptMutation.isPending || !promptValue.trim()
                              }
                              onClick={() => promptMutation.mutate(promptValue.trim())}
                            >
                              Save prompt
                            </Button>
                          </div>
                        </div>
                      </Field>
                    </>
                  )}
                </PanelContent>
              </Panel>

              {/* Deploy from GitHub + Skills */}
              <AgentDeploySource agentId={agent.id} />
              <AgentSkills agentId={agent.id} />

              {/* Recent activity — brief, linking to the full tabs */}
              <RecentDeploys agentId={agent.id} base={base} />
              <RecentSessions
                sessions={sessions}
                loading={loadingSessions}
                base={base}
              />
            </div>

            {/* Settings — the lower section of Overview (no separate tab). */}
            <section className="space-y-4">
              <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                Settings
              </h2>
              <div className="grid gap-4 lg:grid-cols-2">
                <Panel>
                  <PanelHeader>
                    <PanelTitle>Credential</PanelTitle>
                    <span className="text-muted-foreground text-xs">
                      Which key this agent runs on.
                    </span>
                  </PanelHeader>
                  <PanelContent className="space-y-3">
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
                            disabled={!newCredKey.trim() || addCredMutation.isPending}
                            onClick={() => addCredMutation.mutate()}
                          >
                            {addCredMutation.isPending ? 'Adding…' : 'Add & use'}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    <p className="text-muted-foreground text-xs">
                      To change a key's value, rotate it on the Credentials page.
                    </p>
                  </PanelContent>
                </Panel>

                <SlackConnect agentId={agent.id} agentName={agent.name} />
              </div>

              {/* Limits (read-only — editing isn't supported via the API yet). */}
              <Panel>
                <PanelHeader>
                  <PanelTitle>Limits</PanelTitle>
                </PanelHeader>
                <PanelContent>
                  <Limits limits={agent.limits} />
                </PanelContent>
              </Panel>
            </section>
          </div>
        )}

        {active === 'deployments' && (
          <div className="space-y-6">
            <DeployHistory agentId={agent.id} />
            <AgentRevisions agentId={agent.id} />
          </div>
        )}

        {active === 'sessions' && (
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
                    if (task.trim() && !startMutation.isPending) startMutation.mutate()
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
        )}
      </div>
    </div>
  )
}

// ── Small building blocks ─────────────────────────────────────────────────────

function BackLink() {
  return (
    <Link
      to="/agents"
      className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-1.5 text-sm"
    >
      <ArrowLeft className="size-4" />
      Agents
    </Link>
  )
}

function TabLink({ to, label, current }: { to: string; label: string; current: boolean }) {
  return (
    <Link
      to={to}
      aria-current={current ? 'page' : undefined}
      className={
        'border-b-2 px-3 py-2 text-sm transition-colors ' +
        (current
          ? 'border-foreground text-foreground font-medium'
          : 'text-muted-foreground hover:text-foreground border-transparent')
      }
    >
      {label}
    </Link>
  )
}

function SourceChip({ source }: { source: { path: string; production_ref: string } | null }) {
  if (!source) {
    return <span className="text-muted-foreground/70">no repo connected</span>
  }
  return (
    <span className="inline-flex items-center gap-1">
      <GitBranch className="size-3" />
      <span className="font-mono">
        {source.path || 'root'}@{source.production_ref}
      </span>
    </span>
  )
}

function Saving({ show }: { show: boolean }) {
  if (!show) return null
  return <span className="text-muted-foreground text-xs">Saving…</span>
}

function ReadOnlyField({
  label,
  value,
  mono,
  pre,
}: {
  label: string
  value: string
  mono?: boolean
  pre?: boolean
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-foreground text-sm font-medium">{label}</div>
      {pre ? (
        <pre className="text-muted-foreground max-h-40 overflow-auto whitespace-pre-wrap text-xs">
          {value}
        </pre>
      ) : (
        <div className={'text-muted-foreground text-sm' + (mono ? ' font-mono' : '')}>{value}</div>
      )}
    </div>
  )
}

function Limits({ limits }: { limits?: Record<string, unknown> | null }) {
  const entries = Object.entries(limits ?? {})
  if (entries.length === 0) {
    return <p className="text-muted-foreground text-xs">Org defaults apply.</p>
  }
  return (
    <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="capitalize">{k.replace(/_/g, ' ')}</dt>
          <dd className="text-foreground font-mono">{String(v)}</dd>
        </div>
      ))}
    </dl>
  )
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

const deployVia = (d: AgentDeploy) =>
  (d.source && typeof d.source.via === 'string' && d.source.via) || 'api'
const deploySha = (d: AgentDeploy) => {
  const s = d.source && typeof d.source.git_sha === 'string' ? d.source.git_sha : null
  return s ? s.slice(0, 7) : null
}

// Compact "Recent deployments" card for the Overview dashboard.
function RecentDeploys({ agentId, base }: { agentId: string; base: string }) {
  const { data: deploys = [], isLoading } = useQuery({
    queryKey: ['agent-deploys', agentId],
    queryFn: () => getAgentDeploys(agentId),
  })
  const recent = deploys.slice(0, 3)
  return (
    <Panel className="flex flex-col">
      <PanelHeader>
        <PanelTitle>Recent deployments</PanelTitle>
      </PanelHeader>
      <PanelContent className="flex-1 space-y-2">
        {isLoading ? (
          <p className="text-muted-foreground text-xs">Loading…</p>
        ) : recent.length === 0 ? (
          <p className="text-muted-foreground text-xs">No deployments yet.</p>
        ) : (
          recent.map((d) => (
            <div key={d.id} className="flex items-center gap-2 text-xs">
              <StatusBadge status={d.state} />
              <span className="text-muted-foreground capitalize">{deployVia(d)}</span>
              {deploySha(d) ? (
                <span className="text-muted-foreground font-mono">{deploySha(d)}</span>
              ) : null}
              <span className="text-muted-foreground ml-auto">{timeAgo(d.created_at)}</span>
            </div>
          ))
        )}
      </PanelContent>
      <PanelFooter className="justify-end">
        <Link
          to={`${base}/deployments`}
          className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
        >
          View all deployments →
        </Link>
      </PanelFooter>
    </Panel>
  )
}

// Compact "Recent sessions" card for the Overview dashboard.
function RecentSessions({
  sessions,
  loading,
  base,
}: {
  sessions: Session[]
  loading: boolean
  base: string
}) {
  const recent = sessions.slice(0, 3)
  return (
    <Panel className="flex flex-col">
      <PanelHeader>
        <PanelTitle>Recent sessions</PanelTitle>
      </PanelHeader>
      <PanelContent className="flex-1 space-y-2">
        {loading ? (
          <p className="text-muted-foreground text-xs">Loading…</p>
        ) : recent.length === 0 ? (
          <p className="text-muted-foreground text-xs">No sessions yet.</p>
        ) : (
          recent.map((s) => (
            <div key={s.id} className="flex items-center gap-2 text-xs">
              <StatusBadge status={s.status} />
              <Link
                to={`/sessions/${s.id}`}
                className="text-foreground truncate font-mono underline-offset-4 hover:underline"
              >
                {s.id}
              </Link>
              <span className="text-muted-foreground ml-auto">{timeAgo(s.created_at)}</span>
            </div>
          ))
        )}
      </PanelContent>
      <PanelFooter className="justify-between">
        <Link
          to={`${base}/sessions`}
          className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
        >
          View all sessions →
        </Link>
        <Button asChild size="xs" variant="ghost">
          <Link to={`${base}/sessions`}>
            <Send className="size-3.5" />
            New
          </Link>
        </Button>
      </PanelFooter>
    </Panel>
  )
}

// Full deploy-history table for the Deployments tab.
function DeployHistory({ agentId }: { agentId: string }) {
  const { data: deploys = [], isLoading } = useQuery({
    queryKey: ['agent-deploys', agentId],
    queryFn: () => getAgentDeploys(agentId),
  })
  const columns: Column<AgentDeploy>[] = [
    { key: 'state', header: 'State', cell: (d) => <StatusBadge status={d.state} /> },
    {
      key: 'via',
      header: 'Source',
      cell: (d) => <span className="text-muted-foreground text-xs capitalize">{deployVia(d)}</span>,
    },
    {
      key: 'sha',
      header: 'Commit',
      cell: (d) => (
        <span className="text-muted-foreground font-mono text-xs">{deploySha(d) ?? '—'}</span>
      ),
    },
    {
      key: 'result',
      header: 'Result',
      cell: (d) => <span className="text-muted-foreground text-xs">{d.result ?? '—'}</span>,
    },
    {
      key: 'created',
      header: 'When',
      cell: (d) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(d.created_at).toLocaleString()}
        </span>
      ),
    },
  ]
  return (
    <Panel className="overflow-hidden">
      <PanelHeader>
        <PanelTitle>Deployments</PanelTitle>
        <span className="text-muted-foreground text-xs">
          Every deploy (inline or from GitHub) and its outcome.
        </span>
      </PanelHeader>
      <ResourceTable
        columns={columns}
        rows={deploys}
        rowKey={(d) => d.id}
        loading={isLoading}
        empty={
          <EmptyState
            icon={Rocket}
            title="No deployments yet"
            description="Edit the behavior, deploy a directory, or connect a repo to create one."
          />
        }
      />
    </Panel>
  )
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
  { key: 'status', header: 'Status', cell: (s) => <StatusBadge status={s.status} /> },
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
