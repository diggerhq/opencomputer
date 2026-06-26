import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Package } from 'lucide-react'
import { deleteImage, getImages, type ImageCacheItem } from '@/api/client'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ResourceTable, type Column } from '@/components/resource-table'

function formatSteps(manifest: Record<string, unknown>): string {
  const steps = manifest.steps as Array<Record<string, unknown>> | undefined
  if (!steps || steps.length === 0) return 'base'
  return steps
    .map((s) => {
      const t = s.type as string
      const args = s.args as Record<string, unknown> | undefined
      switch (t) {
        case 'apt_install':
          return `apt: ${(args?.packages as string[])?.join(', ') || '...'}`
        case 'pip_install':
          return `pip: ${(args?.packages as string[])?.join(', ') || '...'}`
        case 'run':
          return `run: ${((args?.commands as string[]) || []).length} cmd(s)`
        case 'env':
          return `env: ${Object.keys((args?.vars as Record<string, string>) || {}).length} var(s)`
        case 'workdir':
          return `workdir: ${args?.path || '...'}`
        case 'add_file':
          return `file: ${args?.path || '...'}`
        default:
          return t
      }
    })
    .join(' + ')
}

export default function Templates() {
  const queryClient = useQueryClient()
  const [toDelete, setToDelete] = useState<ImageCacheItem | null>(null)

  const { data: images, isLoading } = useQuery({
    queryKey: ['images'],
    queryFn: () => getImages(),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteImage(id),
    onError: (error) =>
      toast.error(
        `Delete failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['images'] }),
  })

  const confirmDelete = () => {
    if (!toDelete) return
    deleteMutation.mutate(toDelete.id, { onSuccess: () => setToDelete(null) })
  }

  const columns: Column<ImageCacheItem>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (img) =>
        img.name ? (
          <span className="text-foreground font-medium">{img.name}</span>
        ) : (
          <span className="text-muted-foreground italic">auto-cached</span>
        ),
    },
    {
      key: 'steps',
      header: 'Steps',
      cell: (img) => (
        <span className="text-muted-foreground block max-w-[300px] truncate text-xs">
          {formatSteps(img.manifest)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (img) => <StatusBadge status={img.status} />,
    },
    {
      key: 'checkpoint',
      header: 'Checkpoint',
      cell: (img) =>
        img.checkpointId ? (
          <code className="font-mono text-xs">
            {img.checkpointId.slice(0, 8)}
          </code>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'lastUsed',
      header: 'Last used',
      cell: (img) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(img.lastUsedAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      cell: (img) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(img.createdAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (img) => (
        <Button
          variant="ghost"
          size="sm"
          className="text-status-error hover:bg-status-error-bg hover:text-status-error"
          onClick={() => setToDelete(img)}
        >
          Delete
        </Button>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Templates"
        description="Declarative image snapshots for your organization"
      />

      <Panel className="overflow-hidden">
        <ResourceTable
          columns={columns}
          rows={images ?? []}
          rowKey={(img) => img.id}
          loading={isLoading}
          empty={
            <EmptyState
              icon={Package}
              title="No templates yet"
              description={
                <>
                  Create one with the SDK using{' '}
                  <code className="bg-muted text-foreground rounded px-1.5 py-0.5 font-mono text-xs">
                    Image.base().aptInstall([…])
                  </code>{' '}
                  or{' '}
                  <code className="bg-muted text-foreground rounded px-1.5 py-0.5 font-mono text-xs">
                    snapshots.create()
                  </code>
                  .
                </>
              }
            />
          }
        />
      </Panel>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title={`Delete ${toDelete?.name ? `"${toDelete.name}"` : 'this cached image'}?`}
        description="Existing sandboxes will not be affected."
        confirmLabel="Delete template"
        destructive
        pending={deleteMutation.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
