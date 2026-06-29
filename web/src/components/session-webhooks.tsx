import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Plus, RotateCw, Webhook, X } from 'lucide-react'
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
import { Field, Input, Label } from '@/components/form'
import { Checkbox } from '@/components/ui/checkbox'
import { StatusBadge } from '@/components/status-badge'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { cn } from '@/lib/utils'

// Predefined event types a destination can subscribe to (exact + the error.*
// prefix), from the event taxonomy. Empty selection = deliver every event.
const EVENT_TYPES = [
  { value: 'turn.completed', label: 'Turn completed' },
  { value: 'turn.started', label: 'Turn started' },
  { value: 'agent.message', label: 'Agent message' },
  { value: 'user.message', label: 'User message' },
  { value: 'tool.call', label: 'Tool call' },
  { value: 'exec.completed', label: 'Command finished' },
  { value: 'error.*', label: 'Errors' },
]

// Webhooks are session-scoped (a destination is created per session), so
// they live on the session detail rather than a global page.
export function SessionWebhooks({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [url, setUrl] = useState('')
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set())
  const [secret, setSecret] = useState('')
  const [toDelete, setToDelete] = useState<Destination | null>(null)

  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggleType = (v: string) =>
    setSelectedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(v)) next.delete(v)
      else next.add(v)
      return next
    })
  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

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
        types: selectedTypes.size ? Array.from(selectedTypes) : undefined,
        secret: secret.trim() || undefined,
      }),
    onSuccess: () => {
      setShowAdd(false)
      setUrl('')
      setSelectedTypes(new Set())
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

  // Deliveries grouped by destination — folded under each so the panel stays
  // clean (delivery.destination is the destination id).
  const byDest = new Map<string, Delivery[]>()
  for (const dl of deliveries ?? []) {
    const k = dl.destination ?? ''
    const list = byDest.get(k) ?? []
    list.push(dl)
    byDest.set(k, list)
  }

  return (
    <Panel className="mt-4 overflow-hidden">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-sm font-semibold">Webhooks</h2>
        <Button size="sm" variant="outline" onClick={() => setShowAdd(true)}>
          <Plus className="size-4" />
          Add destination
        </Button>
      </div>

      {/* Destinations — each expands to its own deliveries */}
      {(destinations?.length ?? 0) === 0 ? (
        <div className="text-muted-foreground flex items-center gap-2 px-4 py-4 text-sm">
          <Webhook className="size-4 opacity-60" />
          No destinations — add one to deliver this session&apos;s events to
          your endpoint.
        </div>
      ) : (
        <ul className="divide-y">
          {destinations?.map((d) => {
            const dels = byDest.get(d.id) ?? []
            const isOpen = expanded.has(d.id)
            return (
              <li key={d.id}>
                <div className="flex items-center gap-3 px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => toggleExpand(d.id)}
                    aria-expanded={isOpen}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <ChevronRight
                      className={cn(
                        'size-3.5 shrink-0 opacity-60 transition-transform',
                        isOpen && 'rotate-90',
                      )}
                    />
                    <code className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">
                      {d.url}
                    </code>
                  </button>
                  <span className="text-muted-foreground hidden text-xs sm:inline">
                    {dels.length} sent
                  </span>
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
                </div>

                {isOpen ? (
                  <div className="bg-panel-2/40 border-t px-4 py-2 pl-9">
                    {d.types?.length ? (
                      <p className="text-muted-foreground mb-1.5 font-mono text-[11px]">
                        {d.types.join(', ')}
                      </p>
                    ) : null}
                    {dels.length === 0 ? (
                      <p className="text-muted-foreground py-1 text-xs">
                        No deliveries yet.
                      </p>
                    ) : (
                      <ul className="divide-border/50 divide-y">
                        {dels.map((dl) => (
                          <li
                            key={dl.id}
                            className="flex items-center gap-3 py-1.5 text-xs"
                          >
                            <span className="text-muted-foreground w-10 shrink-0 font-mono">
                              #{dl.event_seq ?? '—'}
                            </span>
                            <StatusBadge status={dl.status} />
                            <span className="text-muted-foreground font-mono">
                              {dl.attempts ?? 0}×
                            </span>
                            <span className="text-muted-foreground font-mono">
                              {dl.response_code ?? (dl.error ? 'err' : '—')}
                            </span>
                            <span className="flex-1" />
                            {dl.status === 'failed' ||
                            dl.status === 'dead_letter' ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => redeliverMutation.mutate(dl.id)}
                                disabled={redeliverMutation.isPending}
                              >
                                <RotateCw className="size-3.5" />
                                Redeliver
                              </Button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

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
            <div className="space-y-2">
              <Label>Event types</Label>
              <p className="text-muted-foreground text-xs">
                Leave all unchecked to deliver every event.
              </p>
              <div className="grid grid-cols-2 gap-2 pt-0.5">
                {EVENT_TYPES.map((t) => (
                  <label
                    key={t.value}
                    htmlFor={`et-${t.value}`}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <Checkbox
                      id={`et-${t.value}`}
                      checked={selectedTypes.has(t.value)}
                      onCheckedChange={() => toggleType(t.value)}
                    />
                    {t.label}
                  </label>
                ))}
              </div>
            </div>
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
