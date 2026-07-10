import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { notifyError } from '@/lib/errors'
import {
  ArrowLeft,
  List,
  SquareTerminal,
  RotateCcw,
  Power,
  Trash2,
  ChevronRight,
  Loader2,
  Sparkles,
} from 'lucide-react'
import { GuidedTour, type GuideStep } from '@/components/guided-tour'
import {
  ApiError,
  createPreviewUrl,
  deletePreviewUrl,
  deleteSandbox,
  getSandboxDetail,
  getSandboxStats,
  powerCycleSandbox,
  rebootSandbox,
  type Sandbox,
  type SandboxDetail as SessionDetailData,
} from '@/api/client'
// Lazy — these pull in xterm / the SSE stream; keep them out of the main chunk.
const Terminal = lazy(() => import('@/components/Terminal'))
const LogsPanel = lazy(() => import('@/components/LogsPanel'))
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MetricCard } from '@/components/metric-card'
import { ConnectPanel } from '@/components/connect-panel'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/confirm-dialog'

// "Host a web app" demo, built once the preview hostname is known: a styled
// index.html (with a charset so the emoji renders instead of mojibake), a
// background server, then the live URL echoed into the terminal — which is the
// front-and-center element on the sandbox page.
const WEB_APP_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Live from my sandbox</title><style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 30%,#1a1a24,#0b0b0f);color:#e6e1d8}main{text-align:center;padding:2rem}h1{font-size:2.25rem;margin:0 0 .5rem}p{color:#9a948a;margin:0}.tag{display:inline-block;margin-top:1.25rem;font-family:ui-monospace,monospace;font-size:.8rem;color:#818cf8;border:1px solid #2a2a35;border-radius:999px;padding:.4rem .8rem}</style></head><body><main><h1>Hello from your sandbox 👋</h1><p>This page is served live from a real cloud VM.</p><span class="tag">OpenComputer</span></main></body></html>'

function buildWebAppCommand(hostname: string): string {
  return (
    `printf '%s' '${WEB_APP_HTML}' > index.html` +
    ` && (python3 -m http.server 8000 >/dev/null 2>&1 &)` +
    ` && sleep 1` +
    ` && echo "" && echo "🌐  Your site is LIVE — open it in a new tab:"` +
    ` && echo "    https://${hostname}" && echo ""`
  )
}

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

