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
  runtimeOptions,
} from '@/lib/runtimes'

// Sentinel for the "create one inline" choice in the credential picker. The model
// list + credential provider both follow the chosen runtime (see @/lib/runtimes).
const NEW_CRED = '__new__'

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

  // Everything model/credential-related follows the chosen runtime
  // (claude→anthropic, codex→openai): the model list, the credential provider it
  // filters to, and the key label.
  const rt = getRuntime(runtime)
  const providerCreds = (credentials ?? []).filter(
    (c) => c.provider === rt.provider,
  )
  const hasDefault = providerCreds.some((c) => c.is_default)

  // Lowest-friction default for a provider's creds: org default → first → "new".
  const defaultCredFor = (creds: typeof providerCreds) =>
    creds.find((c) => c.is_default)?.id ?? creds[0]?.id ?? NEW_CRED

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
    setCredChoice(defaultCredFor(providerCreds))
    setShowCreate(true)
  }

  // Switching runtime resets the dependent fields so we never submit an invalid
  // (runtime, model) pair or an off-provider credential.
  const onRuntimeChange = (value: string) => {
    setRuntime(value)
    const next = getRuntime(value)
    setModel(next.models[0].value)
    setCredChoice(
      defaultCredFor(
        (credentials ?? []).filter((c) => c.provider === next.provider),
      ),
    )
    setNewCredName('')
    setNewCredKey('')
  }

  // Build options: this runtime's provider creds + "New credential…".
  const credOptions = [
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
      if (credChoice === NEW_CRED) {
        const cred = await createCredential({
          key: newCredKey.trim(),
          provider: rt.provider,
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
      header: 'Revision',
      align: 'right',
      cell: (a) => (
        <span className="text-muted-foreground font-mono text-xs">
          {a.revision ?? 1}
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
                description="The engine this agent runs on. Fixed once created."
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
                description={`Models available on the ${rt.label} runtime.`}
              >
                <Select
                  id="agent-model"
                  value={model}
                  onValueChange={setModel}
                  options={rt.models}
                />
              </Field>
            </div>
            <Field
              label="Credential"
              htmlFor="agent-cred"
              description={`The ${rt.provider} key this agent runs on (matches the runtime). Reuse one from Credentials, or add a new one here.`}
            >
              <Select
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
