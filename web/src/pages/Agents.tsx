import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Bot, Plus } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import {
  getAgents,
  createAgent,
  getCredentials,
  createCredential,
  type Agent,
} from '@/api/client'
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
import { Field, Input, Select, Textarea } from '@/components/form'
import { EmptyState } from '@/components/empty-state'
import { ResourceTable, type Column } from '@/components/resource-table'
import {
  DEFAULT_RUNTIME,
  defaultModelFor,
  getRuntime,
  keyFieldFor,
  providerForModel,
  runtimeOptions,
  withModelGroups,
} from '@/lib/runtimes'

// Sentinels for the non-credential choices in the credential picker. The model
// list + credential provider both follow the chosen runtime (see @/lib/runtimes).
const NEW_CRED = '__new__'
// "Managed" model access: run via OpenComputer with no BYO key. Billing varies by org
// (Autumn → credits; otherwise a fixed OpenRouter key cap), so the label stays neutral.
// Sent to the API as the reserved credential value "managed" (token-billing §6.6).
const MANAGED = 'managed'

// Friendly starting defaults so "Create agent" works with a single click: a memorable
// random name (adjective-noun) + a usable general-purpose prompt the user can keep or edit.
const NAME_ADJECTIVES = [
  'swift', 'calm', 'bright', 'clever', 'bold', 'quiet', 'keen', 'brave',
  'nimble', 'sunny', 'lucid', 'witty', 'deft', 'mellow', 'crisp', 'vivid',
]
const NAME_NOUNS = [
  'otter', 'harbor', 'falcon', 'cedar', 'comet', 'delta', 'ember', 'fjord',
  'grove', 'heron', 'lynx', 'maple', 'nova', 'quartz', 'sparrow', 'willow',
]
function randomAgentName(): string {
  const pick = (a: readonly string[]) => a[Math.floor(Math.random() * a.length)]
  return `${pick(NAME_ADJECTIVES)}-${pick(NAME_NOUNS)}`
}
const DEFAULT_PROMPT =
  'You are a helpful AI assistant working in a sandboxed computer. Complete tasks end to end, use the tools available to you, and keep your answers clear and concise. When something is ambiguous, make a sensible assumption and say so.'

