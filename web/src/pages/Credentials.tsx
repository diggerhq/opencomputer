import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeySquare, Plus } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import {
  createCredential,
  deleteCredential,
  getCredentials,
  setDefaultCredential,
  type Credential,
} from '@/api/client'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, Input, Label, Select } from '@/components/form'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ResourceTable, type Column } from '@/components/resource-table'

// Providers an agent runtime can use. claude → anthropic; openai lands when the
// codex runtime ships, but a key can be stored ahead of it.
const PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
]
const KEY_HINT: Record<string, string> = {
  anthropic: 'sk-ant-…',
  openai: 'sk-…',
}

export default function Credentials() {
  const queryClient = useQueryClient()
  const { data: credentials, isLoading } = useQuery({
    queryKey: ['credentials'],
    queryFn: getCredentials,
  })

  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [provider, setProvider] = useState('anthropic')
  const [key, setKey] = useState('')
  const [makeDefault, setMakeDefault] = useState(true)
  const [toDelete, setToDelete] = useState<Credential | null>(null)

  const resetForm = () => {
    setName('')
    setProvider('anthropic')
    setKey('')
    setMakeDefault(true)
  }

  // These operations chain through the edge → sessions-api → Infisical, so each
  // can take a second or two. We apply the change to the cache immediately and
  // reconcile on settle; on failure we roll the cache back and surface the error,
  // so the UI feels instant without ever showing a state the server rejected.
  const CREDS_KEY = ['credentials'] as const
  const snapshot = async () => {
    await queryClient.cancelQueries({ queryKey: CREDS_KEY })
    return queryClient.getQueryData<Credential[]>(CREDS_KEY)
  }
  const rollback = (previous?: Credential[]) => {
    if (previous) queryClient.setQueryData(CREDS_KEY, previous)
  }

  const createMutation = useMutation({
    mutationFn: () =>
      createCredential({
        key: key.trim(),
        provider,
        name: name.trim() || undefined,
        is_default: makeDefault,
      }),
    onMutate: async () => {
      const previous = await snapshot()
      // Optimistic row: real last4 (client-derived), temp id replaced on settle.
      const optimistic: Credential = {
        id: `temp_${Date.now()}`,
        provider,
        name: name.trim() || undefined,
        last4: key.trim().slice(-4),
        is_default: makeDefault,
        created_at: new Date().toISOString(),
      }
      queryClient.setQueryData<Credential[]>(CREDS_KEY, (old = []) => [
        optimistic,
        // a new default clears the previous one for the same provider
        ...(makeDefault
          ? old.map((c) =>
              c.provider === provider ? { ...c, is_default: false } : c,
            )
          : old),
      ])
      // Close instantly, but keep the form values so a failure can reopen with the
      // typed key intact (it's never recoverable once the row truly exists).
      const form = { name, provider, key, makeDefault }
      setShowCreate(false)
      return { previous, form }
    },
    onError: (e, _vars, ctx) => {
      rollback(ctx?.previous)
      notifyError("Couldn't add the credential.", e)
      if (ctx?.form) {
        setName(ctx.form.name)
        setProvider(ctx.form.provider)
        setKey(ctx.form.key)
        setMakeDefault(ctx.form.makeDefault)
        setShowCreate(true) // reopen so the user can retry without re-typing
      }
    },
    onSuccess: () => resetForm(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: CREDS_KEY }),
  })

  const defaultMutation = useMutation({
    mutationFn: (id: string) => setDefaultCredential(id),
    onMutate: async (id) => {
      const previous = await snapshot()
      const target = previous?.find((c) => c.id === id)
      queryClient.setQueryData<Credential[]>(CREDS_KEY, (old = []) =>
        old.map((c) =>
          c.provider === target?.provider
            ? { ...c, is_default: c.id === id }
            : c,
        ),
      )
      return { previous }
    },
    onError: (e, _id, ctx) => {
      rollback(ctx?.previous)
      notifyError("Couldn't set the default.", e)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: CREDS_KEY }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCredential(id),
    onMutate: async (id) => {
      const previous = await snapshot()
      queryClient.setQueryData<Credential[]>(CREDS_KEY, (old = []) =>
        old.filter((c) => c.id !== id),
      )
      setToDelete(null) // dismiss the confirm immediately
      return { previous }
    },
    onError: (e, _id, ctx) => {
      rollback(ctx?.previous)
      notifyError("Couldn't delete the credential.", e)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: CREDS_KEY }),
  })

  const columns: Column<Credential>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (c) => (
        <span className="flex items-center gap-2">
          <span className="text-foreground font-medium">
            {c.name || <span className="text-muted-foreground">Unnamed</span>}
          </span>
          {c.is_default ? <Badge variant="secondary">Default</Badge> : null}
        </span>
      ),
    },
    {
      key: 'provider',
      header: 'Provider',
      cell: (c) => (
        <span className="text-muted-foreground text-xs capitalize">
          {c.provider}
        </span>
      ),
    },
    {
      key: 'key',
      header: 'Key',
      cell: (c) => (
        <code className="text-muted-foreground font-mono text-xs">
          {c.last4 ? `··· ${c.last4}` : '—'}
        </code>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      cell: (c) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(c.created_at).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (c) => (
        <div className="flex items-center justify-end gap-1">
          {!c.is_default ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={defaultMutation.isPending}
              onClick={() => defaultMutation.mutate(c.id)}
            >
              Set default
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="text-status-error underline-offset-2 hover:bg-transparent hover:underline"
            onClick={() => setToDelete(c)}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ]

  const canCreate = key.trim().length > 0

  return (
    <div>
      <PageHeader
        title="Credentials"
        description="Model-provider keys your agents run on. Stored write-only; pick one per agent or set an org default."
        api={{
          method: 'POST',
          path: '/v3/credentials',
          sdk: 'oc.credentials.create()',
          docs: 'https://docs.opencomputer.dev/agent-sessions/credentials',
        }}
        actions={
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="size-4" />
            Add credential
          </Button>
        }
      />

      <Panel className="overflow-hidden">
        <ResourceTable
          columns={columns}
          rows={credentials ?? []}
          rowKey={(c) => c.id}
          loading={isLoading}
          empty={
            <EmptyState
              icon={KeySquare}
              title="No credentials yet"
              description="Add a model-provider key once, then reuse it across agents — no need to paste it every time."
              action={
                <Button size="sm" onClick={() => setShowCreate(true)}>
                  <Plus className="size-4" />
                  Add credential
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
          if (!open) setKey('') // never leave a key in state after close
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add credential</DialogTitle>
            <DialogDescription>
              The key is stored write-only — you won&apos;t be able to read it
              back, only rotate or delete it.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (canCreate) createMutation.mutate()
            }}
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="cred-name">
                <Input
                  id="cred-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Production"
                />
              </Field>
              <Field label="Provider" htmlFor="cred-provider">
                <Select
                  id="cred-provider"
                  value={provider}
                  onValueChange={setProvider}
                  options={PROVIDERS}
                />
              </Field>
            </div>
            <Field label="API key" htmlFor="cred-key">
              <Input
                id="cred-key"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={KEY_HINT[provider] ?? 'sk-…'}
              />
            </Field>
            <div className="flex items-center gap-2">
              <Checkbox
                id="cred-default"
                checked={makeDefault}
                onCheckedChange={(v) => setMakeDefault(v === true)}
              />
              <Label
                htmlFor="cred-default"
                className="cursor-pointer font-normal"
              >
                Set as the org default for {provider}
                <span className="text-muted-foreground">
                  {' '}
                  — used when an agent doesn&apos;t pin its own.
                </span>
              </Label>
            </div>
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
                {createMutation.isPending ? 'Adding…' : 'Add credential'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title={`Delete ${toDelete?.name ? `"${toDelete.name}"` : 'this credential'}?`}
        description="Agents pinned to it, and sessions that fall back to it, will stop running until you point them at another credential. This can't be undone."
        confirmLabel="Delete credential"
        destructive
        onConfirm={() => {
          if (toDelete) deleteMutation.mutate(toDelete.id)
        }}
      />
    </div>
  )
}
