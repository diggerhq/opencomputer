import { useState } from 'react'
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import { KeyRound, Plus, Trash2 } from 'lucide-react'
import {
  createAgentHook,
  getAgentHooks,
  revokeAgentHook,
  type AgentHook,
  type AgentHookCreate,
} from '@/api/client'
import { notifyError } from '@/lib/errors'
import {
  Panel,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/form'
import { CopyRow } from '@/components/copy-row'
import { StatusBadge } from '@/components/status-badge'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ApiHint } from '@/components/api-hint'

function revokedReason(reason: AgentHook['revoked_reason']): string | null {
  if (reason === 'secret_exposure') return 'Secret exposure detected'
  if (reason === 'manual') return 'Revoked manually'
  return null
}

function expiryLabel(value: string | null): string {
  return value ? `Expires ${new Date(value).toLocaleString()}` : 'No expiry'
}

export function AgentHooksPanel({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [createPending, setCreatePending] = useState(false)
  const [name, setName] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [created, setCreated] = useState<AgentHookCreate | null>(null)
  const [revoke, setRevoke] = useState<AgentHook | null>(null)
  const query = useInfiniteQuery({
    queryKey: ['agent-hooks', agentId],
    queryFn: ({ pageParam }) => getAgentHooks(agentId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  })
  const hooks = query.data?.pages.flatMap((page) => page.data) ?? []

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['agent-hooks', agentId] })
  const submitCreate = async () => {
    setCreatePending(true)
    try {
      const result = await createAgentHook(agentId, {
        name: name.trim(),
        ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}),
      })
      // The complete Hook URL stays only in this component until dismissed.
      setCreated(result)
      setCreating(false)
      setName('')
      setExpiresAt('')
      void invalidate()
    } catch (error) {
      notifyError("Couldn't create the Hook URL.", error)
    } finally {
      setCreatePending(false)
    }
  }
  const revokeMutation = useMutation({
    mutationFn: (hook: AgentHook) => revokeAgentHook(agentId, hook.id),
    onSuccess: () => {
      setRevoke(null)
      void invalidate()
    },
    onError: (error) => notifyError("Couldn't revoke the Hook URL.", error),
  })

  return (
    <Panel id="hooks" tabIndex={-1} className="scroll-mt-36 outline-none">
      <PanelHeader>
        <div>
          <PanelTitle>Hook URLs</PanelTitle>
          <p className="text-muted-foreground mt-1 text-xs">
            One named, revocable URL per external sender.
          </p>
        </div>
        <ApiHint
          method="POST"
          path={`/v3/agents/${agentId}/hooks`}
          sdk="oc.agents.hooks.create(id, …)"
          docs="https://docs.opencomputer.dev/agent-sessions/hooks"
        />
      </PanelHeader>

      {created ? (
        <PanelContent className="border-b">
          <div className="border-status-warning/40 bg-status-warning-bg rounded-md border p-3">
            <p className="text-foreground text-sm font-medium">
              Copy {created.hook.name}&apos;s complete URL now
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              It cannot be retrieved after you close this notice.
            </p>
            <CopyRow
              value={created.hook_url}
              maskable
              className="bg-background mt-3"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="mt-2"
              onClick={() => setCreated(null)}
            >
              I&apos;ve copied it
            </Button>
          </div>
        </PanelContent>
      ) : null}

      {creating ? (
        <PanelContent className="border-b">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (name.trim()) void submitCreate()
            }}
          >
            <Field label="Name" htmlFor="hook-name">
              <Input
                id="hook-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="grafana-prod"
                pattern="[a-z0-9][a-z0-9-]{0,63}"
                required
              />
            </Field>
            <Field
              label="Expires"
              htmlFor="hook-expiry"
              description="Optional. Leave empty for no expiry."
            >
              <Input
                id="hook-expiry"
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={createPending}
                onClick={() => setCreating(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={!name.trim() || createPending}
              >
                {createPending ? 'Creating…' : 'Create Hook URL'}
              </Button>
            </div>
          </form>
        </PanelContent>
      ) : null}

      <div className="divide-y">
        {query.isLoading ? (
          <p className="text-muted-foreground px-5 py-4 text-xs">Loading…</p>
        ) : query.isError ? (
          <div className="px-5 py-5 text-center">
            <p className="text-sm font-medium">Hook URLs unavailable</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Could not load this agent&apos;s Hooks.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => void query.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : hooks.length === 0 ? (
          <div className="px-5 py-5 text-center">
            <KeyRound className="text-muted-foreground mx-auto size-5" />
            <p className="mt-2 text-sm font-medium">No Hook URLs</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Create one when an external system needs to start this agent.
            </p>
          </div>
        ) : (
          hooks.map((hook) => {
            const reason = revokedReason(hook.revoked_reason)
            return (
              <div key={hook.id} className="px-5 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{hook.name}</span>
                      <StatusBadge status={hook.status} />
                    </div>
                    <p className="text-muted-foreground mt-1 font-mono text-[11px]">
                      {hook.id} · ends in {hook.secret_last4}
                    </p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      Created {new Date(hook.created_at).toLocaleString()} ·{' '}
                      {expiryLabel(hook.expires_at)}
                    </p>
                    {reason ? (
                      <p className="text-status-error mt-0.5 text-xs">
                        {reason}
                      </p>
                    ) : null}
                  </div>
                  {hook.status !== 'revoked' ? (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Revoke ${hook.name}`}
                      onClick={() => setRevoke(hook)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="flex items-center justify-between border-t px-5 py-3">
        {query.hasNextPage ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load older'}
          </Button>
        ) : (
          <span />
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={creating || !!created}
          onClick={() => setCreating(true)}
        >
          <Plus className="size-3.5" /> New Hook URL
        </Button>
      </div>

      <ConfirmDialog
        open={!!revoke}
        onOpenChange={(open) => {
          if (!open) setRevoke(null)
        }}
        title={`Revoke ${revoke?.name ?? 'this Hook'}?`}
        description="The sender will immediately lose access. This cannot be undone. Create a replacement before revoking if the integration must stay live."
        confirmLabel="Revoke Hook"
        destructive
        pending={revokeMutation.isPending}
        onConfirm={() => {
          if (revoke) revokeMutation.mutate(revoke)
        }}
      />
    </Panel>
  )
}
