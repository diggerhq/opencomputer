import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Layers, CircleAlert } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import {
  deleteCheckpointDashboard,
  getCheckpoints,
  type CheckpointItem,
} from '@/api/client'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ResourceTable, type Column } from '@/components/resource-table'

function checkpointTypeLabel(cp: CheckpointItem) {
  return cp.kind === 'disk_only' ? 'Disk-only' : 'Full'
}

function checkpointTypeDetail(cp: CheckpointItem) {
  if (cp.kind !== 'disk_only') return 'Disk, memory, CPU'
  if (cp.promotionStatus === 'ready') return 'Promoted for fast fork'
  if (cp.promotionStatus === 'processing' || cp.promotionStatus === 'pending')
    return 'Promoting'
  if (cp.promotionStatus === 'failed') return 'Promotion failed'
  return 'Disk only'
}

const PER_PAGE = 20

export default function Checkpoints() {
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [showFailed, setShowFailed] = useState(false)
  const [toDelete, setToDelete] = useState<CheckpointItem | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['checkpoints', page],
    queryFn: () => getCheckpoints(page, PER_PAGE),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCheckpointDashboard(id),
    onError: (error) => notifyError("Couldn't delete the checkpoint.", error),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['checkpoints'] }),
  })

  const confirmDelete = () => {
    if (!toDelete) return
    deleteMutation.mutate(toDelete.id, { onSuccess: () => setToDelete(null) })
  }

  const checkpoints = useMemo(() => data?.checkpoints ?? [], [data])
  const visibleCheckpoints = useMemo(() => {
    if (!showFailed) return checkpoints.filter((cp) => cp.status !== 'failed')
    // Keep failed at the bottom, otherwise preserve order.
    return checkpoints
      .map((cp, index) => ({ cp, index }))
      .sort((a, b) => {
        const aFailed = a.cp.status === 'failed'
        const bFailed = b.cp.status === 'failed'
        if (aFailed !== bFailed) return aFailed ? 1 : -1
        return a.index - b.index
      })
      .map(({ cp }) => cp)
  }, [checkpoints, showFailed])

  const total = data?.total ?? 0
  const totalPages = Math.ceil(total / PER_PAGE)

  const columns: Column<CheckpointItem>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (cp) => (
        <span className="text-foreground font-medium">{cp.name}</span>
      ),
    },
    {
      key: 'sandbox',
      header: 'Sandbox',
      cell: (cp) => <code className="font-mono text-xs">{cp.sandboxId}</code>,
    },
    {
      key: 'type',
      header: 'Type',
      cell: (cp) => (
        <div className="flex flex-col gap-1">
          <Badge
            variant={cp.kind === 'disk_only' ? 'secondary' : 'outline'}
            className="w-fit"
          >
            {checkpointTypeLabel(cp)}
          </Badge>
          <span className="text-muted-foreground text-xs">
            {checkpointTypeDetail(cp)}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (cp) => <StatusBadge status={cp.status} />,
    },
    {
      key: 'activeForks',
      header: 'Active forks',
      align: 'right',
      cell: (cp) => (
        <span className="font-mono text-xs">
          {cp.activeForks > 0 ? (
            <span className="text-status-running">{cp.activeForks}</span>
          ) : (
            <span className="text-muted-foreground">0</span>
          )}
        </span>
      ),
    },
    {
      key: 'totalForks',
      header: 'Total forks',
      align: 'right',
      cell: (cp) => (
        <span className="text-muted-foreground font-mono text-xs">
          {cp.totalForks}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      cell: (cp) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(cp.createdAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (cp) => (
        <Button
          variant="ghost"
          size="sm"
          className="text-status-error hover:text-destructive underline-offset-2 hover:bg-transparent hover:underline"
          onClick={() => setToDelete(cp)}
        >
          Delete
        </Button>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Checkpoints"
        description="Sandbox snapshots across your organization"
        actions={
          <label
            htmlFor="show-failed"
            className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-2 text-sm transition-colors"
          >
            <Checkbox
              id="show-failed"
              checked={showFailed}
              onCheckedChange={(v) => setShowFailed(v === true)}
            />
            Show failed
          </label>
        }
      />

      <Panel className="overflow-hidden">
        <ResourceTable
          columns={columns}
          rows={visibleCheckpoints}
          rowKey={(cp) => cp.id}
          loading={isLoading}
          renderSubRow={(cp) =>
            cp.status === 'failed' && cp.errorMsg ? (
              <div className="bg-status-error-bg/50 flex items-start gap-2 px-4 py-2.5">
                <CircleAlert className="text-status-error mt-px size-3.5 shrink-0" />
                <div className="min-w-0 text-xs">
                  <span className="text-status-error break-words">
                    {cp.errorMsg}
                  </span>
                  {cp.failedAt ? (
                    <span className="text-muted-foreground">
                      {' · failed '}
                      {new Date(cp.failedAt).toLocaleString()}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null
          }
          empty={
            <EmptyState
              icon={Layers}
              title={
                checkpoints.length === 0
                  ? 'No checkpoints yet'
                  : 'No checkpoints to show'
              }
              description={
                checkpoints.length === 0
                  ? 'Snapshots of your sandboxes will appear here.'
                  : 'Toggle “Show failed checkpoints” to include failures.'
              }
            />
          }
        />

        {totalPages > 1 && (
          <div className="text-muted-foreground flex items-center justify-between border-t px-4 py-3 text-sm">
            <span>
              {total} checkpoint{total !== 1 ? 's' : ''}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className="px-1 font-mono text-xs">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Panel>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title={`Delete checkpoint ${toDelete?.name ? `"${toDelete.name}"` : ''}?`}
        description="Active forks will not be affected."
        confirmLabel="Delete checkpoint"
        destructive
        pending={deleteMutation.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
