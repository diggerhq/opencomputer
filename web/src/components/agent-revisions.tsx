import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History, RotateCcw, ArrowUp } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import {
  getAgentRevisions,
  getAgentDeploys,
  activateRevision,
  type AgentRevision,
} from '@/api/client'
import { Panel, PanelHeader, PanelTitle } from '@/components/panel'
import { ResourceTable, type Column } from '@/components/resource-table'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'

// Short, legible digest (e.g. "sha256:a14f940d82") for the table.
const shortDigest = (d: string) => d.slice(0, 19)
const sourceVia = (s?: Record<string, unknown> | null) =>
  (s && typeof s.via === 'string' && s.via) || 'api'

/**
 * Agent Revisions panel (design 009 §13): the deploy history of an agent's behavior,
 * the active production pointer made visible, one-click rollback (activate an earlier
 * revision), and a compact deploy timeline (provenance + state).
 */
export function AgentRevisions({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<AgentRevision | null>(null)

  const { data: revisions = [], isLoading } = useQuery({
    queryKey: ['agent-revisions', agentId],
    queryFn: () => getAgentRevisions(agentId),
  })
  const { data: deploys = [] } = useQuery({
    queryKey: ['agent-deploys', agentId],
    queryFn: () => getAgentDeploys(agentId),
  })
  // A revision's provenance lives on the deploy that CREATED it (one revision, many
  // deploys — source is a deploy field). Fold source.via into the revisions table so
  // we don't need a second, near-duplicate table.
  const createdVia = new Map<string, string>()
  for (const d of deploys) {
    if (d.revision_id && d.result === 'created') createdVia.set(d.revision_id, sourceVia(d.source))
  }

  const activateMutation = useMutation({
    mutationFn: (rev: AgentRevision) => activateRevision(agentId, rev.number),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent-revisions', agentId] })
      void queryClient.invalidateQueries({ queryKey: ['agent-deploys', agentId] })
      // prompt/model are sourced from the active revision → refresh the agent too.
      void queryClient.invalidateQueries({ queryKey: ['agent', agentId] })
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      setPending(null)
    },
    onError: (e) => {
      notifyError("Couldn't activate that revision.", e)
      setPending(null)
    },
  })

  const revisionColumns: Column<AgentRevision>[] = [
    {
      key: 'number',
      header: 'Revision',
      cell: (r) => (
        <span className="text-foreground font-mono text-[13px]">#{r.number}</span>
      ),
    },
    {
      key: 'source',
      header: 'Source',
      cell: (r) => (
        <span className="text-muted-foreground text-xs capitalize">
          {createdVia.get(r.id) ?? '—'}
        </span>
      ),
    },
    {
      key: 'digest',
      header: 'Digest',
      cell: (r) => (
        <span className="text-muted-foreground font-mono text-xs">
          {shortDigest(r.digest)}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      cell: (r) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(r.created_at).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      cell: (r) => {
        if (r.active) return <StatusBadge status="active" />
        // Activating an older revision is a rollback; a newer one is a promote. Show just the
        // icon (it repeats down the column); the label slides in on hover so it stays legible.
        const isRollback = !!revisions[0] && r.number < revisions[0].number
        const Icon = isRollback ? RotateCcw : ArrowUp
        const label = isRollback ? 'Roll back' : 'Activate'
        return (
          <Button
            variant="ghost"
            size="xs"
            aria-label={label}
            title={label}
            className="group text-muted-foreground hover:text-foreground gap-0"
            disabled={activateMutation.isPending}
            onClick={() => setPending(r)}
          >
            <Icon className="size-3.5 shrink-0" />
            <span className="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-200 ease-out group-hover:ml-1.5 group-hover:max-w-[6rem] group-hover:opacity-100 motion-reduce:transition-none motion-reduce:group-hover:ml-1.5">
              {label}
            </span>
          </Button>
        )
      },
    },
  ]

  return (
    <Panel className="overflow-hidden">
      <PanelHeader>
        <PanelTitle>Revisions</PanelTitle>
        <span className="text-muted-foreground text-xs">
          Each deploy is an immutable revision. Rolling back re-points the active one.
        </span>
      </PanelHeader>

      <ResourceTable
        columns={revisionColumns}
        rows={revisions}
        rowKey={(r) => r.id}
        loading={isLoading}
        empty={
          <EmptyState
            icon={History}
            title="No revisions yet"
            description="Editing the prompt or model, or deploying an agent directory, creates a revision."
          />
        }
      />

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={`Activate revision #${pending?.number ?? ''}?`}
        description="New sessions will use this revision. In-flight sessions keep the revision they started with."
        confirmLabel="Activate"
        pending={activateMutation.isPending}
        onConfirm={() => pending && activateMutation.mutate(pending)}
      />
    </Panel>
  )
}
