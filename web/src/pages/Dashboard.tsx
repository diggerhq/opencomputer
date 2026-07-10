import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import {
  ArrowLeft,
  BarChart3,
  Boxes,
  ChevronDown,
  Code2,
  Globe,
  MessagesSquare,
  Sparkles,
  Terminal,
} from 'lucide-react'
import {
  createAPIKey,
  getAPIKeys,
  getSandboxes,
  getSessions,
  getAgents,
  createAgent,
  createSession,
  createSandbox,
  getMe,
  getBilling,
  type Sandbox,
} from '@/api/client'
import type { Session } from '@/api/schemas'
import { usePrefetchSandbox } from '@/hooks/use-prefetch'
import { PageHeader } from '@/components/page-header'
import { Panel, PanelHeader, PanelTitle } from '@/components/panel'
import { MetricCard } from '@/components/metric-card'
import { CopyRow } from '@/components/copy-row'
import { CodeOffRamp, type CodeTab } from '@/components/code-off-ramp'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ResourceTable, type Column } from '@/components/resource-table'
import { Button } from '@/components/ui/button'
import { DEFAULT_RUNTIME, defaultModelFor } from '@/lib/runtimes'

const SKILL_INSTALL_CMD = 'npx skills add diggerhq/opencomputer'

// One-click launch defaults. Mirrors the Create-agent dialog's defaults so the
// dashboard button produces the same agent the modal would — but with the
// "managed" credential (run via OpenComputer, billed to credits, no BYO key) so
// a brand-new user with no key can go straight to a live session.
const QUICKLAUNCH_PROMPT =
  'You are a helpful AI assistant working in a sandboxed computer. Complete tasks end to end, use the tools available to you, and keep your answers clear and concise. When something is ambiguous, make a sensible assumption and say so.'
// Starter task so the agent does something visible the moment the session opens.
const QUICKLAUNCH_TASK =
  'Give me a quick tour of this sandbox: check the OS and what tools/languages are installed, then suggest three things we could build together.'
const QL_ADJ = ['swift', 'calm', 'bright', 'clever', 'bold', 'quiet', 'keen', 'brave', 'nimble', 'lucid', 'deft', 'vivid']
const QL_NOUN = ['otter', 'harbor', 'falcon', 'cedar', 'comet', 'ember', 'grove', 'heron', 'lynx', 'nova', 'quartz', 'willow']
function quicklaunchName(): string {
  const pick = (a: readonly string[]) => a[Math.floor(Math.random() * a.length)]
  return `${pick(QL_ADJ)}-${pick(QL_NOUN)}`
}

// Example tasks shown as chips on the launch card — concrete starting points so a
// new user sees what the product actually does, instead of a blank button.
const QUICKLAUNCH_TASKS: { icon: typeof BarChart3; label: string; task: string }[] = [
  {
    icon: BarChart3,
    label: 'Analyze a CSV',
    task: 'Create a small sample sales CSV, analyze it with Python, and produce a chart summarizing the key trends.',
  },
  {
    icon: Globe,
    label: 'Build a web app',
    task: 'Build a small working single-page web app, start a dev server, and give me the preview URL so I can see it.',
  },
  {
    icon: Terminal,
    label: 'Write & run a script',
    task: 'Write a short Python script that prints the current date/time and basic system info, then run it and show me the output.',
  },
]

// Sandbox example chips. Unlike the agent chips (which are tasks for Claude), a
// sandbox has no "task" — so each chip creates the box and lands you somewhere
// useful: two auto-run a starter command in the terminal; "Drive it from code"
// jumps to the Connect panel (SDK snippets). Commands lean on python3 (always
// present on the base image) so the demo is self-contained — no external routing.
// "Host a web app" is a webApp intent (not a static command): the sandbox page
// exposes :8000, then builds the terminal command with the real preview hostname
// so it can echo the live URL. See buildWebAppCommand in SandboxDetail.
const SANDBOX_TRY_TOOL_CMD =
  `echo "Python $(python3 --version 2>&1 | cut -d' ' -f2)  ·  Node $(node --version)  ·  $(uname -sr)" && echo "It's a real machine — try: pip install <pkg>  or  npm i <pkg>"`

