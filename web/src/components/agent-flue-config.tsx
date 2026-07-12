import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import {
  deleteFlueAgentSecret,
  getFlueAgentConfig,
  getFlueAgentSecrets,
  putFlueAgentConfig,
  putFlueAgentSecret,
  type FlueAgentConfig,
  type FlueAgentSecret,
} from '@/api/client'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Field, FieldError, Input, Textarea } from '@/components/form'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { notifyError, notifySuccess } from '@/lib/errors'
import { cn } from '@/lib/utils'

const BINDING_NAME = /^[A-Z][A-Z0-9_]{0,63}$/

type BindingRow = { id: string; name: string; value: string }

const bindingRows = (vars: Record<string, string>): BindingRow[] =>
  Object.entries(vars)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ id: crypto.randomUUID(), name, value }))

function normalizedHosts(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort()
}

function validHost(value: string): boolean {
  const host = value.startsWith('*.') ? value.slice(2) : value
  return (
    value.length <= 253 &&
    !value.includes('://') &&
    !value.includes('/') &&
    !value.includes(':') &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) &&
    host.includes('.')
  )
}

function payloadFor(rows: BindingRow[], egress: string) {
  const vars: Record<string, string> = {}
  for (const row of rows) {
    const name = row.name.trim()
    if (name) vars[name] = row.value
  }
  return { vars, egress_allowlist: normalizedHosts(egress) }
}

function configIssue(rows: BindingRow[], egress: string): string | null {
  const populated = rows.filter((row) => row.name.trim() || row.value)
  const names = populated.map((row) => row.name.trim())
  if (names.some((name) => !name)) return 'Every value needs a variable name.'
  const invalid = names.find(
    (name) =>
      !BINDING_NAME.test(name) ||
      name.startsWith('OC_') ||
      name.startsWith('FLUE_'),
  )
  if (invalid)
    return `${invalid} is invalid or reserved. Use uppercase letters, numbers, and underscores.`
  if (new Set(names).size !== names.length)
    return 'Variable names must be unique.'
  const badHost = normalizedHosts(egress).find((host) => !validHost(host))
  if (badHost) return `${badHost} is not a valid hostname.`
  return null
}

export function AgentFlueConfig({ agentId }: { agentId: string }) {
  const config = useQuery({
    queryKey: ['agent-flue-config', agentId],
    queryFn: () => getFlueAgentConfig(agentId),
  })
  const secrets = useQuery({
    queryKey: ['agent-flue-secrets', agentId],
    queryFn: () => getFlueAgentSecrets(agentId),
  })

  if (config.isLoading || secrets.isLoading) {
    return (
      <div className="space-y-6" aria-label="Loading Worker configuration">
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    )
  }

  return (
    <>
      {config.data ? (
        <ConfigEditor agentId={agentId} config={config.data} />
      ) : (
        <LoadFailure
          label="Worker configuration"
          retry={() => void config.refetch()}
        />
      )}
      {secrets.data ? (
        <SecretEditor agentId={agentId} secrets={secrets.data} />
      ) : (
        <LoadFailure
          label="Worker secrets"
          retry={() => void secrets.refetch()}
        />
      )}
    </>
  )
}