export default function Agents() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: agents, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: getAgents,
  })
  // Credentials for the picker (so creating an agent doesn't need a fresh key each time).
  const { data: credentials } = useQuery({
    queryKey: ['credentials'],
    queryFn: getCredentials,
  })
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [runtime, setRuntime] = useState(DEFAULT_RUNTIME)
  const [model, setModel] = useState(defaultModelFor(DEFAULT_RUNTIME))
  // Credential selection: a credential id or NEW_CRED (create inline). '' is
  // resolved to a sensible default on dialog open.
  const [credChoice, setCredChoice] = useState('')
  const [newCredName, setNewCredName] = useState('')
  const [newCredKey, setNewCredKey] = useState('')

  // The model list follows the runtime; the credential provider + key field follow
  // the selected MODEL's provider prefix. For claude/codex that prefix always equals
  // the runtime's provider; for pi it varies by model, which is what makes pi work.
  const rt = getRuntime(runtime)
  const provider = providerForModel(model) || rt.provider
  const keyField = keyFieldFor(provider)
  const providerCreds = (credentials ?? []).filter(
    (c) => c.provider === provider,
  )
  const hasDefault = providerCreds.some((c) => c.is_default)

  // Lowest-friction default, mirroring backend resolution (token-billing §6.6):
  // a BYO org default wins; else Managed (always available to every org).
  const defaultCredFor = (creds: typeof providerCreds) =>
    creds.find((c) => c.is_default)?.id ?? MANAGED

  const resetForm = () => {
    setName('')
    setPrompt('')
    setRuntime(DEFAULT_RUNTIME)
    setModel(defaultModelFor(DEFAULT_RUNTIME))
    setCredChoice('')
    setNewCredName('')
    setNewCredKey('')
  }

  const openCreate = () => {
    // Pre-fill so the form is submittable immediately — a fresh random name each open.
    setName(randomAgentName())
    setPrompt(DEFAULT_PROMPT)
    setCredChoice(defaultCredFor(providerCreds))
    setShowCreate(true)
  }

  // Switching runtime resets the dependent fields so we never submit an invalid
  // (runtime, model) pair or an off-provider credential.
  const onRuntimeChange = (value: string) => {
    setRuntime(value)
    const next = getRuntime(value)
    const nextModel = next.models[0].value
    setModel(nextModel)
    setCredChoice(
      defaultCredFor(
        (credentials ?? []).filter(
          (c) => c.provider === providerForModel(nextModel),
        ),
      ),
    )
    setNewCredName('')
    setNewCredKey('')
  }

  // Changing the model can change the provider (pi spans providers) — re-point the
  // credential fields at the new provider so we never submit an off-provider key.
  const onModelChange = (value: string) => {
    setModel(value)
    const nextProvider = providerForModel(value)
    if (nextProvider !== provider) {
      setCredChoice(
        defaultCredFor(
          (credentials ?? []).filter((c) => c.provider === nextProvider),
        ),
      )
      setNewCredName('')
      setNewCredKey('')
    }
  }

  // Build options: Managed (always offered, no provider — runs without a BYO key) +
  // this runtime's provider creds + "New credential…".
  const credOptions = [
    { value: MANAGED, label: 'Managed · no key needed' },
    ...providerCreds.map((c) => ({
      value: c.id,
      label: `${c.name || 'Unnamed'}${c.last4 ? ` ·· ${c.last4}` : ''}${
        c.is_default ? ' (default)' : ''
      }`,
    })),
    { value: NEW_CRED, label: '＋ New credential…' },
  ]

  const createMutation = useMutation({
    mutationFn: async () => {
      // Resolve the agent's credential without leaving the dialog:
      //  - NEW_CRED → create the credential first, pin the new id.
      //  - else     → pin the chosen existing credential.
      let credentialId: string | undefined
      if (credChoice === MANAGED) {
        credentialId = MANAGED // run via OpenComputer, no BYO key
      } else if (credChoice === NEW_CRED) {
        const cred = await createCredential({
          key: newCredKey.trim(),
          provider: provider,
          name: newCredName.trim() || undefined,
          is_default: !hasDefault, // first key for this provider becomes its default
        })
        credentialId = cred.id
      } else if (credChoice) {
        credentialId = credChoice
      }
      return createAgent({
        name: name.trim(),
        prompt: prompt.trim(),
        model,
        runtime,
        credential: credentialId,
      })
    },
    onSuccess: (agent) => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      void queryClient.invalidateQueries({ queryKey: ['credentials'] })
      setShowCreate(false)
      resetForm()
      // Land on the new agent's screen, not back on the list.
      void navigate(`/agents/${agent.id}`)
    },
    onError: (e) => notifyError("Couldn't create the agent.", e),
  })

  const columns: Column<Agent>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (a) => (
        <span className="text-foreground font-medium">{a.name}</span>
      ),
    },
    {
      key: 'model',
      header: 'Model',
      cell: (a) => (
        <code className="text-muted-foreground font-mono text-xs">
          {a.model}
        </code>
      ),
    },
    {
      key: 'runtime',
      header: 'Runtime',
      cell: (a) => (
        <span className="text-muted-foreground text-xs capitalize">
          {a.runtime}
        </span>
      ),
    },
    {
      key: 'revision',
      header: 'Active revision',
      align: 'right',
      cell: (a) => (
        <span className="text-muted-foreground font-mono text-xs">
          #{a.active_revision?.number ?? a.revision ?? 1}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      cell: (a) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(a.created_at).toLocaleDateString()}
        </span>
      ),
    },
  ]

  const canCreate =
    name.trim().length > 0 &&
    prompt.trim().length > 0 &&
    (credChoice !== NEW_CRED || newCredKey.trim().length > 0)

  return (
    <div>
      <PageHeader
        title="Agents"
        description="Reusable definitions — a prompt, model, and runtime a session runs."
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
          rowKey={(a) => a.id}
          onRowClick={(a) => void navigate(`/agents/${a.id}`)}
          loading={isLoading}
          empty={
            <EmptyState
              icon={Bot}
              title="No agents yet"
              description="An agent is the reusable “what” — define it once, then start sessions from it."
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

      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          setShowCreate(open)
          if (!open) setNewCredKey('') // never leave a model key in state after close
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create agent</DialogTitle>
            <DialogDescription>
              A reusable definition. Sessions pin a snapshot of it at create
              time.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (canCreate) createMutation.mutate()
            }}
          >
            <Field label="Name" htmlFor="agent-name">
              <Input
                id="agent-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. PR Reviewer"
              />
            </Field>
            <Field
              label="Prompt"
              htmlFor="agent-prompt"
              description="The system prompt that defines how the agent behaves."
            >
              <Textarea
                id="agent-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="You are a meticulous code reviewer…"
                className="min-h-28"
              />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                label="Runtime"
                htmlFor="agent-runtime"
                description="The engine, fixed once created."
              >
                <Select
                  id="agent-runtime"
                  value={runtime}
                  onValueChange={onRuntimeChange}
                  options={runtimeOptions}
                />
              </Field>
              <Field
                label="Model"
                htmlFor="agent-model"
                description={`Models for the ${rt.label} runtime.`}
              >
                <Select
                  // Remount on runtime change: Radix Select.Value blanks out when
                  // its options and value change in the same render.
                  key={runtime}
                  id="agent-model"
                  value={model}
                  onValueChange={onModelChange}
                  options={withModelGroups(rt.models)}
                />
              </Field>
            </div>
            <Field
              label="Credential"
              htmlFor="agent-cred"
              description={
                credChoice === MANAGED
                  ? 'Run via OpenComputer, billed to your credits — no key needed.'
                  : `The ${provider} key this agent runs on (matches the model). Reuse one from Credentials, or add a new one here.`
              }
            >
              <Select
                key={provider}
                id="agent-cred"
                value={credChoice}
                onValueChange={setCredChoice}
                options={credOptions}
                placeholder="Choose a credential"
              />
            </Field>
            {credChoice === NEW_CRED ? (
              <div className="border-border bg-panel-2 grid grid-cols-1 gap-4 rounded-md border p-3 sm:grid-cols-2">
                <Field label="Credential name" htmlFor="new-cred-name">
                  <Input
                    id="new-cred-name"
                    value={newCredName}
                    onChange={(e) => setNewCredName(e.target.value)}
                    placeholder="e.g. Production"
                  />
                </Field>
                <Field
                  label={keyField.keyLabel}
                  htmlFor="new-cred-key"
                  description="Encrypted in a dedicated secret store."
                >
                  <Input
                    id="new-cred-key"
                    type="password"
                    value={newCredKey}
                    onChange={(e) => setNewCredKey(e.target.value)}
                    placeholder={keyField.keyPlaceholder}
                  />
                </Field>
              </div>
            ) : null}
            <DialogFooter className="mt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setShowCreate(false)
                  resetForm()
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={createMutation.isPending || !canCreate}
              >
                {createMutation.isPending ? 'Creating…' : 'Create agent'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
