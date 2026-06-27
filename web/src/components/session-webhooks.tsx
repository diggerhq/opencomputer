import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, RotateCw, Webhook, X } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import {
  getDestinations,
  createDestination,
  deleteDestination,
  getDeliveries,
  redeliver,
  type Destination,
  type Delivery,
} from '@/api/client'
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
import { StatusBadge } from '@/components/status-badge'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ResourceTable, type Column } from '@/components/resource-table'

// Webhooks are session-scoped in /v3 (a destination is created per session), so
// they live on the session detail rather than a global page.
export function SessionWebhooks({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [url, setUrl] = useState('')
  const [types, setTypes] = useState('')
  const [secret, setSecret] = useState('')
  const [toDelete, setToDelete] = useState<Destination | null>(null)

  const { data: destinations } = useQuery({
    queryKey: ['destinations', sessionId],
    queryFn: () => getDestinations(sessionId),
  })
  const { data: deliveries } = useQuery({
    queryKey: ['deliveries', sessionId],
    queryFn: () => getDeliveries(sessionId),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ['destinations', sessionId],
    })
    void queryClient.invalidateQueries({ queryKey: ['deliveries', sessionId] })
  }

  const addMutation = useMutation({
    mutationFn: () =>
      createDestination(sessionId, {
        url: url.trim(),
        types: types.trim()
          ? types
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined,
        secret: secret.trim() || undefined,
      }),
    onSuccess: () => {
      setShowAdd(false)
      setUrl('')
      setTypes('')
      setSecret('')
      invalidate()
    },
    onError: (e) => notifyError("Couldn't add the destination.", e),
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteDestination(sessionId, id),
    onSettled: invalidate,
    onError: (e) => notifyError("Couldn't delete the destination.", e),
  })
  const redeliverMutation = useMutation({
    mutationFn: (deliveryId: string) => redeliver(sessionId, deliveryId),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: ['deliveries', sessionId],
      }),
    onError: (e) => notifyError("Couldn't redeliver.", e),
  })

  const deliveryColumns: Column<Delivery>[] = [
    {
      key: 'event',
      header: 'Event',
      cell: (d) => (
        <span className="text-muted-foreground font-mono text-xs">
          #{d.event_seq ?? '—'}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (d) => <StatusBadge status={d.status} />,
    },
    {
      key: 'attempts',
      header: 'Attempts',
      align: 'right',
      cell: (d) => (
        <span className="text-muted-foreground font-mono text-xs">
          {d.attempts ?? 0}
        </span>
      ),
    },
    {
      key: 'response',
      header: 'Response',
      cell: (d) => (
        <span className="text-muted-foreground font-mono text-xs">
          {d.response_code ?? (d.error ? 'err' : '—')}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (d) => (
        <div className="flex h-7 items-center justify-end">
          {d.status === 'failed' || d.status === 'dead_letter' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => redeliverMutation.mutate(d.id)}
              disabled={redeliverMutation.isPending}
            >
              <RotateCw className="size-3.5" />
              Redeliver
            </Button>
          ) : null}
        </div>
      ),
    },
  ]

  return (
    <Panel className="mt-4 overflow-hidden">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-sm font-semibold">Webhooks</h2>
        <Button size="sm" variant="outline" onClick={() => setShowAdd(true)}>
          <Plus className="size-4" />
          Add destination
        </Button>
      </div>

      {/* Destinations */}
      {(destinations?.length ?? 0) === 0 ? (
        <div className="text-muted-foreground flex items-center gap-2 px-4 py-4 text-sm">
          <Webhook className="size-4 opacity-60" />
          No destinations — add one to deliver this session&apos;s events to
          your endpoint.
        </div>
      ) : (
        <ul className="divide-y">
          {destinations?.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-4 py-2.5">
              <code className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">
                {d.url}
              </code>
              {d.types?.length ? (
                <span className="text-muted-foreground hidden font-mono text-[11px] sm:inline">
                  {d.types.join(', ')}
                </span>
              ) : null}
              <StatusBadge
                status={d.enabled ? 'active' : 'paused'}
                label={d.enabled ? 'Enabled' : 'Paused'}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete destination"
                className="text-muted-foreground hover:text-status-error"
                onClick={() => setToDelete(d)}
              >
                <X className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Deliveries */}
      {(deliveries?.length ?? 0) > 0 ? (
        <div className="border-t">
          <div className="text-muted-foreground px-4 pt-3 pb-1 text-xs font-medium tracking-wide uppercase">
            Recent deliveries
          </div>
          <ResourceTable
            columns={deliveryColumns}
            rows={deliveries ?? []}
            rowKey={(d) => d.id}
          />
        </div>
      ) : null}

      {/* Add dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add destination</DialogTitle>
            <DialogDescription>
              Deliver this session&apos;s events to an HTTPS endpoint, signed
              with your secret.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (url.trim()) addMutation.mutate()
            }}
          >
            <Field label="Endpoint URL" htmlFor="dst-url">
              <Input
                id="dst-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/hooks/oc"
              />
            </Field>
            <Field
              label="Event types"
              htmlFor="dst-types"
              description="Comma-separated; exact or prefix (turn.*). Leave blank for all."
            >
              <Input
                id="dst-types"
                value={types}
                onChange={(e) => setTypes(e.target.value)}
                placeholder="turn.completed, error.*"
              />
            </Field>
            <Field
              label="Signing secret"
              htmlFor="dst-secret"
              description="Optional. Write-only — it is never shown again."
            >
              <Input
                id="dst-secret"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="whsec_…"
              />
            </Field>
            <DialogFooter className="mt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setShowAdd(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={addMutation.isPending || !url.trim()}
              >
                {addMutation.isPending ? 'Adding…' : 'Add destination'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title="Delete this destination?"
        description="Events will stop being delivered to it. This can't be undone."
        confirmLabel="Delete destination"
        destructive
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (!toDelete) return
          deleteMutation.mutate(toDelete.id, {
            onSuccess: () => setToDelete(null),
          })
        }}
      />
    </Panel>
  )
}
