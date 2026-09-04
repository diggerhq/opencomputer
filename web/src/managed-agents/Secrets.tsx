import { type FormEvent, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Loader2, Pencil, Trash2 } from 'lucide-react'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  deleteAgentRuntimeVariable,
  deleteManagedProjectSecret,
  getAgentRuntimeVariables,
  getManagedProjectSecrets,
  putAgentRuntimeVariable,
  putManagedProjectSecret,
  type ManagedProjectSecret,
} from './api'

type Environment = 'development' | 'production'

function parseOrigins(value: string) {
  return [...new Set(value.split(/[\s,]+/).map((part) => part.trim()))].filter(
    Boolean,
  )
}

export function ManagedProjectSecrets({
  projectId,
  agents,
  environment,
}: {
  projectId: string
  agents: Array<{ id: string; name: string }>
  environment: Environment
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [origins, setOrigins] = useState('')
  const [agentId, setAgentId] = useState('')
  const [editing, setEditing] = useState<ManagedProjectSecret | null>(null)
  const valueInput = useRef<HTMLInputElement>(null)
  const queryKey = ['managed-project-secrets', projectId, environment]
  const secrets = useQuery({
    queryKey,
    queryFn: () => getManagedProjectSecrets(projectId, environment),
  })
  const save = useMutation({
    mutationFn: putManagedProjectSecret,
    onSuccess: async () => {
      setName('')
      setValue('')
      setOrigins('')
      setAgentId('')
      setEditing(null)
      await queryClient.invalidateQueries({ queryKey })
      notifySuccess('Secret saved.', 'Its value remains write-only.')
    },
    onError: (error) => notifyError("Couldn't save the secret.", error),
  })
  const remove = useMutation({
    mutationFn: deleteManagedProjectSecret,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey })
      notifySuccess('Secret removed.')
    },
    onError: (error) => notifyError("Couldn't remove the secret.", error),
  })
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]))

  function edit(secret: ManagedProjectSecret) {
    setEditing(secret)
    setName(secret.name)
    setValue('')
    setOrigins(
      secret.allowedOrigins.includes('*')
        ? ''
        : secret.allowedOrigins.join(', '),
    )
    setAgentId(secret.agentId ?? '')
    requestAnimationFrame(() => valueInput.current?.focus())
  }

  function cancelEdit() {
    setEditing(null)
    setName('')
    setValue('')
    setOrigins('')
    setAgentId('')
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const normalizedName = name.trim().toUpperCase()
    const allowedOrigins = parseOrigins(origins)
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(normalizedName)) {
      notifyError(
        'Use an uppercase secret name containing only letters, numbers, and underscores.',
      )
      return
    }
    if (!value) {
      notifyError('Enter a secret value.')
      return
    }
    save.mutate({
      projectId,
      environment,
      ...(agentId ? { agentId } : {}),
      name: normalizedName,
      value,
      allowedOrigins: allowedOrigins.length ? allowedOrigins : ['*'],
    })
  }

  return (
    <div className="space-y-8">
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>
              {editing ? `Edit ${editing.name}` : 'Secrets'}
            </PanelTitle>
            <PanelDescription className="mt-1">
              Write-only values injected by the managed egress gateway for the
              selected environment. Values never enter agent runtimes or logs.
            </PanelDescription>
          </div>
          <span className="bg-muted rounded-md px-2 py-1 text-xs capitalize">
            {environment}
          </span>
        </PanelHeader>
        <PanelContent>
          <form onSubmit={submit} className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="secret-name">Name</Label>
              <Input
                id="secret-name"
                value={name}
                onChange={(event) => setName(event.target.value.toUpperCase())}
                placeholder="GITHUB_TOKEN"
                autoComplete="off"
                disabled={Boolean(editing)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="secret-scope">Scope</Label>
              <select
                id="secret-scope"
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
                disabled={Boolean(editing)}
                className="border-input bg-background h-8 w-full rounded-md border px-2.5 text-sm outline-none"
              >
                <option value="">Entire project</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    Agent: {agent.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="secret-value">Value</Label>
              <Input
                id="secret-value"
                ref={valueInput}
                type="password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="Enter a new value"
                autoComplete="new-password"
              />
              <p className="text-muted-foreground text-xs">
                Existing values cannot be viewed. Saving the same name and scope
                replaces its value.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="secret-origins">
                Allowed origins{' '}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="secret-origins"
                value={origins}
                onChange={(event) => setOrigins(event.target.value)}
                placeholder="https://api.example.com"
                autoComplete="off"
              />
              <p className="text-muted-foreground text-xs">
                Separate multiple HTTPS origins with commas. Paths are not
                allowed. Leave blank to allow every public HTTPS host.
              </p>
              {!origins.trim() ? (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  All hosts — not recommended. Prefer limiting this secret to
                  the external APIs that need it.
                </p>
              ) : null}
            </div>
            <div className="lg:col-span-2">
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <KeyRound />
                )}
                {editing ? 'Replace secret' : 'Save secret'}
              </Button>
              {editing ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="ml-2"
                  disabled={save.isPending}
                  onClick={cancelEdit}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>
        </PanelContent>
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader>
          <div>
            <PanelTitle>Configured secrets</PanelTitle>
            <PanelDescription className="mt-1">
              Only names, scopes, and allowed destinations are visible.
            </PanelDescription>
          </div>
        </PanelHeader>
        {secrets.isLoading ? (
          <PanelContent className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> Loading secrets…
          </PanelContent>
        ) : secrets.isError ? (
          <PanelContent className="space-y-3">
            <p className="text-muted-foreground text-sm">
              Secrets are temporarily unavailable.
            </p>
            <Button variant="outline" onClick={() => void secrets.refetch()}>
              Try again
            </Button>
          </PanelContent>
        ) : secrets.data?.length ? (
          <div className="divide-y">
            {secrets.data.map((secret) => (
              <div
                key={`${secret.environment}:${secret.agentId ?? 'project'}:${secret.name}`}
                className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(10rem,0.8fr)_minmax(10rem,0.8fr)_minmax(16rem,1.5fr)_auto] md:items-center"
              >
                <div>
                  <p className="font-mono text-sm font-medium">{secret.name}</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Updated {new Date(secret.updatedAt).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Scope</p>
                  <p className="mt-1 text-sm">
                    {secret.agentId
                      ? (agentNames.get(secret.agentId) ?? secret.agentId)
                      : 'Entire project'}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs">
                    Allowed origins
                  </p>
                  {secret.allowedOrigins.includes('*') ? (
                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                      All hosts — not recommended
                    </p>
                  ) : (
                    <p className="mt-1 truncate font-mono text-xs">
                      {secret.allowedOrigins.join(', ')}
                    </p>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={save.isPending || remove.isPending}
                    onClick={() => edit(secret)}
                  >
                    <Pencil /> Edit
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={save.isPending || remove.isPending}
                    onClick={() =>
                      remove.mutate({
                        projectId,
                        environment: secret.environment,
                        ...(secret.agentId ? { agentId: secret.agentId } : {}),
                        name: secret.name,
                      })
                    }
                  >
                    <Trash2 /> Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <PanelContent className="text-muted-foreground text-sm">
            No secrets configured for {environment}.
          </PanelContent>
        )}
      </Panel>
      <AgentRuntimeVariables
        projectId={projectId}
        agents={agents}
        environment={environment}
      />
    </div>
  )
}

function AgentRuntimeVariables({
  projectId,
  agents,
  environment,
}: {
  projectId: string
  agents: Array<{ id: string; name: string }>
  environment: Environment
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [agentId, setAgentId] = useState('')
  const queryKey = ['agent-runtime-variables', projectId, environment]
  const variables = useQuery({
    queryKey,
    queryFn: () => getAgentRuntimeVariables(projectId, environment),
  })
  const save = useMutation({
    mutationFn: putAgentRuntimeVariable,
    onSuccess: async () => {
      setName('')
      setValue('')
      await queryClient.invalidateQueries({ queryKey })
      notifySuccess(
        'Runtime variable saved.',
        'Newly started agent runtimes will receive it.',
      )
    },
    onError: (error) =>
      notifyError("Couldn't save the runtime variable.", error),
  })
  const remove = useMutation({
    mutationFn: deleteAgentRuntimeVariable,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey })
      notifySuccess('Runtime variable removed.')
    },
    onError: (error) =>
      notifyError("Couldn't remove the runtime variable.", error),
  })
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]))

  function submit(event: FormEvent) {
    event.preventDefault()
    const normalizedName = name.trim().toUpperCase()
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(normalizedName)) {
      notifyError(
        'Use an uppercase variable name containing only letters, numbers, and underscores.',
      )
      return
    }
    save.mutate({
      projectId,
      environment,
      ...(agentId ? { agentId } : {}),
      name: normalizedName,
      value,
    })
  }

  return (
    <section className="space-y-4">
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Agent runtime variables</PanelTitle>
            <PanelDescription className="mt-1 max-w-3xl">
              Environment variables injected directly into agent code, tools,
              commands, and subprocesses. Values are encrypted and masked here,
              but the running agent can read them through process.env.
            </PanelDescription>
          </div>
          <span className="bg-muted rounded-md px-2 py-1 text-xs capitalize">
            {environment}
          </span>
        </PanelHeader>
        <PanelContent>
          <form onSubmit={submit} className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="runtime-variable-name">Name</Label>
              <Input
                id="runtime-variable-name"
                value={name}
                onChange={(event) => setName(event.target.value.toUpperCase())}
                placeholder="DATABASE_URL"
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="runtime-variable-scope">Scope</Label>
              <select
                id="runtime-variable-scope"
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
                className="border-input bg-background h-8 w-full rounded-md border px-2.5 text-sm outline-none"
              >
                <option value="">Entire project</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    Agent: {agent.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2 lg:col-span-2">
              <Label htmlFor="runtime-variable-value">Value</Label>
              <Input
                id="runtime-variable-value"
                type="password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="Enter a new value"
                autoComplete="new-password"
              />
              <p className="text-muted-foreground text-xs">
                Existing values cannot be viewed. Saving the same name and scope
                replaces its value. Restart the agent runtime to apply changes.
              </p>
            </div>
            <div className="lg:col-span-2">
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <KeyRound />
                )}
                Save runtime variable
              </Button>
            </div>
          </form>
        </PanelContent>
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader>
          <div>
            <PanelTitle>Configured runtime variables</PanelTitle>
            <PanelDescription className="mt-1">
              Values stay masked in OpenComputer but are available inside the
              agent runtime.
            </PanelDescription>
          </div>
        </PanelHeader>
        {variables.isLoading ? (
          <PanelContent className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> Loading runtime
            variables…
          </PanelContent>
        ) : variables.isError ? (
          <PanelContent className="space-y-3">
            <p className="text-muted-foreground text-sm">
              Runtime variables are temporarily unavailable.
            </p>
            <Button variant="outline" onClick={() => void variables.refetch()}>
              Try again
            </Button>
          </PanelContent>
        ) : variables.data?.length ? (
          <div className="divide-y">
            {variables.data.map((variable) => (
              <div
                key={`${variable.environment}:${variable.agentId ?? 'project'}:${variable.name}`}
                className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)_auto] md:items-center"
              >
                <div>
                  <p className="font-mono text-sm font-medium">
                    {variable.name}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Updated {new Date(variable.updatedAt).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Scope</p>
                  <p className="mt-1 text-sm">
                    {variable.agentId
                      ? (agentNames.get(variable.agentId) ?? variable.agentId)
                      : 'Entire project'}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() =>
                    remove.mutate({
                      projectId,
                      environment: variable.environment,
                      ...(variable.agentId
                        ? { agentId: variable.agentId }
                        : {}),
                      name: variable.name,
                    })
                  }
                >
                  <Trash2 /> Remove
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <PanelContent className="text-muted-foreground text-sm">
            No runtime variables configured for {environment}.
          </PanelContent>
        )}
      </Panel>
    </section>
  )
}
