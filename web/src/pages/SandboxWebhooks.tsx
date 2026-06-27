import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronRight,
  Copy,
  KeyRound,
  Plus,
  RotateCw,
  Send,
  Webhook,
  X,
} from 'lucide-react'
import { notifyError } from '@/lib/errors'
import {
  getSandboxWebhooks,
  createSandboxWebhook,
  deleteSandboxWebhook,
  testSandboxWebhook,
  getSandboxWebhookDeliveries,
  getSandboxWebhookSecret,
  redeliverSandboxWebhook,
  type SandboxWebhook,
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
import { Field, Input, Label } from '@/components/form'
import { Checkbox } from '@/components/ui/checkbox'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { cn } from '@/lib/utils'

// The /v3 event taxonomy's sandbox-plane counterpart (pkg/types/webhook.go).
// Empty selection = every event.
const SANDBOX_EVENT_TYPES = [
  { value: 'sandbox.created', label: 'Created' },
  { value: 'sandbox.ready', label: 'Ready' },
  { value: 'sandbox.hibernated', label: 'Hibernated' },
  { value: 'sandbox.resumed', label: 'Resumed' },
  { value: 'sandbox.stopped', label: 'Stopped' },
  { value: 'sandbox.migrated', label: 'Migrated' },
  { value: 'sandbox.checkpoint.created', label: 'Checkpoint created' },
  { value: 'sandbox.forked', label: 'Forked' },
  { value: 'sandbox.scaled', label: 'Scaled' },
  { value: 'sandbox.preview_url.changed', label: 'Preview URL changed' },
]

export default function SandboxWebhooks() {
  const queryClient = useQueryClient()
  const { data: webhooks, isLoading } = useQuery({
    queryKey: ['sandbox-webhooks'],
    queryFn: getSandboxWebhooks,
  })

  const [showAdd, setShowAdd] = useState(false)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [toDelete, setToDelete] = useState<SandboxWebhook | null>(null)

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

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['sandbox-webhooks'] })

  const addMutation = useMutation({
    mutationFn: () =>
      createSandboxWebhook({
        url: url.trim(),
        name: name.trim() || undefined,
        eventTypes: selectedTypes.size ? Array.from(selectedTypes) : undefined,
      }),
    onSuccess: () => {
      setShowAdd(false)
      setUrl('')
      setName('')
      setSelectedTypes(new Set())
      invalidate()
    },
    onError: (e) => notifyError("Couldn't add the destination.", e),
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteSandboxWebhook(id),
    onSettled: invalidate,
    onError: (e) => notifyError("Couldn't delete the destination.", e),
  })
  const testMutation = useMutation({
    mutationFn: (id: string) => testSandboxWebhook(id),
    onError: (e) => notifyError("Couldn't send the test event.", e),
  })

  return (
    <div>
      <PageHeader
        title="Webhooks"
        description="Deliver sandbox lifecycle events (created, ready, stopped, …) to your endpoints, signed and retried."
        actions={
          <Button onClick={() => setShowAdd(true)}>
            <Plus className="size-4" />
            Add destination
          </Button>
        }
      />

      <Panel className="overflow-hidden">
        {isLoading ? (
          <div className="text-muted-foreground px-4 py-6 text-sm">
            Loading…
          </div>
        ) : (webhooks?.length ?? 0) === 0 ? (
          <EmptyState
            icon={Webhook}
            title="No webhook destinations"
            description="Add an endpoint to receive sandbox lifecycle events for your org."
            action={
              <Button size="sm" onClick={() => setShowAdd(true)}>
                <Plus className="size-4" />
                Add destination
              </Button>
            }
          />
        ) : (
          <ul className="divide-y">
            {webhooks?.map((w) => {
              const isOpen = expanded.has(w.id)
              return (
                <li key={w.id}>
                  <div className="flex items-center gap-3 px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() => toggleExpand(w.id)}
                      aria-expanded={isOpen}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <ChevronRight
                        className={cn(
                          'size-3.5 shrink-0 opacity-60 transition-transform',
                          isOpen && 'rotate-90',
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {w.name ? (
                          <span className="text-foreground text-sm font-medium">
                            {w.name}{' '}
                          </span>
                        ) : null}
                        <code className="text-muted-foreground font-mono text-xs">
                          {w.url}
                        </code>
                      </span>
                    </button>
                    <span className="text-muted-foreground hidden text-xs sm:inline">
                      {w.eventTypes?.length
                        ? `${w.eventTypes.length} event${w.eventTypes.length > 1 ? 's' : ''}`
                        : 'All events'}
                    </span>
                    <StatusBadge
                      status={w.enabled ? 'active' : 'paused'}
                      label={w.enabled ? 'Enabled' : 'Paused'}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => testMutation.mutate(w.id)}
                      disabled={testMutation.isPending}
                    >
                      <Send className="size-3.5" />
                      Test
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Delete destination"
                      className="text-muted-foreground hover:text-status-error"
                      onClick={() => setToDelete(w)}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>

                  {isOpen ? (
                    <div className="bg-panel-2/40 border-t px-4 py-2 pl-9">
                      {w.eventTypes?.length ? (
                        <p className="text-muted-foreground mb-1.5 font-mono text-[11px]">
                          {w.eventTypes.join(', ')}
                        </p>
                      ) : null}
                      <SecretReveal webhookId={w.id} />
                      <Deliveries webhookId={w.id} />
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </Panel>

      {/* Add dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add destination</DialogTitle>
            <DialogDescription>
              Sandbox lifecycle events for your org are delivered to this HTTPS
              endpoint. A signing secret is generated automatically — reveal it
              from the destination after you add it.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (url.trim()) addMutation.mutate()
            }}
          >
            <Field label="Endpoint URL" htmlFor="swh-url">
              <Input
                id="swh-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/hooks/sandbox"
              />
            </Field>
            <Field
              label="Name"
              htmlFor="swh-name"
              description="Optional — a label to recognize this destination."
            >
              <Input
                id="swh-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Prod ingest"
              />
            </Field>
            <div className="space-y-2">
              <Label>Event types</Label>
              <p className="text-muted-foreground text-xs">
                Leave all unchecked to receive every event.
              </p>
              <div className="grid grid-cols-2 gap-2 pt-0.5">
                {SANDBOX_EVENT_TYPES.map((t) => (
                  <label
                    key={t.value}
                    htmlFor={`swh-et-${t.value}`}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <Checkbox
                      id={`swh-et-${t.value}`}
                      checked={selectedTypes.has(t.value)}
                      onCheckedChange={() => toggleType(t.value)}
                    />
                    {t.label}
                  </label>
                ))}
              </div>
            </div>
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
        description="It stops receiving sandbox events. Delivery history is lost. This can't be undone."
        confirmLabel="Delete destination"
        destructive
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (toDelete)
            deleteMutation.mutate(toDelete.id, {
              onSuccess: () => setToDelete(null),
            })
        }}
      />
    </div>
  )
}

// Deliveries for one destination — lazy-loaded when its row is expanded.
function Deliveries({ webhookId }: { webhookId: string }) {
  const queryClient = useQueryClient()
  const { data: deliveries, isLoading } = useQuery({
    queryKey: ['sandbox-webhook-deliveries', webhookId],
    queryFn: () => getSandboxWebhookDeliveries(webhookId),
  })
  const redeliverMutation = useMutation({
    mutationFn: (deliveryId: string) =>
      redeliverSandboxWebhook(webhookId, deliveryId),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: ['sandbox-webhook-deliveries', webhookId],
      }),
    onError: (e) => notifyError("Couldn't redeliver.", e),
  })

  if (isLoading)
    return <p className="text-muted-foreground py-1 text-xs">Loading…</p>
  if ((deliveries?.length ?? 0) === 0)
    return (
      <p className="text-muted-foreground py-1 text-xs">No deliveries yet.</p>
    )

  return (
    <ul className="divide-border/50 divide-y">
      {deliveries?.map((d) => (
        <li key={d.id} className="flex items-center gap-3 py-1.5 text-xs">
          <StatusBadge status={d.status ?? 'pending'} />
          <span className="text-muted-foreground font-mono">
            {d.responseStatusCode ?? '—'}
          </span>
          <span className="text-muted-foreground truncate">
            {d.timestamp ? new Date(d.timestamp).toLocaleString() : ''}
          </span>
          <span className="flex-1" />
          {d.status === 'failed' ? (
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
        </li>
      ))}
    </ul>
  )
}

// Reveal + copy a destination's signing secret (Svix generates it; re-fetchable
// any time, like the Svix App Portal). Verify request signatures against it.
function SecretReveal({ webhookId }: { webhookId: string }) {
  const [secret, setSecret] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const reveal = useMutation({
    mutationFn: () => getSandboxWebhookSecret(webhookId),
    onSuccess: setSecret,
    onError: (e) => notifyError("Couldn't reveal the signing secret.", e),
  })

  if (!secret) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="mb-1.5 -ml-2"
        onClick={() => reveal.mutate()}
        disabled={reveal.isPending}
      >
        <KeyRound className="size-3.5" />
        {reveal.isPending ? 'Revealing…' : 'Reveal signing secret'}
      </Button>
    )
  }

  return (
    <div className="mb-1.5 flex items-center gap-2">
      <code className="bg-panel min-w-0 flex-1 truncate rounded border px-2 py-1 font-mono text-[11px]">
        {secret}
      </code>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Copy signing secret"
        onClick={() => {
          void navigator.clipboard.writeText(secret)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
    </div>
  )
}
