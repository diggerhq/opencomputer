import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowLeft,
  List,
  SquareTerminal,
  RotateCcw,
  Power,
  Trash2,
  ChevronRight,
} from 'lucide-react'
import {
  deleteSession,
  getSessionDetail,
  getSessionStats,
  powerCycleSession,
  rebootSession,
  type Session,
  type SessionDetail as SessionDetailData,
} from '@/api/client'
import Terminal from '@/components/Terminal'
import LogsPanel from '@/components/LogsPanel'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { MetricCard } from '@/components/metric-card'
import { CopyRow } from '@/components/copy-row'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/confirm-dialog'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`
  return `${Math.floor(hrs / 24)}d ago`
}

type ConfirmKind = 'delete' | 'reboot' | 'power-cycle' | null

export default function SessionDetail() {
  const { sandboxId } = useParams<{ sandboxId: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const [showTerminal, setShowTerminal] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [showInternal, setShowInternal] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmKind>(null)

  const { data: session, isLoading } = useQuery({
    queryKey: ['session-detail', sandboxId],
    queryFn: () => getSessionDetail(sandboxId!),
    enabled: !!sandboxId,
  })

  const { data: stats } = useQuery({
    queryKey: ['session-stats', sandboxId],
    queryFn: () => getSessionStats(sandboxId!),
    enabled: !!sandboxId && session?.status === 'running',
    refetchInterval: 5000,
    retry: false,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['session-detail', sandboxId] })
    queryClient.invalidateQueries({ queryKey: ['session-stats', sandboxId] })
    queryClient.invalidateQueries({ queryKey: ['sessions'] })
  }

  const deleteMutation = useMutation({
    mutationFn: () => deleteSession(sandboxId!),
    onMutate: async () => {
      await queryClient.cancelQueries({
        queryKey: ['session-detail', sandboxId],
      })
      const stoppedAt = new Date().toISOString()
      queryClient.setQueryData<SessionDetailData>(
        ['session-detail', sandboxId],
        (old) => (old ? { ...old, status: 'stopped', stoppedAt } : old),
      )
      queryClient.setQueriesData<Session[]>({ queryKey: ['sessions'] }, (old) =>
        old?.map((item) =>
          item.sandboxId === sandboxId
            ? { ...item, status: 'stopped', stoppedAt }
            : item,
        ),
      )
      setShowTerminal(false)
    },
    onError: (e) =>
      toast.error(
        `Delete failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    onSettled: invalidate,
  })

  const rebootMutation = useMutation({
    mutationFn: () => rebootSession(sandboxId!),
    onError: (e) =>
      toast.error(
        `Reboot failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    onSettled: invalidate,
  })

  const powerCycleMutation = useMutation({
    mutationFn: () => powerCycleSession(sandboxId!),
    onError: (e) =>
      toast.error(
        `Power-cycle failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    onSettled: invalidate,
  })

  const copyUrl = (hostname: string, key: string) => {
    void navigator.clipboard.writeText(`https://${hostname}`)
    setCopiedUrl(key)
    setTimeout(() => setCopiedUrl(null), 2000)
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (!session) {
    return (
      <Panel>
        <EmptyState
          title="Session not found"
          description="This sandbox may have been deleted."
          action={
            <Button variant="outline" onClick={() => navigate('/sessions')}>
              Back to Sessions
            </Button>
          }
        />
      </Panel>
    )
  }

  const isRunning = session.status === 'running'
  const canDelete = isRunning || session.status === 'hibernated'
  const busy =
    rebootMutation.isPending ||
    powerCycleMutation.isPending ||
    deleteMutation.isPending

  return (
    <div>
      <Link
        to="/sessions"
        className="text-muted-foreground hover:text-foreground mb-5 inline-flex items-center gap-1.5 text-sm transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back to Sessions
      </Link>

      {/* Header */}
      <Panel className="mb-4 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <code className="text-foreground font-mono text-lg font-semibold">
                {session.sandboxId}
              </code>
              <StatusBadge status={session.status} />
            </div>
            <div className="text-muted-foreground mt-1 text-sm">
              {session.template || 'base'} · Started{' '}
              {timeAgo(session.startedAt)}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant={showLogs ? 'default' : 'outline'}
              size="sm"
              onClick={() => setShowLogs((v) => !v)}
            >
              <List className="size-4" />
              Logs
            </Button>
            {isRunning ? (
              <>
                <Button
                  variant={showTerminal ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setShowTerminal((v) => !v)}
                >
                  <SquareTerminal className="size-4" />
                  Terminal
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirm('reboot')}
                >
                  <RotateCcw className="size-4" />
                  {rebootMutation.isPending ? 'Rebooting…' : 'Reboot'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirm('power-cycle')}
                >
                  <Power className="size-4" />
                  {powerCycleMutation.isPending
                    ? 'Power-cycling…'
                    : 'Power cycle'}
                </Button>
              </>
            ) : null}
            {canDelete ? (
              <Button
                size="sm"
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={busy}
                onClick={() => setConfirm('delete')}
              >
                <Trash2 className="size-4" />
                Delete
              </Button>
            ) : null}
          </div>
        </div>
      </Panel>

      {showTerminal && isRunning ? (
        <div className="mb-4">
          <Terminal
            sandboxId={sandboxId!}
            onClose={() => setShowTerminal(false)}
          />
        </div>
      ) : null}

      {showLogs ? (
        <div className="mb-4">
          <LogsPanel
            sandboxId={sandboxId!}
            onClose={() => setShowLogs(false)}
          />
        </div>
      ) : null}

      {/* Resource usage */}
      {isRunning ? (
        <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <MetricCard
            label="CPU"
            value={stats ? `${stats.cpuPercent.toFixed(1)}%` : '—'}
          />
          <MetricCard
            label="Memory"
            value={stats ? formatBytes(stats.memUsage) : '—'}
            hint={stats ? `of ${formatBytes(stats.memLimit)}` : undefined}
          />
          <MetricCard
            label="Processes"
            value={stats ? String(stats.pids) : '—'}
          />
          <MetricCard
            label="Network"
            value={stats ? `↑${formatBytes(stats.netOutput)}` : '—'}
            hint={stats ? `↓${formatBytes(stats.netInput)}` : undefined}
          />
        </div>
      ) : null}

      {/* Preview URLs */}
      {session.previewUrls && session.previewUrls.length > 0 ? (
        <Panel className="mb-4 p-6">
          <h2 className="mb-3 text-sm font-semibold">Preview URLs</h2>
          <div className="space-y-2">
            {session.previewUrls.map((url) => {
              const host = url.customHostname || url.hostname
              return (
                <PreviewUrlRow
                  key={url.id}
                  port={url.port}
                  host={host}
                  copied={copiedUrl === `${url.port}`}
                  onCopy={() => copyUrl(host, `${url.port}`)}
                />
              )
            })}
          </div>

          {session.previewUrls.some((u) => u.customHostname) ? (
            <div className="mt-3">
              <button
                onClick={() => setShowInternal((v) => !v)}
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
              >
                <ChevronRight
                  className={`size-3.5 transition-transform ${showInternal ? 'rotate-90' : ''}`}
                />
                Internal URLs
              </button>
              {showInternal ? (
                <div className="mt-2 space-y-2">
                  {session.previewUrls.map((url) => (
                    <PreviewUrlRow
                      key={`int-${url.id}`}
                      port={url.port}
                      host={url.hostname}
                      copied={copiedUrl === `int-${url.port}`}
                      onCopy={() => copyUrl(url.hostname, `int-${url.port}`)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </Panel>
      ) : null}

      {/* Details */}
      <Panel className="mb-4 p-6">
        <h2 className="mb-4 text-sm font-semibold">Details</h2>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
          <Detail label="Template" value={session.template || 'base'} />
          <Detail
            label="Timeout"
            value={`${session.config?.timeout ?? 300}s`}
          />
          <Detail label="CPUs" value={String(session.config?.cpuCount ?? 1)} />
          <Detail
            label="Memory"
            value={`${session.config?.memoryMB ?? 512} MB`}
          />
          <Detail
            label="Started"
            value={new Date(session.startedAt).toLocaleString()}
          />
          {session.stoppedAt ? (
            <Detail
              label="Stopped"
              value={new Date(session.stoppedAt).toLocaleString()}
            />
          ) : null}
          {session.errorMsg ? (
            <Detail label="Error" value={session.errorMsg} error />
          ) : null}
        </dl>
        {isRunning ? (
          <div className="mt-4 space-y-1.5">
            <div className="text-muted-foreground text-xs">CLI shell</div>
            <CopyRow value={`oc shell ${session.sandboxId}`} />
          </div>
        ) : null}
      </Panel>

      {/* Checkpoint */}
      {session.checkpoint ? (
        <Panel className="p-6">
          <h2 className="mb-4 text-sm font-semibold">Checkpoint</h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <Detail
              label="Size"
              value={formatBytes(session.checkpoint.sizeBytes)}
            />
            <Detail
              label="Hibernated"
              value={new Date(session.checkpoint.hibernatedAt).toLocaleString()}
            />
          </dl>
        </Panel>
      ) : null}

      <ConfirmDialog
        open={confirm === 'reboot'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Reboot this sandbox?"
        description="The guest kernel restarts. Running processes are killed; workspace data is preserved. Takes a few seconds."
        confirmLabel="Reboot"
        pending={rebootMutation.isPending}
        onConfirm={() =>
          rebootMutation.mutate(undefined, {
            onSuccess: () => setConfirm(null),
          })
        }
      />
      <ConfirmDialog
        open={confirm === 'power-cycle'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Power-cycle this sandbox?"
        description="The VM is destroyed and recreated with the same disks — use this if a reboot didn't recover. Workspace data is preserved; takes ~30 seconds."
        confirmLabel="Power cycle"
        pending={powerCycleMutation.isPending}
        onConfirm={() =>
          powerCycleMutation.mutate(undefined, {
            onSuccess: () => setConfirm(null),
          })
        }
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete sandbox ${session.sandboxId}?`}
        description="The sandbox will be stopped and its preview URLs removed."
        confirmLabel="Delete sandbox"
        destructive
        pending={deleteMutation.isPending}
        onConfirm={() =>
          deleteMutation.mutate(undefined, {
            onSuccess: () => setConfirm(null),
          })
        }
      />
    </div>
  )
}

function PreviewUrlRow({
  port,
  host,
  copied,
  onCopy,
}: {
  port: number
  host: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-muted-foreground w-12 shrink-0 font-mono text-xs">
        :{port}
      </span>
      <a
        href={`https://${host}`}
        target="_blank"
        rel="noopener noreferrer"
        className="bg-panel-2 text-foreground flex-1 truncate rounded-md border px-3 py-2 font-mono text-[13px] hover:underline"
      >
        https://{host}
      </a>
      <Button variant="ghost" size="sm" onClick={onCopy}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

function Detail({
  label,
  value,
  error,
}: {
  label: string
  value: string
  error?: boolean
}) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd
        className={`font-mono text-[13px] break-all ${error ? 'text-status-error' : 'text-foreground'}`}
      >
        {value}
      </dd>
    </div>
  )
}