type SandboxIntent = {
  startupCommand?: string
  focus?: 'connect'
  exposePort?: number
  webApp?: boolean
}
const SANDBOX_EXAMPLES: {
  icon: typeof Globe
  label: string
  intent: SandboxIntent
}[] = [
  {
    icon: Globe,
    label: 'Host a web app',
    intent: { exposePort: 8000, webApp: true },
  },
  {
    icon: Terminal,
    label: 'Try a tool',
    intent: { startupCommand: SANDBOX_TRY_TOOL_CMD },
  },
  { icon: Code2, label: 'Use from code', intent: { focus: 'connect' } },
]

// Dev off-ramps: the exact public API/SDK/CLI calls each one-click card runs
// under the hood. Surfaced (collapsed) so technical users see the dashboard is a
// thin client over the API and can copy the real call. Kept in sync with the
// launchMutation / createSandboxMutation bodies below.
const AGENT_CODE: CodeTab[] = [
  {
    label: 'SDK',
    code: `import { OpenComputer } from "@opencomputer/sdk";

const oc = new OpenComputer({ apiKey: process.env.OPENCOMPUTER_API_KEY });

// Create a managed agent — billed to your OpenComputer credits, no model key
const agent = await oc.agents.create({
  name: "my-agent",
  runtime: "claude",
  model: "anthropic/claude-opus-4-8",
  prompt: "You are a helpful AI assistant working in a sandboxed computer.",
  credential: "managed",
});

// Start a session — returns a browser-safe client token you can stream from
const session = await oc.sessions.create({
  agent: agent.id,
  input: "Give me a quick tour of this sandbox.",
});
console.log(session.id, session.clientToken);`,
  },
  {
    label: 'CLI',
    code: `oc agent create my-agent \\
  --runtime claude --model anthropic/claude-opus-4-8 --credential managed

oc session create --agent my-agent \\
  --input "Give me a quick tour of this sandbox."`,
  },
  {
    label: 'cURL',
    code: `# 1. Create a managed agent
curl -X POST https://api.opencomputer.dev/v3/agents \\
  -H "Authorization: Bearer $OPENCOMPUTER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"my-agent","runtime":"claude","model":"anthropic/claude-opus-4-8","prompt":"You are a helpful AI assistant.","credential":"managed"}'

# 2. Start a session on that agent
curl -X POST https://api.opencomputer.dev/v3/sessions \\
  -H "Authorization: Bearer $OPENCOMPUTER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"agent":"agt_...","input":"Give me a quick tour of this sandbox."}'`,
  },
]

const SANDBOX_CODE: CodeTab[] = [
  {
    label: 'SDK',
    code: `import { Sandbox } from "@opencomputer/sdk";

const sandbox = await Sandbox.create();

const result = await sandbox.commands.run("python3 --version");
console.log(result.stdout);

// It stays alive until you kill it or it idles out
await sandbox.kill();`,
  },
  {
    label: 'CLI',
    code: `# Create a sandbox
oc create

# Run a command in it — or drop into an interactive shell
oc exec <sandbox-id> "python3 --version"
oc shell <sandbox-id>`,
  },
  {
    label: 'cURL',
    code: `curl -X POST https://app.opencomputer.dev/api/sandboxes \\
  -H "X-API-Key: $OPENCOMPUTER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"memoryMB":1024,"cpuCount":1,"networkEnabled":true}'`,
  },
]

// Derive a friendly first name from an email local part (brian+test81@… → "Brian").
function firstNameFromEmail(email: string | undefined): string {
  if (!email) return ''
  const local = email.split('@')[0]?.split('+')[0] ?? ''
  const first = local.replace(/[._-]+/g, ' ').trim().split(' ')[0] ?? ''
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : ''
}

