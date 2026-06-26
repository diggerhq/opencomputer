import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CircleCheck, KeyRound, Plus, X } from 'lucide-react'
import {
  createAPIKey,
  deleteAPIKey,
  getAPIKeys,
  type APIKey,
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
import { Field, Input } from '@/components/form'
import { CopyRow } from '@/components/copy-row'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ResourceTable, type Column } from '@/components/resource-table'

export default function APIKeys() {
  const queryClient = useQueryClient()
  const { data: keys, isLoading } = useQuery({
    queryKey: ['api-keys'],
    queryFn: getAPIKeys,
  })

  const [showCreate, setShowCreate] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [toRevoke, setToRevoke] = useState<APIKey | null>(null)

  const createMutation = useMutation({
    mutationFn: (name: string) => createAPIKey(name),
    onSuccess: (data) => {
      setCreatedKey(data.key)
      setShowCreate(false)
      setNewKeyName('')
      queryClient.invalidateQueries({ queryKey: ['api-keys'] })
    },
    onError: (error) =>
      toast.error(
        `Couldn't create key: ${error instanceof Error ? error.message : String(error)}`,
      ),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAPIKey(id),
    onError: (error) =>
      toast.error(
        `Revoke failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['api-keys'] }),
  })

  const columns: Column<APIKey>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (k) => (
        <span className="text-foreground font-medium">{k.name}</span>
      ),
    },
    {
      key: 'prefix',
      header: 'Prefix',
      cell: (k) => (
        <code className="text-muted-foreground font-mono text-xs">
          {k.keyPrefix}…
        </code>
      ),
    },
    {
      key: 'lastUsed',
      header: 'Last used',
      cell: (k) => (
        <span className="text-muted-foreground font-mono text-xs">
          {k.lastUsed ? new Date(k.lastUsed).toLocaleString() : 'Never'}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      cell: (k) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(k.createdAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (k) => (
        <Button
          variant="ghost"
          size="sm"
          className="text-status-error underline-offset-2 hover:bg-transparent hover:text-destructive hover:underline"
          onClick={() => setToRevoke(k)}
        >
          Revoke
        </Button>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="API Keys"
        description="Manage authentication tokens for your integrations"
        actions={
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="size-4" />
            Create key
          </Button>
        }
      />

      {createdKey ? (
        <Panel className="mb-5 p-5">
          <div className="flex items-start gap-3">
            <CircleCheck className="text-status-running mt-0.5 size-5 shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <div>
                <p className="text-foreground text-sm font-semibold">
                  New API key created
                </p>
                <p className="text-muted-foreground text-xs">
                  Copy this key now — you won&apos;t be able to see it again.
                </p>
              </div>
              <CopyRow value={createdKey} />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Dismiss"
              onClick={() => setCreatedKey(null)}
            >
              <X className="size-4" />
            </Button>
          </div>
        </Panel>
      ) : null}

      <Panel className="overflow-hidden">
        <ResourceTable
          columns={columns}
          rows={keys ?? []}
          rowKey={(k) => k.id}
          loading={isLoading}
          empty={
            <EmptyState
              icon={KeyRound}
              title="No API keys yet"
              description="Create a key to authenticate the SDK, CLI, and integrations."
              action={
                <Button size="sm" onClick={() => setShowCreate(true)}>
                  <Plus className="size-4" />
                  Create key
                </Button>
              }
            />
          }
        />
      </Panel>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Give the key a name so you can recognize it later.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (newKeyName.trim()) createMutation.mutate(newKeyName.trim())
            }}
          >
            <Field label="Key name" htmlFor="key-name">
              <Input
                id="key-name"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="e.g. Production"
              />
            </Field>
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setShowCreate(false)
                  setNewKeyName('')
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={createMutation.isPending || !newKeyName.trim()}
              >
                {createMutation.isPending ? 'Creating…' : 'Create key'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={toRevoke !== null}
        onOpenChange={(open) => !open && setToRevoke(null)}
        title={`Revoke ${toRevoke?.name ? `"${toRevoke.name}"` : 'this key'}?`}
        description="Integrations using this key will stop working immediately. This can't be undone."
        confirmLabel="Revoke key"
        destructive
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (!toRevoke) return
          deleteMutation.mutate(toRevoke.id, {
            onSuccess: () => setToRevoke(null),
          })
        }}
      />
    </div>
  )
}