function ConfigEditor({
  agentId,
  config,
}: {
  agentId: string
  config: FlueAgentConfig
}) {
  const queryClient = useQueryClient()
  const [rows, setRows] = useState<BindingRow[]>(() => bindingRows(config.vars))
  const [egress, setEgress] = useState(() => config.egress_allowlist.join('\n'))
  const issue = configIssue(rows, egress)
  const payload = payloadFor(rows, egress)
  const current = payloadFor(
    bindingRows(config.vars),
    config.egress_allowlist.join('\n'),
  )
  const dirty = JSON.stringify(payload) !== JSON.stringify(current)

  const save = useMutation({
    mutationFn: () => putFlueAgentConfig(agentId, payload),
    onSuccess: (saved) => {
      queryClient.setQueryData(['agent-flue-config', agentId], saved)
      notifySuccess(
        'Worker configuration saved.',
        'Variables apply on the next deploy. Outbound policy updates shortly.',
      )
    },
    onError: (error) =>
      notifyError("Couldn't save Worker configuration.", error),
  })

  return (
    <Panel>
      <PanelHeader>
        <div className="space-y-1">
          <PanelTitle>Worker environment</PanelTitle>
          <PanelDescription>
            Non-secret bindings and the hosts this agent may call over HTTPS.
          </PanelDescription>
        </div>
      </PanelHeader>
      <PanelContent className="space-y-6">
        <section aria-labelledby="flue-vars-heading" className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <h3 id="flue-vars-heading" className="text-sm font-medium">
                Variables
              </h3>
              <p className="text-muted-foreground max-w-2xl text-xs">
                These values are readable configuration. Put credentials and
                tokens in Worker secrets below.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setRows((old) => [
                  ...old,
                  { id: crypto.randomUUID(), name: '', value: '' },
                ])
              }
            >
              <Plus aria-hidden />
              Add variable
            </Button>
          </div>

          {rows.length ? (
            <div className="space-y-2">
              {rows.map((row, index) => (
                <div
                  key={row.id}
                  className="flex flex-col gap-2 sm:flex-row sm:items-center"
                >
                  <Input
                    aria-label={`Variable ${index + 1} name`}
                    value={row.name}
                    onChange={(event) =>
                      setRows((old) =>
                        old.map((item) =>
                          item.id === row.id
                            ? {
                                ...item,
                                name: event.target.value.toUpperCase(),
                              }
                            : item,
                        ),
                      )
                    }
                    placeholder="VARIABLE_NAME"
                    className="font-mono sm:w-2/5"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <Input
                    aria-label={`Variable ${index + 1} value`}
                    value={row.value}
                    onChange={(event) =>
                      setRows((old) =>
                        old.map((item) =>
                          item.id === row.id
                            ? { ...item, value: event.target.value }
                            : item,
                        ),
                      )
                    }
                    placeholder="Value"
                    className="font-mono sm:flex-1"
                    spellCheck={false}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="self-end sm:self-auto"
                    aria-label={`Remove ${row.name || `variable ${index + 1}`}`}
                    onClick={() =>
                      setRows((old) => old.filter((item) => item.id !== row.id))
                    }
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-4 text-sm">
              No variables. This Worker receives only OpenComputer-managed
              bindings and secrets.
            </p>
          )}
        </section>

        <Field
          label="Allowed outbound hosts"
          htmlFor="flue-egress-hosts"
          description="One hostname per line. Wildcards such as *.example.com include subdomains. Other external hosts are blocked."
        >
          <Textarea
            id="flue-egress-hosts"
            value={egress}
            onChange={(event) => setEgress(event.target.value)}
            placeholder={'api.example.com\n*.example.net'}
            className="min-h-24 font-mono"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </Field>

        {issue ? <FieldError>{issue}</FieldError> : null}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p className="text-muted-foreground text-xs">
            Variable changes are included in the next deployment.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={!dirty || !!issue || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save configuration'}
          </Button>
        </div>
      </PanelContent>
    </Panel>
  )
}

function SecretEditor({
  agentId,
  secrets,
}: {
  agentId: string
  secrets: FlueAgentSecret[]
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const normalizedName = name.trim().toUpperCase()
  const nameIssue =
    normalizedName &&
    (!BINDING_NAME.test(normalizedName) ||
      normalizedName.startsWith('OC_') ||
      normalizedName.startsWith('FLUE_'))
      ? 'Use an uppercase, non-reserved environment variable name.'
      : null

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['agent-flue-secrets', agentId] })
  const setSecret = useMutation({
    mutationFn: () => putFlueAgentSecret(agentId, normalizedName, value),
    onSuccess: (saved) => {
      setName('')
      setValue('')
      void refresh()
      notifySuccess(
        `${saved.name} saved.`,
        saved.sync_status === 'synced'
          ? 'The deployed Worker was updated.'
          : 'It will be included in the next deployment.',
      )
    },
    onError: (error) => {
      void refresh()
      notifyError("Couldn't finish updating the Worker secret.", error)
    },
  })
  const removeSecret = useMutation({
    mutationFn: (secretName: string) =>
      deleteFlueAgentSecret(agentId, secretName),
    onSuccess: (_result, secretName) => {
      setDeleting(null)
      void refresh()
      notifySuccess(`${secretName} deleted.`)
    },
    onError: (error) =>
      notifyError("Couldn't delete the Worker secret.", error),
  })

  return (
    <Panel>
      <PanelHeader>
        <div className="space-y-1">
          <PanelTitle>Worker secrets</PanelTitle>
          <PanelDescription>
            Values are encrypted and write-only. Only the last four characters
            are shown after saving.
          </PanelDescription>
        </div>
      </PanelHeader>
      <PanelContent className="space-y-5">
        <form
          className="grid gap-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] sm:items-start"
          onSubmit={(event) => {
            event.preventDefault()
            if (normalizedName && value && !nameIssue) setSecret.mutate()
          }}
        >
          <Field label="Name" htmlFor="flue-secret-name" error={nameIssue}>
            <Input
              id="flue-secret-name"
              value={name}
              onChange={(event) => setName(event.target.value.toUpperCase())}
              placeholder="API_TOKEN"
              className="font-mono"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Value" htmlFor="flue-secret-value">
            <Input
              id="flue-secret-value"
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Paste a new value"
              className="font-mono"
              autoComplete="new-password"
              spellCheck={false}
            />
          </Field>
          <Button
            type="submit"
            size="sm"
            className="sm:mt-6"
            disabled={
              !normalizedName || !value || !!nameIssue || setSecret.isPending
            }
          >
            {setSecret.isPending ? 'Saving…' : 'Set secret'}
          </Button>
        </form>

        <div className="border-t">
          {secrets.length ? (
            secrets.map((secret) => (
              <div
                key={secret.name}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm font-medium">
                    {secret.name}
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    ends in <span className="font-mono">{secret.last4}</span> ·
                    updated {new Date(secret.updated_at).toLocaleDateString()}
                  </p>
                </div>
                <SecretSyncStatus value={secret.sync_status} />
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => setDeleting(secret.name)}
                >
                  <Trash2 aria-hidden />
                  Delete
                </Button>
              </div>
            ))
          ) : (
            <p className="text-muted-foreground py-5 text-sm">
              No Worker secrets have been set.
            </p>
          )}
        </div>
      </PanelContent>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
        title={`Delete ${deleting ?? 'secret'}?`}
        description="The binding will be removed from the deployed Worker. Requests that depend on it may fail immediately."
        confirmLabel="Delete secret"
        destructive
        pending={removeSecret.isPending}
        onConfirm={() => {
          if (deleting) removeSecret.mutate(deleting)
        }}
      />
    </Panel>
  )
}

function SecretSyncStatus({ value }: { value: string }) {
  const pending = value === 'pending_deploy'
  const error = value === 'error'
  return (
    <Badge
      variant={error ? 'destructive' : 'outline'}
      className={cn(
        pending &&
          'bg-status-pending-bg text-status-pending border-transparent',
        value === 'synced' &&
          'bg-status-running-bg text-status-running border-transparent',
      )}
    >
      {value === 'pending_deploy'
        ? 'Pending deploy'
        : value === 'synced'
          ? 'Synced'
          : 'Sync error'}
    </Badge>
  )
}

function LoadFailure({ label, retry }: { label: string; retry: () => void }) {
  return (
    <Panel>
      <PanelContent className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{label} could not be loaded.</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Existing Worker state was not changed.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={retry}>
          Try again
        </Button>
      </PanelContent>
    </Panel>
  )
}
