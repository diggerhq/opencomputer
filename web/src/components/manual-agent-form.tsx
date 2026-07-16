import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { createAgent, createCredential, getCredentials } from '@/api/client'
import { Field, Input, Select, Textarea } from '@/components/form'
import { Button } from '@/components/ui/button'
import { notifyError } from '@/lib/errors'
import {
  DEFAULT_RUNTIME,
  defaultModelFor,
  getRuntime,
  keyFieldFor,
  providerForModel,
  runtimeOptions,
  withModelGroups,
} from '@/lib/runtimes'

const NEW_CRED = '__new__'
const MANAGED = 'managed'

const NAME_ADJECTIVES = [
  'swift',
  'calm',
  'bright',
  'clever',
  'bold',
  'quiet',
  'keen',
  'brave',
  'nimble',
  'sunny',
  'lucid',
  'witty',
  'deft',
  'mellow',
  'crisp',
  'vivid',
]
const NAME_NOUNS = [
  'otter',
  'harbor',
  'falcon',
  'cedar',
  'comet',
  'delta',
  'ember',
  'fjord',
  'grove',
  'heron',
  'lynx',
  'maple',
  'nova',
  'quartz',
  'sparrow',
  'willow',
]

function randomAgentName(): string {
  const pick = (items: readonly string[]) =>
    items[Math.floor(Math.random() * items.length)]
  return `${pick(NAME_ADJECTIVES)}-${pick(NAME_NOUNS)}`
}

const DEFAULT_PROMPT =
  'You are a helpful AI assistant working in a sandboxed computer. Complete tasks end to end, use the tools available to you, and keep your answers clear and concise. When something is ambiguous, make a sensible assumption and say so.'

export function ManualAgentForm({ onCancel }: { onCancel: () => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data: credentials } = useQuery({
    queryKey: ['credentials'],
    queryFn: getCredentials,
  })
  const [name, setName] = useState(randomAgentName)
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [runtime, setRuntime] = useState(DEFAULT_RUNTIME)
  const [model, setModel] = useState(defaultModelFor(DEFAULT_RUNTIME))
  const [credChoice, setCredChoice] = useState('')
  const [newCredName, setNewCredName] = useState('')
  const [newCredKey, setNewCredKey] = useState('')

  const rt = getRuntime(runtime)
  const provider = providerForModel(model) || rt.provider
  const keyField = keyFieldFor(provider)
  const providerCreds = (credentials ?? []).filter(
    (credential) => credential.provider === provider,
  )
  const hasDefault = providerCreds.some((credential) => credential.is_default)

  const defaultCredFor = (available: typeof providerCreds) =>
    available.find((credential) => credential.is_default)?.id ?? MANAGED
  const selectedCredChoice = credChoice || defaultCredFor(providerCreds)

  const onRuntimeChange = (value: string) => {
    setRuntime(value)
    const nextModel = defaultModelFor(value)
    setModel(nextModel)
    setCredChoice(
      defaultCredFor(
        (credentials ?? []).filter(
          (credential) => credential.provider === providerForModel(nextModel),
        ),
      ),
    )
    setNewCredName('')
    setNewCredKey('')
  }

  const onModelChange = (value: string) => {
    setModel(value)
    const nextProvider = providerForModel(value)
    if (nextProvider !== provider) {
      setCredChoice(
        defaultCredFor(
          (credentials ?? []).filter(
            (credential) => credential.provider === nextProvider,
          ),
        ),
      )
      setNewCredName('')
      setNewCredKey('')
    }
  }

  const credOptions = [
    { value: MANAGED, label: 'Managed · no key needed' },
    ...providerCreds.map((credential) => ({
      value: credential.id,
      label: `${credential.name || 'Unnamed'}${
        credential.last4 ? ` ·· ${credential.last4}` : ''
      }${credential.is_default ? ' (default)' : ''}`,
    })),
    { value: NEW_CRED, label: '＋ New credential…' },
  ]

  const createMutation = useMutation({
    mutationFn: async () => {
      let credentialId: string | undefined
      if (selectedCredChoice === MANAGED) {
        credentialId = MANAGED
      } else if (selectedCredChoice === NEW_CRED) {
        const credential = await createCredential({
          key: newCredKey.trim(),
          provider,
          name: newCredName.trim() || undefined,
          is_default: !hasDefault,
        })
        credentialId = credential.id
      } else if (selectedCredChoice) {
        credentialId = selectedCredChoice
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
      setNewCredKey('')
      void navigate(`/agents/${agent.id}/setup`)
    },
    onError: (error) => notifyError("Couldn't create the agent.", error),
  })

  const canCreate =
    name.trim().length > 0 &&
    prompt.trim().length > 0 &&
    (selectedCredChoice !== NEW_CRED || newCredKey.trim().length > 0)

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (canCreate) createMutation.mutate()
      }}
    >
      <Field label="Name" htmlFor="agent-name">
        <Input
          id="agent-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
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
          onChange={(event) => setPrompt(event.target.value)}
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
          selectedCredChoice === MANAGED
            ? 'Run via OpenComputer, billed to your credits. No key needed.'
            : `The ${provider} key this agent runs on (matches the model). Reuse one from Credentials, or add a new one here.`
        }
      >
        <Select
          key={provider}
          id="agent-cred"
          value={selectedCredChoice}
          onValueChange={setCredChoice}
          options={credOptions}
          placeholder="Choose a credential"
        />
      </Field>
      {selectedCredChoice === NEW_CRED ? (
        <div className="border-border bg-panel-2 grid grid-cols-1 gap-4 rounded-md border p-3 sm:grid-cols-2">
          <Field label="Credential name" htmlFor="new-cred-name">
            <Input
              id="new-cred-name"
              value={newCredName}
              onChange={(event) => setNewCredName(event.target.value)}
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
              onChange={(event) => setNewCredKey(event.target.value)}
              placeholder={keyField.keyPlaceholder}
            />
          </Field>
        </div>
      ) : null}
      <div className="flex flex-col-reverse justify-end gap-2 pt-2 sm:flex-row">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setNewCredKey('')
            onCancel()
          }}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={createMutation.isPending || !canCreate}>
          {createMutation.isPending ? 'Creating…' : 'Create agent'}
        </Button>
      </div>
    </form>
  )
}
