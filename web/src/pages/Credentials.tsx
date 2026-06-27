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

  const createMutation = useMutation({
    mutationFn: () =>
      createCredential({
        key: key.trim(),
        provider,
        name: name.trim() || undefined,
        is_default: makeDefault,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['credentials'] })
      setShowCreate(false)
      resetForm()
    },
    onError: (e) => notifyError("Couldn't add the credential.", e),
  })

  const defaultMutation = useMutation({
    mutationFn: (id: string) => setDefaultCredential(id),
    onError: (e) => notifyError("Couldn't set the default.", e),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['credentials'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCredential(id),
    onError: (e) => notifyError("Couldn't delete the credential.", e),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['credentials'] }),
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
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (!toDelete) return
          deleteMutation.mutate(toDelete.id, {
            onSuccess: () => setToDelete(null),
          })
        }}
      />
    </div>
  )
}