function formatDuration(sandbox: Sandbox): string {
  const start = new Date(sandbox.startedAt).getTime()
  const end = sandbox.stoppedAt
    ? new Date(sandbox.stoppedAt).getTime()
    : Date.now()
  const secs = Math.round((end - start) / 1000)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.round(secs / 60)}m`
  return `${Math.round((secs / 3600) * 10) / 10}h`
}

// A session is "live" until it reaches a terminal state. Excluding terminal
// states (rather than allow-listing live ones) keeps new/unknown live statuses
// counted as active.
const TERMINAL_SESSION = new Set([
  'archived',
  'failed',
  'completed',
  'complete',
  'canceled',
  'cancelled',
  'error',
  'errored',
  'done',
  'expired',
])
const isLiveSession = (s: Session) =>
  !TERMINAL_SESSION.has(s.status.toLowerCase())

export default function Dashboard() {
  const prefetch = usePrefetchSandbox()
  const location = useLocation()
  const navigate = useNavigate()
  // Getting started is its own left-nav item (/getting-started). Brand-new orgs
  // also see it inline on first run (at /).
  const onGettingStartedRoute = location.pathname === '/getting-started'

  const { data: runningSandboxesData, isLoading: loadingRunningSandboxes } =
    useQuery({
      queryKey: ['sandboxes', 'running'],
      queryFn: () => getSandboxes('running'),
    })
  const { data: allSandboxesData, isLoading: loadingSandboxes } = useQuery({
    queryKey: ['sandboxes', ''],
    queryFn: () => getSandboxes(),
  })
  const { data: sessionsData, isLoading: loadingSessions } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => getSessions(),
  })
  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: getAgents,
  })

  const activeSandboxes = runningSandboxesData ?? []
  const allSandboxes = allSandboxesData ?? []
  const sessions = sessionsData ?? []
  const agents = agentsData ?? []

  const today = new Date().toISOString().slice(0, 10)
  const isToday = (iso: string) =>
    new Date(iso).toISOString().slice(0, 10) === today

  const sandboxesToday = allSandboxes.filter((s) => isToday(s.startedAt)).length
  const activeSessions = sessions.filter(isLiveSession)
  const sessionsToday = sessions.filter((s) => isToday(s.created_at)).length

  const agentName = (id?: string | null) =>
    agents.find((a) => a.id === id)?.name ?? id ?? '—'

  // First-run only when the org has neither sessions nor sandboxes — an org that
  // already runs agent sessions (but no raw sandboxes) is not a new user.
  const isFirstRun =
    !loadingSandboxes &&
    !loadingSessions &&
    allSandboxes.length === 0 &&
    sessions.length === 0

  // Genuine first-run auto-shows onboarding; returning users reach it via the
  // left-nav "Getting started" item (/getting-started).
  const showOnboarding = isFirstRun || onGettingStartedRoute

  const sessionColumns: Column<Session>[] = [
    {
      key: 'id',
      header: 'Session',
      cell: (s) => (
        <Link
          to={`/sessions/${s.id}`}
          className="text-foreground font-mono text-[13px] underline-offset-4 hover:underline"
        >
          {s.id}
        </Link>
      ),
    },
    {
      key: 'agent',
      header: 'Agent',
      cell: (s) => (
        <span className="text-muted-foreground">{agentName(s.agent_id)}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (s) => <StatusBadge status={s.status} />,
    },
    {
      key: 'created',
      header: 'Created',
      cell: (s) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(s.created_at).toLocaleString()}
        </span>
      ),
    },
  ]

  const sandboxColumns: Column<Sandbox>[] = [
    {
      key: 'id',
      header: 'Sandbox ID',
      cell: (s) => (
        <Link
          to={`/sandboxes/${s.sandboxId}`}
          onMouseEnter={() => prefetch(s.sandboxId)}
          onFocus={() => prefetch(s.sandboxId)}
          className="text-foreground font-mono text-[13px] underline-offset-4 hover:underline"
        >
          {s.sandboxId}
        </Link>
      ),
    },
    {
      key: 'template',
      header: 'Template',
      cell: (s) => (
        <span className="text-muted-foreground">{s.template || 'base'}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (s) => <StatusBadge status={s.status} />,
    },
    {
      key: 'started',
      header: 'Started',
      cell: (s) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(s.startedAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'duration',
      header: 'Duration',
      cell: (s) => (
        <span className="text-muted-foreground font-mono text-xs">
          {formatDuration(s)}
        </span>
      ),
    },
  ]

  return (
    <div>
      {!showOnboarding && (
        <PageHeader
          title="Dashboard"
          description="Overview of your agent sessions and sandboxes"
        />
      )}

      {showOnboarding ? (
        <GettingStarted
          onBack={onGettingStartedRoute ? () => navigate('/') : undefined}
        />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard
              label="Active agent sessions"
              value={
                loadingSessions ? '—' : activeSessions.length.toLocaleString()
              }
            />
            <MetricCard
              label="Agent sessions today"
              value={loadingSessions ? '—' : sessionsToday.toLocaleString()}
            />
            <MetricCard
              label="Active sandboxes"
              value={
                loadingRunningSandboxes
                  ? '—'
                  : activeSandboxes.length.toLocaleString()
              }
            />
            <MetricCard
              label="Sandboxes today"
              value={loadingSandboxes ? '—' : sandboxesToday.toLocaleString()}
            />
          </div>

          <Panel className="overflow-hidden">
            <PanelHeader>
              <PanelTitle>Recent agent sessions</PanelTitle>
              <Link
                to="/sessions"
                className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
              >
                View all
              </Link>
            </PanelHeader>
            <ResourceTable
              columns={sessionColumns}
              rows={sessions.slice(0, 10)}
              rowKey={(s) => s.id}
              loading={loadingSessions}
              empty={
                <EmptyState
                  icon={MessagesSquare}
                  title="No sessions yet"
                  description="Start a session from an agent to give it a durable task."
                />
              }
            />
          </Panel>

          <Panel className="overflow-hidden">
            <PanelHeader>
              <PanelTitle>Recent sandboxes</PanelTitle>
              <Link
                to="/sandboxes"
                className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
              >
                View all
              </Link>
            </PanelHeader>
            <ResourceTable
              columns={sandboxColumns}
              rows={allSandboxes.slice(0, 10)}
              rowKey={(s) => s.id}
              loading={loadingSandboxes}
              empty={
                <EmptyState
                  icon={Boxes}
                  title="No sandboxes yet"
                  description="Sandboxes you start will show up here."
                />
              }
            />
          </Panel>
        </div>
      )}
    </div>
  )
}

/* ── First-run onboarding ─────────────────────────────────────────────────── */
function GettingStarted({ onBack }: { onBack?: () => void }) {
  const queryClient = useQueryClient()
  const {
    data: keys,
    isLoading: loadingKeys,
    isSuccess: keysLoaded,
  } = useQuery({
    queryKey: ['api-keys'],
    queryFn: getAPIKeys,
  })
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: getMe })
  const { data: billing } = useQuery({ queryKey: ['billing'], queryFn: getBilling })
  const autoCreateRef = useRef(false)
  const [showTerminal, setShowTerminal] = useState(false)

  const navigate = useNavigate()

  const createMutation = useMutation({
    mutationFn: () => createAPIKey('Default'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['api-keys'] }),
  })

  // One click: create a managed agent + start a session on it (with the given
  // task), then drop the user straight onto the live session screen. No skill,
  // no key, no terminal. The task varies by which chip/button the user picked.
  const launchMutation = useMutation({
    mutationFn: async (task: string) => {
      const agent = await createAgent({
        name: quicklaunchName(),
        prompt: QUICKLAUNCH_PROMPT,
        model: defaultModelFor(DEFAULT_RUNTIME),
        runtime: DEFAULT_RUNTIME,
        credential: 'managed', // run via OpenComputer, billed to credits, no BYO key
      })
      return createSession({ agent: agent.id, input: task })
    },
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      // Land on the session with the first-run guided overlay (maps this UI to
      // the API calls that produced it). SessionDetail reads this nav state.
      void navigate(`/sessions/${session.id}`, { state: { guide: 'agent' } })
    },
  })
  const launching = launchMutation.isPending

  // Second door: create a real sandbox and drop into its live terminal. Goes
  // through the CP (edge → home cell → /internal/sandboxes/create), so unlike
  // the managed-agent path this works end to end today.
  const createSandboxMutation = useMutation({
    mutationFn: (_intent: SandboxIntent) =>
      createSandbox({ memoryMB: 1024, cpuCount: 1, networkEnabled: true }),
    onSuccess: (sb, intent) => {
      void queryClient.invalidateQueries({ queryKey: ['sandboxes'] })
      // Always land with the first-run guided overlay (SandboxDetail reads
      // `guide`); the chip's intent fields order the tour to lead with its step.
      void navigate(`/sandboxes/${sb.sandboxID}`, {
        state: { ...intent, guide: true },
      })
    },
  })
  const creatingSandbox = createSandboxMutation.isPending

  const hasKeys = (keys?.length ?? 0) > 0
  const createdKey = createMutation.data?.key ?? null
  const firstName = firstNameFromEmail(me?.email)
  const freeCents = billing?.freeCreditsRemainingCents ?? null

  // On first signup (no keys), auto-create a Default key so the user sees it
  // immediately without clicking anything.
  useEffect(() => {
    // Only auto-create after a SUCCESSFUL (empty) keys list — never after the
    // list errored (keys would be undefined → falsely "no keys").
    if (!keysLoaded || autoCreateRef.current) return
    if (!hasKeys && !createdKey && !createMutation.isPending) {
      autoCreateRef.current = true
      createMutation.mutate()
    }
  }, [keysLoaded, hasKeys, createdKey, createMutation])

  return (
    <div className="space-y-5">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground -mb-1 inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
        >
          <ArrowLeft className="size-3.5" />
          Back to dashboard
        </button>
      ) : null}

      {/* Personalized welcome + reassurance in the first paint */}
      <div className="space-y-2">
        <h2 className="text-foreground text-2xl font-semibold tracking-tight">
          Welcome{firstName ? `, ${firstName}` : ''}.
        </h2>
        <p className="text-muted-foreground text-sm">
          {freeCents != null && freeCents > 0
            ? `$${(freeCents / 100).toFixed(2)} in free credits. Give your agent a real computer.`
            : 'Run a managed Claude agent in an isolated cloud sandbox, ready in seconds.'}
        </p>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5 text-xs">
          <span>Claude Opus</span>
          <span aria-hidden>·</span>
          <span>Isolated cloud VM</span>
          <span aria-hidden>·</span>
          <span>Real-time execution</span>
        </div>
      </div>

      {/* Agent card — primary door, with concrete example tasks */}
      <Panel className="p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h3 className="text-foreground text-base font-semibold">
              Run an agent
            </h3>
            <p className="text-muted-foreground text-sm">
              Run a Claude agent in an isolated sandbox and monitor its work in
              real time. Billed to your account credits.
            </p>
          </div>
          <Button
            size="lg"
            className="shrink-0"
            onClick={() => launchMutation.mutate(QUICKLAUNCH_TASK)}
            disabled={launching}
          >
            <Sparkles className="size-4" />
            {launching ? 'Launching…' : 'Launch agent'}
          </Button>
        </div>

        <div className="border-border/60 mt-4 border-t pt-4">
          <p className="text-muted-foreground mb-2 text-xs">
            Start from a template:
          </p>
          <div className="flex flex-wrap gap-2">
            {QUICKLAUNCH_TASKS.map((t) => (
              <button
                key={t.label}
                type="button"
                onClick={() => launchMutation.mutate(t.task)}
                disabled={launching}
                className="border-border bg-background hover:bg-secondary text-foreground inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
              >
                <t.icon className="size-3.5" />
                {t.label}
              </button>
            ))}
          </div>
          <CodeOffRamp
            className="mt-3"
            tabs={AGENT_CODE}
            docs="https://docs.opencomputer.dev/agent-sessions/quickstart"
          />
        </div>

        {launchMutation.isError ? (
          <div className="mt-3 flex items-center gap-3">
            <span className="text-status-error text-sm">
              Couldn&apos;t launch the agent.
            </span>
            <button
              className="text-foreground text-sm font-medium underline underline-offset-4"
              onClick={() =>
                launchMutation.mutate(launchMutation.variables ?? QUICKLAUNCH_TASK)
              }
            >
              Retry
            </button>
          </div>
        ) : null}
      </Panel>

      {/* Second door: a real sandbox — a full VM you drive yourself */}
      <Panel className="p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h3 className="text-foreground text-base font-semibold">
              Work in a sandbox
            </h3>
            <p className="text-muted-foreground text-sm">
              Provision an isolated Linux environment with full shell, file, and
              network access. Control it from the browser or programmatically.
            </p>
          </div>
          <Button
            size="lg"
            variant="outline"
            className="shrink-0"
            onClick={() => createSandboxMutation.mutate({})}
            disabled={creatingSandbox}
          >
            <Boxes className="size-4" />
            {creatingSandbox ? 'Creating…' : 'Create a sandbox'}
          </Button>
        </div>

        <div className="border-border/60 mt-4 border-t pt-4">
          <p className="text-muted-foreground mb-2 text-xs">Get started:</p>
          <div className="flex flex-wrap gap-2">
            {SANDBOX_EXAMPLES.map((ex) => (
              <button
                key={ex.label}
                type="button"
                onClick={() => createSandboxMutation.mutate(ex.intent)}
                disabled={creatingSandbox}
                className="border-border bg-background hover:bg-secondary text-foreground inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
              >
                <ex.icon className="size-3.5" />
                {ex.label}
              </button>
            ))}
          </div>
          <CodeOffRamp
            className="mt-3"
            tabs={SANDBOX_CODE}
            docs="https://docs.opencomputer.dev/quickstart"
          />
        </div>

        <p className="text-muted-foreground mt-3 text-xs">
          {creatingSandbox
            ? 'Booting a fresh cloud VM…'
            : 'Ubuntu · Python and Node.js preinstalled · Interactive terminal'}
        </p>
        {createSandboxMutation.isError ? (
          <div className="mt-3 flex items-center gap-3">
            <span className="text-status-error text-sm">
              Couldn&apos;t create the sandbox.
            </span>
            <button
              className="text-foreground text-sm font-medium underline underline-offset-4"
              onClick={() => createSandboxMutation.mutate({})}
            >
              Retry
            </button>
          </div>
        ) : null}
      </Panel>

      {/* Terminal / power-user path — available, not the required first step */}
      <div>
        <button
          type="button"
          onClick={() => setShowTerminal((v) => !v)}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 px-1 text-xs font-medium"
        >
          <ChevronDown
            className={`size-3.5 transition-transform ${showTerminal ? '' : '-rotate-90'}`}
          />
          Prefer the command line? Use OpenComputer with Claude Code or the CLI
        </button>

        {showTerminal ? (
          <div className="mt-3 space-y-4">
            <StepCard
              index={1}
              title="Install the OpenComputer skill"
              description="Adds OpenComputer controls to Claude Code so you can create and manage agents, sessions, and sandboxes from your terminal."
            >
              <CopyRow value={SKILL_INSTALL_CMD} />
            </StepCard>

            <StepCard
              index={2}
              title="Your API key"
              description="The skill uses this key to authenticate with OpenComputer. We've created a Default key for you — copy it now, you won't be able to see it again."
            >
              {loadingKeys || createMutation.isPending ? (
                <p className="text-muted-foreground text-sm">
                  Preparing your API key…
                </p>
              ) : null}

              {createdKey ? (
                <div className="space-y-2.5">
                  <CopyRow value={createdKey} maskable />
                  <p className="text-muted-foreground text-xs">
                    Then run this in your terminal to configure the CLI:
                  </p>
                  <CopyRow
                    value={createdKey}
                    maskable
                    transform={(s) => `oc config set api-key ${s}`}
                  />
                </div>
              ) : null}

              {!createdKey && !createMutation.isPending && hasKeys ? (
                <p className="text-muted-foreground text-sm">
                  You already have {keys!.length} API key
                  {keys!.length === 1 ? '' : 's'} from a previous session. For
                  security, existing key values can&apos;t be re-displayed.{' '}
                  <Link
                    to="/api-keys"
                    className="text-foreground font-medium underline underline-offset-4"
                  >
                    Manage keys
                  </Link>{' '}
                  to rotate.
                </p>
              ) : null}

              {createMutation.isError ? (
                <div className="flex items-center gap-3">
                  <span className="text-status-error text-sm">
                    Failed to create your API key.
                  </span>
                  <button
                    className="text-foreground text-sm font-medium underline underline-offset-4"
                    onClick={() => createMutation.mutate()}
                  >
                    Retry
                  </button>
                </div>
              ) : null}
            </StepCard>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function StepCard({
  index,
  title,
  description,
  children,
}: {
  index: number
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <Panel className="p-5">
      <div className="flex items-start gap-4">
        <span className="bg-secondary flex size-7 shrink-0 items-center justify-center rounded-full font-mono text-sm font-semibold">
          {index}
        </span>
        <div className="flex-1 space-y-3">
          <div className="space-y-1">
            <h3 className="text-foreground text-sm font-semibold">{title}</h3>
            <p className="text-muted-foreground text-sm">{description}</p>
          </div>
          {children}
        </div>
      </div>
    </Panel>
  )
}