export default function SandboxDetail() {
  const { sandboxId } = useParams<{ sandboxId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()

  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const [showTerminal, setShowTerminal] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [showInternal, setShowInternal] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmKind>(null)

  // Consumed once from navigation state (dashboard example chips): a command to
  // auto-run in the terminal, and whether to jump to the Connect panel.
  const [startupCommand, setStartupCommand] = useState<string | undefined>(
    () => (location.state as { startupCommand?: string } | null)?.startupCommand,
  )
  const [focusConnect] = useState(
    () => (location.state as { focus?: string } | null)?.focus === 'connect',
  )
  // "Host a web app" carries a port to auto-expose once the box is running; the
  // webApp flag then runs the styled-page demo (with the real preview hostname).
  const [exposePort] = useState(
    () => (location.state as { exposePort?: number } | null)?.exposePort,
  )
  const [webApp] = useState(
    () => (location.state as { webApp?: boolean } | null)?.webApp === true,
  )
  const exposedRef = useRef(false)
  const [portInput, setPortInput] = useState('')
  const connectRef = useRef<HTMLDivElement>(null)
  const scrolledRef = useRef(false)

  // Guided first-run overlay: maps this sandbox's UI to the API/SDK/CLI that
  // achieves each thing. Ordered so the chip you launched from leads (after the
  // create step). Anchors: header, Terminal button, Preview panel, Connect panel.
  const headerRef = useRef<HTMLDivElement>(null)
  const terminalBtnRef = useRef<HTMLButtonElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const [guideOpen, setGuideOpen] = useState(
    () => (location.state as { guide?: boolean } | null)?.guide === true,
  )
  const guideSteps: GuideStep[] = useMemo(() => {
    const id = sandboxId || '<id>'
    const stepCreate: GuideStep = {
      target: headerRef,
      title: 'You created a real cloud sandbox',
      body: 'One call spun up a persistent Linux VM. It stays alive until you kill it or it idles out.',
      api: 'POST /api/sandboxes',
      code: [
        {
          label: 'SDK',
          code: `import { Sandbox } from "@opencomputer/sdk";

const sandbox = await Sandbox.create();`,
        },
        { label: 'CLI', code: `oc create` },
        {
          label: 'API',
          code: `curl -X POST https://app.opencomputer.dev/api/sandboxes \\
  -H "X-API-Key: $OPENCOMPUTER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"memoryMB":1024,"cpuCount":1,"networkEnabled":true}'`,
        },
      ],
      docs: 'https://docs.opencomputer.dev/quickstart',
    }
    const stepExec: GuideStep = {
      target: terminalBtnRef,
      title: 'Run commands in it',
      body: 'This terminal runs against the live VM. In code it is exec — install packages, run scripts, anything.',
      api: 'sandbox.exec.run(…)',
      code: [
        {
          label: 'SDK',
          code: `const { stdout } = await sandbox.exec.run("python3 --version");
console.log(stdout);`,
        },
        { label: 'CLI', code: `oc exec ${id} -- python3 --version` },
        {
          label: 'API',
          code: `curl -X POST https://app.opencomputer.dev/api/sandboxes/${id}/exec/run \\
  -H "X-API-Key: $OPENCOMPUTER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"cmd":"python3 --version"}'`,
        },
      ],
      docs: 'https://docs.opencomputer.dev/sandboxes/overview',
    }
    const stepExpose: GuideStep = {
      target: previewRef,
      title: 'Expose a port → public URL',
      body: 'Start a server in the box, then expose its port to get a public https URL — great for web apps and webhooks.',
      api: 'sandbox.createPreviewURL({ port })',
      code: [
        {
          label: 'SDK',
          code: `await sandbox.exec.run("python3 -m http.server 8000 &");
const preview = await sandbox.createPreviewURL({ port: 8000 });
console.log(preview.url);`,
        },
        { label: 'CLI', code: `oc preview create ${id} 8000` },
        {
          label: 'API',
          code: `curl -X POST https://app.opencomputer.dev/api/sandboxes/${id}/preview \\
  -H "X-API-Key: $OPENCOMPUTER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"port":8000}'`,
        },
      ],
      docs: 'https://docs.opencomputer.dev/sandboxes/preview-urls',
    }
    const stepConnect: GuideStep = {
      target: connectRef,
      title: 'Drive it from your code',
      body: 'Reconnect to this exact box by id from your own app and keep working — same VM, same state.',
      api: `Sandbox.connect("${id}")`,
      code: [
        {
          label: 'SDK',
          code: `import { Sandbox } from "@opencomputer/sdk";

const sandbox = await Sandbox.connect("${id}");
const { stdout } = await sandbox.exec.run("echo hello from code");`,
        },
        { label: 'CLI', code: `oc shell ${id}` },
      ],
      docs: 'https://docs.opencomputer.dev/sandboxes/overview',
    }
    // Lead with the step matching the chip that launched this box.
    if (webApp || exposePort) return [stepCreate, stepExpose, stepExec, stepConnect]
    if (focusConnect) return [stepCreate, stepConnect, stepExec, stepExpose]
    if (startupCommand) return [stepCreate, stepExec, stepExpose, stepConnect]
    return [stepCreate, stepExec, stepExpose, stepConnect]
  }, [sandboxId, webApp, exposePort, focusConnect, startupCommand])

  // On arrival from an example chip: open the terminal (so the startup command
  // has somewhere to run) and wipe history state so a refresh doesn't re-fire.
  useEffect(() => {
    if (startupCommand) setShowTerminal(true)
    if (location.state) window.history.replaceState({}, '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { data: session, isLoading } = useQuery({
    queryKey: ['sandbox-detail', sandboxId],
    queryFn: () => getSandboxDetail(sandboxId!),
    enabled: !!sandboxId,
    // A just-created sandbox is briefly not-yet-queryable on the cell (create
    // returns before the read path is consistent, so the detail GET 404s for a
    // few seconds). Retry a 404 through the boot window — the skeleton stays up
    // instead of flashing "Sandbox not found" — then give up for a real 404.
    retry: (failureCount, error) =>
      failureCount < 10 && error instanceof ApiError && error.status === 404,
    retryDelay: 1000,
  })

  const { data: stats } = useQuery({
    queryKey: ['sandbox-stats', sandboxId],
    queryFn: () => getSandboxStats(sandboxId!),
    enabled: !!sandboxId && session?.status === 'running',
    refetchInterval: 5000,
    retry: false,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ['sandbox-detail', sandboxId],
    })
    void queryClient.invalidateQueries({
      queryKey: ['sandbox-stats', sandboxId],
    })
    void queryClient.invalidateQueries({ queryKey: ['sandboxes'] })
  }

  const deleteMutation = useMutation({
    mutationFn: () => deleteSandbox(sandboxId!),
    onMutate: async () => {
      await queryClient.cancelQueries({
        queryKey: ['sandbox-detail', sandboxId],
      })
      const stoppedAt = new Date().toISOString()
      queryClient.setQueryData<SessionDetailData>(
        ['sandbox-detail', sandboxId],
        (old) => (old ? { ...old, status: 'stopped', stoppedAt } : old),
      )
      queryClient.setQueriesData<Sandbox[]>(
        { queryKey: ['sandboxes'] },
        (old) =>
          old?.map((item) =>
            item.sandboxId === sandboxId
              ? { ...item, status: 'stopped', stoppedAt }
              : item,
          ),
      )
      setShowTerminal(false)
    },
    onError: (e) => notifyError("Couldn't delete the sandbox.", e),
    onSettled: invalidate,
  })

  const rebootMutation = useMutation({
    mutationFn: () => rebootSandbox(sandboxId!),
    onError: (e) => notifyError("Couldn't reboot the sandbox.", e),
    onSettled: invalidate,
  })

  const powerCycleMutation = useMutation({
    mutationFn: () => powerCycleSandbox(sandboxId!),
    onError: (e) => notifyError("Couldn't power-cycle the sandbox.", e),
    onSettled: invalidate,
  })

  const createPreviewMutation = useMutation({
    mutationFn: (port: number) => createPreviewUrl(sandboxId!, port),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['sandbox-detail', sandboxId],
      }),
    onError: (e) => notifyError("Couldn't expose the port.", e),
  })

  const deletePreviewMutation = useMutation({
    mutationFn: (port: number) => deletePreviewUrl(sandboxId!, port),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['sandbox-detail', sandboxId],
      }),
    onError: (e) => notifyError("Couldn't remove the preview URL.", e),
  })

  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    },
    [],
  )

  // "Drive it from code" chip: once the sandbox has loaded, bring the Connect
  // panel into view so the SDK snippets are the first thing you see.
  useEffect(() => {
    if (focusConnect && !scrolledRef.current && session && connectRef.current) {
      scrolledRef.current = true
      connectRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [focusConnect, session])

  // "Host a web app" chip: once the box is running, auto-expose the port so the
  // Preview URLs section fills in with a real clickable link (skip if one for
  // that port already exists).
  useEffect(() => {
    if (exposedRef.current || !exposePort || session?.status !== 'running')
      return
    exposedRef.current = true
    const existing = session.previewUrls?.find((u) => u.port === exposePort)
    if (existing) {
      if (webApp) {
        setStartupCommand(buildWebAppCommand(existing.hostname))
        setShowTerminal(true)
      }
      return
    }
    createPreviewMutation.mutate(exposePort, {
      onSuccess: (pv) => {
        if (webApp && pv?.hostname) {
          setStartupCommand(buildWebAppCommand(pv.hostname))
          setShowTerminal(true)
        }
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exposePort, session])

  const copyUrl = (hostname: string, key: string) => {
    void navigator.clipboard.writeText(`https://${hostname}`).then(
      () => {
        setCopiedUrl(key)
        if (copyTimer.current) clearTimeout(copyTimer.current)
        copyTimer.current = setTimeout(() => setCopiedUrl(null), 2000)
      },
      (e: unknown) => notifyError("Couldn't copy to clipboard.", e),
    )
  }

  if (isLoading) {
    return (
      <div>
        <Link
          to="/sandboxes"
          className="text-muted-foreground hover:text-foreground mb-5 inline-flex items-center gap-1.5 text-sm transition-colors"
        >
          <ArrowLeft className="size-4" />
          Back to Sandboxes
        </Link>
        <Panel className="p-8">
          <div className="flex flex-col items-center justify-center gap-3 py-6 text-center">
            <Loader2 className="text-muted-foreground size-6 animate-spin" />
            <div className="space-y-1">
              <p className="text-foreground text-sm font-medium">
                Provisioning your sandbox…
              </p>
              <p className="text-muted-foreground text-xs">
                Booting a fresh cloud VM
                {sandboxId ? ` · ${sandboxId}` : ''}…
              </p>
            </div>
          </div>
        </Panel>
      </div>
    )
  }

  if (!session) {
    return (
      <Panel>
        <EmptyState
          title="Sandbox not found"
          description="This sandbox may have been deleted."
          action={
            <Button
              variant="outline"
              onClick={() => void navigate('/sandboxes')}
            >
              Back to Sandboxes
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
        to="/sandboxes"
        className="text-muted-foreground hover:text-foreground mb-5 inline-flex items-center gap-1.5 text-sm transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back to Sandboxes
      </Link>

      <GuidedTour
        steps={guideSteps}
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
      />

      {/* Header */}
      <Panel ref={headerRef} className="mb-4 p-6">
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
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setGuideOpen(true)}
            >
              <Sparkles className="size-4" />
              How it works
            </Button>
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
                  ref={terminalBtnRef}
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
          <Suspense fallback={<PanelLoading />}>
            <Terminal
              sandboxId={sandboxId!}
              startupCommand={startupCommand}
              onStarted={() => setStartupCommand(undefined)}
              onClose={() => setShowTerminal(false)}
            />
          </Suspense>
        </div>
      ) : null}

      {showLogs ? (
        <div className="mb-4">
          <Suspense fallback={<PanelLoading />}>
            <LogsPanel
              sandboxId={sandboxId!}
              onClose={() => setShowLogs(false)}
            />
          </Suspense>
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

      {/* Preview URLs — expose a port to get a public https URL */}
      {isRunning || (session.previewUrls?.length ?? 0) > 0 ? (
        <Panel ref={previewRef} className="mb-4 p-6">
          <h2 className="mb-3 text-sm font-semibold">Preview URLs</h2>
          {session.previewUrls && session.previewUrls.length > 0 ? (
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
                    onRemove={
                      isRunning
                        ? () => deletePreviewMutation.mutate(url.port)
                        : undefined
                    }
                    removing={
                      deletePreviewMutation.isPending &&
                      deletePreviewMutation.variables === url.port
                    }
                  />
                )
              })}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              No ports exposed yet — start a server in the sandbox, then expose
              its port to get a public URL.
            </p>
          )}

          {isRunning ? (
            <form
              className="mt-3 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                const port = Number(portInput)
                if (Number.isInteger(port) && port >= 1 && port <= 65535) {
                  createPreviewMutation.mutate(port, {
                    onSuccess: () => setPortInput(''),
                  })
                }
              }}
            >
              <Input
                type="number"
                min={1}
                max={65535}
                placeholder="Port (e.g. 8000)"
                value={portInput}
                onChange={(e) => setPortInput(e.target.value)}
                className="w-44"
              />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={createPreviewMutation.isPending || !portInput}
              >
                {createPreviewMutation.isPending ? 'Exposing…' : 'Expose port'}
              </Button>
            </form>
          ) : null}

          {session.previewUrls &&
          session.previewUrls.some((u) => u.customHostname) ? (
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

      {/* Connect — shell in / drive from code */}
      <div ref={connectRef} className="mb-4 scroll-mt-6">
        <ConnectPanel sandboxId={session.sandboxId} />
      </div>

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

// Dark fallback while a lazy panel (Terminal / Logs) chunk loads.
function PanelLoading() {
  return (
    <div className="bg-terminal border-code-border flex h-40 items-center justify-center rounded-lg border">
      <Loader2 className="text-code-muted size-5 animate-spin" />
    </div>
  )
}

function PreviewUrlRow({
  port,
  host,
  copied,
  onCopy,
  onRemove,
  removing,
}: {
  port: number
  host: string
  copied: boolean
  onCopy: () => void
  onRemove?: () => void
  removing?: boolean
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
      {onRemove ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          disabled={removing}
          className="text-muted-foreground"
        >
          {removing ? '…' : 'Remove'}
        </Button>
      ) : null}
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
