import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Webhook } from 'lucide-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyRow } from '@/components/copy-row'
import { EmptyState } from '@/components/empty-state'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { ResourceTable, type Column } from '@/components/resource-table'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  createManagedAgentWebhook,
  deleteManagedAgentWebhook,
  getManagedAgentWebhooks,
  rotateManagedAgentWebhookToken,
  updateManagedAgentWebhook,
  type ManagedAgentWebhook,
} from './api'

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString() : 'Never'
}

function curlCommand(webhook: ManagedAgentWebhook) {
  return `curl -X POST '${webhook.invocationUrl}' \\\n+  -H 'Authorization: Bearer ${webhook.token ?? '<token>'}' \\\n+  -H 'Content-Type: application/json' \\\n+  -H 'Idempotency-Key: <unique-request-id>' \\\n+  -d '{"text":"Run this workflow","payload":{"mode":"default"}}'`
}

export function ManagedAgentWebhooks({
  projectId,
  agentId,
  environment,
  deployed,
}: {
  projectId: string
  agentId: string
  environment: 'development' | 'production'
  deployed: boolean
}) {
  const queryClient = useQueryClient()
  const queryKey = ['managed-agent-webhooks', projectId, agentId, environment]
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [credentials, setCredentials] = useState<ManagedAgentWebhook>()
  const [removing, setRemoving] = useState<ManagedAgentWebhook>()

  const webhooks = useQuery({
    queryKey,
    queryFn: () => getManagedAgentWebhooks(projectId, agentId, environment),
    enabled: deployed,
  })
  const create = useMutation({
    mutationFn: () =>
      createManagedAgentWebhook({
        projectId,
        agentId,
        environment,
        name: name.trim(),
      }),
    onSuccess: async (webhook) => {
      setCreating(false)
      setName('')
      setCredentials(webhook)
      await queryClient.invalidateQueries({ queryKey })
    },
    onError: (error) => notifyError("Couldn't create that webhook.", error),
  })
  const update = useMutation({
    mutationFn: (webhook: ManagedAgentWebhook) =>
      updateManagedAgentWebhook({
        projectId,
        webhookId: webhook.id,
        enabled: !webhook.enabled,
      }),
    onSuccess: async (webhook) => {
      notifySuccess(webhook.enabled ? 'Webhook enabled.' : 'Webhook disabled.')
      await queryClient.invalidateQueries({ queryKey })
    },
    onError: (error) => notifyError("Couldn't update that webhook.", error),
  })
  const rotate = useMutation({
    mutationFn: (webhook: ManagedAgentWebhook) =>
      rotateManagedAgentWebhookToken(projectId, webhook.id),
    onSuccess: (webhook) => {
      setCredentials(webhook)
      notifySuccess(
        'Webhook token rotated.',
        'The previous token no longer works.',
      )
    },
    onError: (error) => notifyError("Couldn't rotate that token.", error),
  })
  const remove = useMutation({
    mutationFn: (webhook: ManagedAgentWebhook) =>
      deleteManagedAgentWebhook(projectId, webhook.id),
    onSuccess: async () => {
      setRemoving(undefined)
      notifySuccess('Webhook removed.')
      await queryClient.invalidateQueries({ queryKey })
    },
    onError: (error) => notifyError("Couldn't remove that webhook.", error),
  })

  if (!deployed) {
    return (
      <Panel>
        <EmptyState
          icon={Webhook}
          title={`No active ${environment} deployment`}
          description="Deploy this agent before creating an ingress webhook for it."
        />
      </Panel>
    )
  }
  if (webhooks.isError) {
    return (
      <Panel>
        <EmptyState
          icon={Webhook}
          title="Webhooks are temporarily unavailable"
          description="Try loading this environment again."
        />
      </Panel>
    )
  }

  const columns: Column<ManagedAgentWebhook>[] = [
    {
      key: 'webhook',
      header: 'Webhook',
      cell: (webhook) => (
        <div>
          <p className="text-sm font-medium">{webhook.name}</p>
          <p className="text-muted-foreground mt-1 max-w-xl truncate font-mono text-xs">
            {webhook.invocationUrl}
          </p>
        </div>
      ),
    },
    {
      key: 'last-invoked',
      header: 'Last invoked',
      cell: (webhook) => (
        <span className="text-muted-foreground text-xs">
          {formatDate(webhook.lastInvokedAt)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (webhook) => (
        <StatusBadge status={webhook.enabled ? 'active' : 'paused'} />
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (webhook) => (
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => update.mutate(webhook)}
          >
            {webhook.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={rotate.isPending}
            onClick={() => rotate.mutate(webhook)}
          >
            Rotate token
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRemoving(webhook)}
          >
            Remove
          </Button>
        </div>
      ),
    },
  ]

  return (
    <>
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Webhooks</PanelTitle>
            <PanelDescription>
              Start a fresh {environment} session from an external system. Each
              webhook is fixed to this agent and environment.
            </PanelDescription>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> Create webhook
          </Button>
        </PanelHeader>
        <PanelContent className="p-0">
          <ResourceTable
            columns={columns}
            rows={webhooks.data ?? []}
            rowKey={(webhook) => webhook.id}
            loading={webhooks.isLoading}
            empty={
              <EmptyState
                icon={Webhook}
                title={`No ${environment} webhooks`}
                description="Create one to trigger this agent from another service."
              />
            }
          />
        </PanelContent>
      </Panel>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create webhook</DialogTitle>
            <DialogDescription>
              Give this ingress point a name. Its bearer token is shown once.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="webhook-name">Name</Label>
            <Input
              id="webhook-name"
              value={name}
              maxLength={80}
              placeholder="Daily hygiene trigger"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              disabled={!name.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? <Loader2 className="animate-spin" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(credentials)}
        onOpenChange={(open) => !open && setCredentials(undefined)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Save this webhook token</DialogTitle>
            <DialogDescription>
              OpenComputer stores only its hash, so this token cannot be shown
              again. Rotating it invalidates the previous token.
            </DialogDescription>
          </DialogHeader>
          {credentials?.token ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Token</Label>
                <CopyRow value={credentials.token} maskable />
              </div>
              <div className="space-y-2">
                <Label>Example request</Label>
                <CopyRow value={curlCommand(credentials)} />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setCredentials(undefined)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title="Remove webhook?"
        description="Its URL and token will stop working immediately."
        confirmLabel="Remove webhook"
        destructive
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </>
  )
}
