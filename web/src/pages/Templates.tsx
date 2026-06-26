import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Package } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import { deleteImage, getImages, type ImageCacheItem } from '@/api/client'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ResourceTable, type Column } from '@/components/resource-table'

// Total over unknown backend data — a malformed/older manifest must not crash
// the page, so every field is guarded (no bare casts into .join()/.length).
function formatSteps(manifest: Record<string, unknown>): string {
  const steps = Array.isArray(manifest?.steps)
    ? (manifest.steps as Array<Record<string, unknown>>)
    : []
  if (steps.length === 0) return 'base'
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? (v as string[]) : []
  return steps
    .map((s) => {
      const t = typeof s?.type === 'string' ? s.type : ''
      const args = (s?.args ?? {}) as Record<string, unknown>
      switch (t) {
        case 'apt_install':
          return `apt: ${list(args.packages).join(', ') || '...'}`
        case 'pip_install':
          return `pip: ${list(args.packages).join(', ') || '...'}`
        case 'run':
          return `run: ${list(args.commands).length} cmd(s)`
        case 'env': {
          const vars = args.vars
          const n =
            vars && typeof vars === 'object' ? Object.keys(vars).length : 0
          return `env: ${n} var(s)`
        }
        case 'workdir':
          return `workdir: ${args.path ?? '...'}`
        case 'add_file':
          return `file: ${args.path ?? '...'}`
        default:
          return t || 'step'
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
    onError: (error) => notifyError("Couldn't delete the template.", error),
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
          className="text-status-error hover:text-destructive underline-offset-2 hover:bg-transparent hover:underline"
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
