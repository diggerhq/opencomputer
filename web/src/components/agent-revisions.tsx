import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import {
  getAgentRevisions,
  getAgentDeploys,
  activateRevision,
  type AgentRevision,
  type AgentDeploy,
} from '@/api/client'
import {
  Panel,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
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
  const { data: deploys = [], isLoading: loadingDeploys } = useQuery({
    queryKey: ['agent-deploys', agentId],
    queryFn: () => getAgentDeploys(agentId),
  })

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
      cell: (r) =>
        r.active ? (
          <StatusBadge status="active" />
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={activateMutation.isPending}
            onClick={() => setPending(r)}
          >
            {/* Activating an older revision is a rollback; a newer one is a promote. */}
            {revisions[0] && r.number < revisions[0].number ? 'Roll back' : 'Activate'}
          </Button>
        ),
    },
  ]

  const deployColumns: Column<AgentDeploy>[] = [
    {
      key: 'via',
      header: 'Source',
      cell: (d) => (
        <span className="text-foreground text-xs capitalize">{sourceVia(d.source)}</span>
      ),
    },
    {
      key: 'result',
      header: 'Result',
      cell: (d) => (
        <span className="text-muted-foreground font-mono text-xs">
          {d.result ?? '—'}
        </span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      cell: (d) => <StatusBadge status={d.state} />,
    },
    {
      key: 'when',
      header: 'When',
      align: 'right',
      cell: (d) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(d.created_at).toLocaleString()}
        </span>
      ),
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

      {/* Deploy history — provenance + state, newest first. */}
      {deploys.length > 0 || loadingDeploys ? (
        <PanelContent className="border-t">
          <p className="text-muted-foreground mb-2 text-xs font-medium">Deploy history</p>
          <ResourceTable
            columns={deployColumns}
            rows={deploys.slice(0, 8)}
            rowKey={(d) => d.id}
            loading={loadingDeploys}
            skeletonRows={3}
          />
        </PanelContent>
      ) : null}

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
