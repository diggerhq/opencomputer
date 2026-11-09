// Opt-in, dev-only mock API for VITE_PREVIEW.
//
// Lets the dashboard render with no backend and no WorkOS auth so screens can
// be reviewed / screenshotted locally. It is gated behind `VITE_PREVIEW` in
// apiFetch() and dynamically imported, so it is never included in a normal
// build (the branch is dead code when the flag is unset).
//
// Run it with:  VITE_PREVIEW=1 npm run dev
//
// Returns are cast to the caller's T — mock objects only need the fields a
// screen actually reads, not the full interface.

import { ApiError } from './errors'

// Fixed clock so screenshots are deterministic.
const BASE = new Date('2026-06-26T17:00:00Z').getTime()
const at = (daysAgo: number, hoursAgo = 0) =>
  new Date(BASE - daysAgo * 86_400_000 - hoursAgo * 3_600_000).toISOString()

const me = {
  id: 'user_2abc',
  email: 'igor@digger.dev',
  orgId: 'org_digger',
  infrastructureEnabled: true,
  computerEnabled: true,
  orgs: [
    { id: 'org_digger', name: 'Digger', isPersonal: false, isActive: true },
    { id: 'org_personal', name: 'Personal', isPersonal: true, isActive: false },
  ],
}

const sandboxes = [
  {
    id: 's1',
    sandboxId: 'sbx_a1b2c3d4e5',
    orgId: 'org_digger',
    template: 'python-3.12',
    region: 'us-east-1',
    workerId: 'w1',
    status: 'running',
    startedAt: at(0, 3),
  },
  {
    id: 's2',
    sandboxId: 'sbx_f6g7h8i9j0',
    orgId: 'org_digger',
    template: 'base',
    region: 'us-east-1',
    workerId: 'w1',
    status: 'running',
    startedAt: at(0, 6),
  },
  {
    id: 's3',
    sandboxId: 'sbx_k1l2m3n4o5',
    orgId: 'org_digger',
    template: 'node-20',
    region: 'eu-west-1',
    workerId: 'w2',
    status: 'hibernated',
    startedAt: at(1, 2),
  },
  {
    id: 's4',
    sandboxId: 'sbx_p6q7r8s9t0',
    orgId: 'org_digger',
    template: 'base',
    region: 'us-east-1',
    workerId: 'w1',
    status: 'stopped',
    startedAt: at(2, 5),
    stoppedAt: at(2, 1),
  },
  {
    id: 's5',
    sandboxId: 'sbx_u1v2w3x4y5',
    orgId: 'org_digger',
    template: 'python-3.12',
    region: 'us-east-1',
    workerId: 'w2',
    status: 'error',
    startedAt: at(3, 4),
    errorMsg: 'sandbox boot timed out after 120s',
  },
  {
    id: 's6',
    sandboxId: 'sbx_z6a7b8c9d0',
    orgId: 'org_digger',
    template: 'rust-1.80',
    region: 'eu-west-1',
    workerId: 'w2',
    status: 'stopped',
    startedAt: at(5, 8),
    stoppedAt: at(5, 2),
  },
  {
    id: 's7',
    sandboxId: 'sbx_e1f2g3h4i5',
    orgId: 'org_digger',
    template: 'base',
    region: 'us-east-1',
    workerId: 'w1',
    status: 'stopped',
    startedAt: at(6, 3),
    stoppedAt: at(6, 1),
  },
]

const browserSessions = [
  {
    id: 'br_linkedin_live',
    provider: 'kernel',
    provider_session_id: 'kernel-live-1',
    status: 'active',
    cdp_ws_url: 'wss://proxy.example.onkernel.com/browser/cdp?jwt=mock',
    webdriver_ws_url:
      'wss://proxy.example.onkernel.com/browser/webdriver/session?jwt=mock',
    live_view_url: 'https://proxy.example.onkernel.com/browser/live/mock',
    base_url: 'https://proxy.example.onkernel.com/browser/kernel/mock',
    headless: false,
    stealth: true,
    gpu: false,
    timeout_seconds: 600,
    replay_id: 'replay_live_1',
    replay_view_url: 'https://api.onkernel.com/browser/replays?replay_id=1',
    created_at: at(0, 1),
    updated_at: at(0, 1),
    deleted_at: null,
    billable_seconds: 3600,
    estimated_cost_usd: 0.48,
  },
  {
    id: 'br_inbox_headless',
    provider: 'kernel',
    provider_session_id: 'kernel-headless-1',
    status: 'active',
    cdp_ws_url: 'wss://proxy.example.onkernel.com/browser/cdp?jwt=headless',
    webdriver_ws_url:
      'wss://proxy.example.onkernel.com/browser/webdriver/session?jwt=headless',
    live_view_url: null,
    base_url: 'https://proxy.example.onkernel.com/browser/kernel/headless',
    headless: true,
    stealth: true,
    gpu: false,
    timeout_seconds: 300,
    created_at: at(0, 4),
    updated_at: at(0, 4),
    deleted_at: null,
    billable_seconds: 14400,
    estimated_cost_usd: 1.92,
  },
  {
    id: 'br_old_replay',
    provider: 'kernel',
    provider_session_id: 'kernel-old-1',
    status: 'deleted',
    cdp_ws_url: 'wss://proxy.example.onkernel.com/browser/cdp?jwt=old',
    webdriver_ws_url:
      'wss://proxy.example.onkernel.com/browser/webdriver/session?jwt=old',
    live_view_url: 'https://proxy.example.onkernel.com/browser/live/old',
    base_url: 'https://proxy.example.onkernel.com/browser/kernel/old',
    headless: false,
    stealth: true,
    gpu: false,
    timeout_seconds: 600,
    replay_id: 'replay_old_1',
    replay_view_url: 'https://api.onkernel.com/browser/replays?replay_id=old',
    created_at: at(2, 2),
    updated_at: at(2, 1),
    deleted_at: at(2, 1),
    metered_at: at(2, 1),
    metered_seconds: 3600,
    metered_usage_micro: 480000,
    billable_seconds: 3600,
    estimated_cost_usd: 0.48,
  },
]

const browserProfiles = [
  {
    id: 'prof_linkedin',
    provider: 'kernel',
    provider_profile_id: 'kernel-profile-linkedin',
    name: 'linkedin',
    created_at: at(4, 0),
    updated_at: at(0, 1),
    deleted_at: null,
    provider_created_at: at(4, 0),
    provider_updated_at: at(0, 1),
    provider_last_used_at: at(0, 1),
  },
]

const images = [
  {
    id: 'img1',
    orgId: 'org_digger',
    contentHash: 'sha256:aa11bb22',
    checkpointId: 'ckpt_aa11bb22cc33',
    name: 'ml-base',
    manifest: {
      steps: [
        { type: 'apt_install', args: { packages: ['ffmpeg', 'git'] } },
        {
          type: 'pip_install',
          args: { packages: ['torch', 'numpy', 'pandas'] },
        },
      ],
    },
    status: 'ready',
    lastUsedAt: at(0, 5),
    createdAt: at(12),
  },
  {
    id: 'img2',
    orgId: 'org_digger',
    contentHash: 'sha256:cc33dd44',
    checkpointId: 'ckpt_dd44ee55ff66',
    name: 'node-web',
    manifest: {
      steps: [
        { type: 'run', args: { commands: ['npm i -g pnpm'] } },
        { type: 'env', args: { vars: { NODE_ENV: 'production' } } },
      ],
    },
    status: 'building',
    lastUsedAt: at(1),
    createdAt: at(3),
  },
  {
    id: 'img3',
    orgId: 'org_digger',
    contentHash: 'sha256:ee55ff66',
    name: '',
    manifest: { steps: [] },
    status: 'ready',
    lastUsedAt: at(4),
    createdAt: at(20),
  },
  {
    id: 'img4',
    orgId: 'org_digger',
    contentHash: 'sha256:gg77hh88',
    name: 'broken-img',
    manifest: {
      steps: [{ type: 'apt_install', args: { packages: ['nonexistent-pkg'] } }],
    },
    status: 'failed',
    lastUsedAt: at(8),
    createdAt: at(8),
  },
]

const checkpoints = [
  {
    id: 'cp1',
    sandboxId: 'sbx_a1b2c3d4e5',
    orgId: 'org_digger',
    name: 'after-deps-install',
    status: 'ready',
    kind: 'disk_only',
    promotionStatus: 'ready',
    sizeBytes: 1_240_000_000,
    activeForks: 3,
    totalForks: 18,
    createdAt: at(0, 4),
  },
  {
    id: 'cp2',
    sandboxId: 'sbx_f6g7h8i9j0',
    orgId: 'org_digger',
    name: 'clean-base',
    status: 'ready',
    kind: 'full',
    sizeBytes: 2_900_000_000,
    activeForks: 0,
    totalForks: 2,
    createdAt: at(1, 6),
  },
  {
    id: 'cp3',
    sandboxId: 'sbx_k1l2m3n4o5',
    orgId: 'org_digger',
    name: 'web-build',
    status: 'processing',
    kind: 'disk_only',
    promotionStatus: 'processing',
    sizeBytes: 800_000_000,
    activeForks: 0,
    totalForks: 0,
    createdAt: at(0, 1),
  },
  {
    id: 'cp4',
    sandboxId: 'sbx_p6q7r8s9t0',
    orgId: 'org_digger',
    name: 'snapshot-failed',
    status: 'failed',
    kind: 'disk_only',
    sizeBytes: 0,
    activeForks: 0,
    totalForks: 0,
    createdAt: at(2, 2),
    errorMsg: 'archive upload to object store failed: connection reset by peer',
    failedAt: at(2, 1),
  },
]

const apiKeys = [
  {
    id: 'k1',
    orgId: 'org_digger',
    keyPrefix: 'osb_live_7Hq2',
    name: 'Default',
    scopes: ['*'],
    lastUsed: at(0, 2),
    createdAt: at(30),
  },
  {
    id: 'k2',
    orgId: 'org_digger',
    keyPrefix: 'osb_live_Lp9x',
    name: 'CI pipeline',
    scopes: ['sandboxes:write'],
    expiresAt: new Date(Date.now() + 76 * 86_400_000).toISOString(),
    createdAt: at(14),
  },
  {
    id: 'k3',
    orgId: 'org_digger',
    keyPrefix: 'osb_live_Qe4m',
    name: 'Demo laptop',
    scopes: ['sandboxes:write'],
    expiresAt: at(2),
    createdAt: at(9),
  },
]

// `?billing=` picks a billing state to review: trial (default), pro, max,
// max_downgrade, halted_<halt_reason>, warning_<warning>.
function autumnMock() {
  // Trial and period dates follow the real clock so "days left" reads right.
  const fromNow = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString()
  const scenario =
    typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get('billing')
  const trial = {
    isHalted: false,
    haltReason: null as string | null,
    warning: null as string | null,
    creditsRemainingCents: 1_000,
    creditBreakdown: {
      available: true,
      planRemainingCents: 1_000,
      topupRemainingCents: 0,
      otherRemainingCents: 0,
      planResetsAt: null,
    },
    concurrencyPlan: 'base',
    usagePlan: 'trial' as string,
    maxConcurrentSandboxes: 5,
    autoTopup: { enabled: false, threshold: 5, quantity: 10, budget: 100 },
    hasToppedUp: false,
    hasPaidSubscription: false,
    currency: 'usd',
    paymentPastDueAt: null,
    trialStartedAt: fromNow(-2),
    trialEndsAt: fromNow(2.9),
    workMinutes: { granted: 600, remaining: 412, resetsAt: null },
    periodEndsAt: null as string | null,
    scheduledChange: null as { to: 'pro' | 'cancel'; at: string | null } | null,
  }
  const paid = (plan: 'pro' | 'max') => ({
    ...trial,
    usagePlan: plan,
    hasPaidSubscription: true,
    hasToppedUp: true,
    creditsRemainingCents: 1_200,
    creditBreakdown: {
      ...trial.creditBreakdown,
      planRemainingCents: 0,
      topupRemainingCents: 1_200,
    },
    autoTopup: { enabled: true, threshold: 5, quantity: 10, budget: 100 },
    trialStartedAt: fromNow(-30),
    trialEndsAt: fromNow(-23),
    workMinutes: {
      granted: plan === 'pro' ? 2_000 : 25_000,
      remaining: plan === 'pro' ? 1_240 : 18_400,
      resetsAt: fromNow(12),
    },
    periodEndsAt: fromNow(12),
  })
  if (!scenario || scenario === 'trial') return trial
  if (scenario === 'pro' || scenario === 'max') return paid(scenario)
  if (scenario === 'max_downgrade')
    return {
      ...paid('max'),
      scheduledChange: { to: 'pro' as const, at: fromNow(12) },
    }
  if (scenario.startsWith('warning_'))
    return { ...trial, warning: scenario.slice('warning_'.length) }
  if (scenario.startsWith('halted_')) {
    const haltReason = scenario.slice('halted_'.length)
    const base = haltReason.startsWith('trial') ? trial : paid('pro')
    return {
      ...base,
      isHalted: true,
      haltReason,
      workMinutes: { ...base.workMinutes, remaining: 0 },
      creditsRemainingCents:
        haltReason === 'credits_empty' ? 0 : base.creditsRemainingCents,
    }
  }
  return trial
}

const billing = {
  plan: 'free',
  billingProvider: 'autumn',
  maxConcurrentSandboxes: 5,
  freeCreditsRemainingCents: 0,
  stripeCreditCents: 0,
  hasPaymentMethod: false,
}

const sandboxUsage = {
  windowDays: 30,
  totalCents: 156,
  sandboxes: [
    {
      sandboxId: 'sbx_a1b2c3d4e5',
      status: 'running',
      seconds: 12_600,
      costCents: 84,
    },
    {
      sandboxId: 'sbx_f6g7h8i9j0',
      status: 'stopped',
      seconds: 3_600,
      costCents: 24,
    },
    {
      sandboxId: 'sbx_k1l2m3n4o5',
      status: 'hibernated',
      seconds: 7_200,
      costCents: 48,
    },
  ],
}

const sessionDetail = {
  id: 's1',
  sandboxId: 'sbx_a1b2c3d4e5',
  template: 'python-3.12',
  status: 'running',
  startedAt: at(0, 3),
  config: { timeout: 3600, cpuCount: 2, memoryMB: 2048, networkEnabled: true },
  previewUrls: [
    {
      id: 'pu1',
      sandboxId: 'sbx_a1b2c3d4e5',
      orgId: 'org_digger',
      hostname: 'sbx-a1b2c3d4e5-3000.preview.opencomputer.dev',
      customHostname: 'sbx-a1b2c3d4e5-3000.acme.dev',
      port: 3000,
      sslStatus: 'active',
      authConfig: {},
      createdAt: at(0, 2),
    },
    {
      id: 'pu2',
      sandboxId: 'sbx_a1b2c3d4e5',
      orgId: 'org_digger',
      hostname: 'sbx-a1b2c3d4e5-8080.preview.opencomputer.dev',
      port: 8080,
      sslStatus: 'active',
      authConfig: {},
      createdAt: at(0, 2),
    },
  ],
}

const sandboxStats = {
  cpuPercent: 12.4,
  memUsage: 734_003_200,
  memLimit: 2_147_483_648,
  pids: 37,
  netOutput: 4_180_000,
  netInput: 12_500_000,
}

const org = {
  id: 'org_digger',
  name: 'Digger',
  slug: 'digger',
  plan: 'pro',
  maxConcurrentSandboxes: 25,
  maxSandboxTimeoutSec: 3600,
  createdAt: at(120),
  updatedAt: at(2),
  customDomain: 'acme.dev',
  domainVerificationStatus: 'pending_validation',
  domainSslStatus: 'pending',
  verificationTxtName: '_oc-verify.acme.dev',
  verificationTxtValue: 'oc-verify=abc123def456',
  sslTxtName: '_acme-challenge.acme.dev',
  sslTxtValue: 'xyz789uvw012',
  isPersonal: false,
  creditBalanceCents: 4210,
}

const orgMembers = [
  {
    membershipId: 'mem_1',
    id: 'user_2abc',
    email: 'igor@digger.dev',
    name: 'Igor',
    role: 'admin',
  },
  {
    membershipId: 'mem_2',
    id: 'user_3def',
    email: 'alex@digger.dev',
    name: 'Alex Rivera',
    role: 'member',
  },
]

const orgInvitations = [
  {
    id: 'inv_1',
    email: 'sam@acme.dev',
    state: 'pending',
    role: 'member',
    expiresAt: at(-5),
    createdAt: at(1),
  },
]

const sandboxWebhooks = [
  {
    id: 'whk_1',
    url: 'https://acme.dev/hooks/sandbox',
    eventTypes: ['sandbox.ready', 'sandbox.stopped'],
    sandboxId: null,
    name: 'Prod ingest',
    enabled: true,
    hasSecret: true,
    createdAt: at(3),
    updatedAt: at(0, 4),
  },
  {
    id: 'whk_2',
    url: 'https://hooks.internal.acme.dev/all',
    eventTypes: [],
    sandboxId: null,
    name: '',
    enabled: true,
    hasSecret: true,
    createdAt: at(8),
    updatedAt: at(8),
  },
]

const sandboxWebhookDeliveries = [
  {
    id: 'msg_1',
    attemptId: 'att_1',
    status: 'success',
    responseStatusCode: 200,
    timestamp: at(0, 1),
  },
  {
    id: 'msg_2',
    attemptId: 'att_2',
    status: 'failed',
    responseStatusCode: 500,
    timestamp: at(0, 2),
  },
]

type Handler = () => unknown

// A handler may return NOT_FOUND to mimic a 404 (mockFetch throws, like a real
// missing resource). No handler uses it today.
const NOT_FOUND = Symbol('not_found')

const managedAgentItems: Array<{
  id: string
  name: string
  activeAlias: string
  activeDeploymentId: string
  deploymentCount: number
  createdAt: string
  updatedAt: string
}> = []

let managedProjects: Array<{
  id: string
  slug: string
  name: string
  environments: Array<{
    name: 'development' | 'production'
    updatedAt: string
  }>
  agents: Array<{ id: string; name: string }>
  createdAt: string
  updatedAt: string
  // Seeded so the project routes render without creating one first. Visiting
  // /projects/prj_preview/channels used to poll a 404 forever, which reads as
  // a broken page rather than an empty one.
}> = [
  {
    id: 'prj_preview',
    slug: 'hello-world',
    name: 'Hello World',
    environments: [
      { name: 'development', updatedAt: new Date(BASE).toISOString() },
      { name: 'production', updatedAt: new Date(BASE).toISOString() },
    ],
    agents: [{ id: 'research-assistant', name: 'Research Assistant' }],
    createdAt: new Date(BASE).toISOString(),
    updatedAt: new Date(BASE).toISOString(),
  },
]

const previewServiceConnection = {
  id: 'connection_google_preview',
  kind: 'tool' as const,
  provider: 'google',
  label: 'gmail',
  agentId: 'email-triage',
  alias: 'production',
  displayName: 'ops@acme.dev',
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  status: 'connected',
  createdAt: new Date(BASE).toISOString(),
  updatedAt: new Date(BASE).toISOString(),
}

// The organization's computer (work 052 contract). Onboarded by default with
// one live and two recent sessions; `?computer=setup` shows the page before
// Slack and GitHub are connected (no computer yet: it comes with the Slack
// install), `?computer=quiet` nothing live, `?computer=parked` a sleeping
// computer, `?computer=first` the last setup step until its first task
// lands a few seconds in, and `?computer=booting` a new computer coming online
// over about twenty seconds.
function previewComputerMode() {
  return new URLSearchParams(window.location.search).get('computer')
}

// When the booting preview first asked for the computer.
let previewBootSince: number | null = null

// The person's coding agent (work 081). Setup starts with none chosen;
// set up, a verified subscription linked to a Slack user. `?agent=` picks
// another: unchecked, paused, limited, invalid, credits (free credits),
// unlinked (free credits, not linked to Slack), or none (an older backend
// that sends no agent block). The paste form answers by the token: one
// containing "rejected" is refused, "taken" is someone else's, "unchecked"
// is saved without a check; any other well-formed one is verified.
// Unlinked with Slack installed, the card mints a link code (work 083).
// `?agent=codex` is a connected ChatGPT plan; `?agent=both` has Claude and
// Codex connected, Claude running threads. The one-command connect (work
// 082) mints a placeholder code; with `?connect=auto` the preview plays the
// person running it: about six seconds later the card's subscription (Codex
// when Codex is chosen, else Claude) is connected. `?harnesses=claude,codex`
// names the harnesses the computer can run (`?agent=codex` implies both);
// without it the agent names none, as an older backend: Claude only. With
// `?connect=unavailable` setup starts on the Codex card and its mint is
// refused the way blue refuses a harness it cannot run (409, in its own
// words).
type PreviewAgent = {
  subscriptions?: Record<'claude' | 'codex', PreviewAgent['subscription']>
  harnesses?: string[]
  choice: 'claude' | 'codex' | 'credits' | null
  linked: boolean
  linkedSlackUser?: { id: string; name: string; teamName: string }
  subscription: null | {
    provider: 'claude' | 'codex'
    health: 'ok' | 'unchecked' | 'paused' | 'limited' | 'invalid'
    limitedUntil?: string
    setAt: string
    plan?: string
  }
  managedModel: string
}
let previewAgentState: PreviewAgent | null | undefined

function previewAgent(): PreviewAgent | null {
  if (previewAgentState !== undefined) return previewAgentState
  const search = new URLSearchParams(window.location.search)
  const param = search.get('agent')
  const connect = search.get('connect')
  const setup = previewComputerMode() === 'setup'
  const linkedSlackUser = { id: 'U0PREVIEW', name: 'maya', teamName: 'Acme' }
  const subscription = (
    health: NonNullable<PreviewAgent['subscription']>['health'],
  ) => ({
    provider: 'claude' as const,
    health,
    ...(health === 'limited'
      ? { limitedUntil: new Date(Date.now() + 3 * 3600_000).toISOString() }
      : {}),
    setAt: new Date(BASE).toISOString(),
  })
  const harnesses =
    new URLSearchParams(window.location.search)
      .get('harnesses')
      ?.split(',')
      .map((name) => name.trim())
      .filter(Boolean) ?? (param === 'codex' ? ['claude', 'codex'] : undefined)
  const base = {
    managedModel: 'Claude Opus 5.5',
    ...(harnesses ? { harnesses } : {}),
  }
  // The seat binds to a Slack user through the install: before it, nobody
  // is linked and no Slack user is named.
  const link = setup ? { linked: false } : { linked: true, linkedSlackUser }
  previewAgentState =
    param === 'none'
      ? null
      : param === 'credits'
        ? { ...base, ...link, choice: 'credits', subscription: null }
        : param === 'unlinked'
          ? { ...base, choice: 'credits', linked: false, subscription: null }
          : param === 'both'
            ? {
                ...base,
                ...link,
                harnesses: ['claude', 'codex'],
                choice: 'claude',
                subscription: subscription('ok'),
                subscriptions: {
                  claude: subscription('ok'),
                  codex: {
                    provider: 'codex',
                    health: 'ok',
                    setAt: new Date(BASE).toISOString(),
                    plan: 'plus',
                  },
                },
              }
            : param === 'codex'
              ? {
                  ...base,
                  ...link,
                  choice: 'codex',
                  subscription: {
                    provider: 'codex',
                    health: 'ok',
                    setAt: new Date(BASE).toISOString(),
                    plan: 'plus',
                  },
                }
              : param === 'unchecked' ||
                  param === 'paused' ||
                  param === 'limited' ||
                  param === 'invalid'
                ? {
                    ...base,
                    ...link,
                    choice: 'claude',
                    subscription: subscription(param),
                  }
                : setup
                  ? {
                      ...base,
                      choice: connect === 'unavailable' ? 'codex' : null,
                      linked: false,
                      subscription: null,
                    }
                  : {
                      ...base,
                      ...link,
                      choice: 'claude',
                      subscription: subscription('ok'),
                    }
  return previewAgentState
}

function previewAgentRequest(path: string, method: string, body: unknown) {
  const agent = previewAgent()
  if (!agent) throw new ApiError('Not found', 404, 'not_found')
  const { token, choice, purpose } = (
    typeof body === 'string' ? JSON.parse(body) : {}
  ) as { token?: string; choice?: PreviewAgent['choice']; purpose?: string }
  if (path.endsWith('/choice')) {
    agent.choice = choice ?? null
    if (agent.subscriptions) {
      const { claude, codex } = agent.subscriptions
      agent.subscription =
        choice === 'codex' ? (codex ?? claude) : (claude ?? codex)
    }
    return { agent: structuredClone(agent) }
  }
  if (path.endsWith('/connect-code')) {
    const connect = new URLSearchParams(window.location.search).get('connect')
    // A link code (work 083): with `?connect=auto` the preview plays the
    // person sending `!link` in Slack.
    if (purpose === 'link') {
      if (connect === 'auto')
        setTimeout(() => {
          agent.linked = true
          agent.linkedSlackUser = {
            id: 'U0PREVIEW',
            name: 'maya',
            teamName: 'Acme',
          }
        }, 6_000)
      return {
        code: 'oc_PREVIEW00000000',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      }
    }
    if (connect === 'unavailable' && agent.choice === 'codex')
      throw new ApiError(
        "Codex isn't available on this computer yet",
        409,
        'computer_harness_unavailable',
      )
    if (connect === 'auto')
      setTimeout(() => {
        const codex = agent.choice === 'codex'
        agent.choice = codex ? 'codex' : 'claude'
        agent.subscription = {
          provider: codex ? 'codex' : 'claude',
          health: 'ok',
          setAt: new Date().toISOString(),
          ...(codex ? { plan: 'plus' } : {}),
        }
      }, 6_000)
    return {
      // A placeholder in the real shape; it connects nothing.
      code: 'oc_PREVIEW00000000',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    }
  }
  if (path.endsWith('/resume')) {
    if (agent.subscription) agent.subscription.health = 'ok'
    return { agent: structuredClone(agent) }
  }
  if (method === 'DELETE') {
    const provider = path.endsWith('/codex') ? 'codex' : 'claude'
    if (agent.subscription?.provider === provider) agent.subscription = null
    return undefined
  }
  if (token?.includes('rejected')) {
    throw new ApiError(
      "That token didn't work. Run claude setup-token again and paste the new one.",
      422,
      'computer_agent_token_rejected',
    )
  }
  if (token?.includes('taken')) {
    throw new ApiError(
      'Someone else already connected a subscription for this organization.',
      409,
      'computer_agent_already_connected',
    )
  }
  const verified = !token?.includes('unchecked')
  agent.choice = 'claude'
  agent.subscription = {
    provider: 'claude',
    health: verified ? 'ok' : 'unchecked',
    setAt: new Date().toISOString(),
  }
  return {
    agent: structuredClone(agent),
    verified,
    via: verified ? 'pool' : 'none',
  }
}

function previewComputer() {
  const mode = previewComputerMode()
  const setup = mode === 'setup'
  const parked = mode === 'parked'
  let booted = { state: parked ? 'parked' : 'ready', connected: !parked }
  if (mode === 'booting') {
    previewBootSince ??= Date.now()
    const elapsed = Date.now() - previewBootSince
    booted =
      elapsed < 12_000
        ? { state: 'provisioning', connected: false }
        : { state: 'ready', connected: elapsed >= 20_000 }
  }
  return {
    computer: setup
      ? null
      : {
          ...booted,
          vcpus: 2,
          memoryGiB: 8,
          diskGiB: 128,
          lastError: null,
          createdAt: new Date(
            mode === 'booting' ? (previewBootSince ?? BASE) : BASE,
          ).toISOString(),
          updatedAt: new Date(BASE).toISOString(),
        },
    slack: setup
      ? { installed: false }
      : { installed: true, teamId: 'T0PREVIEW', teamName: 'Acme' },
    github: setup
      ? {
          connected: false,
          installations: [] as Array<{ id: string; accountLogin: string }>,
        }
      : {
          connected: true,
          installations: [
            { id: '1', accountLogin: 'acme' },
            { id: '2', accountLogin: 'acme-labs' },
          ],
        },
    plan: 'free',
    ...(previewAgent() ? { agent: structuredClone(previewAgent()) } : {}),
  }
}

// When the first-task preview first asked for sessions.
let previewFirstTaskSince: number | null = null

function previewComputerSessions() {
  // Relative to now so the page's "2 min ago" reads true in the preview.
  const ago = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000).toISOString()
  const session = (
    ts: string,
    title: string,
    status: string,
    minutes: number,
  ) => ({
    key: `C0PREVIEW:${ts}`,
    title,
    channelId: 'C0PREVIEW',
    threadTs: ts,
    ownerSlackUserId: 'U0PREVIEW',
    status,
    updatedAt: ago(minutes),
    slackUrl: `https://acme.slack.com/archives/C0PREVIEW/p${ts.replace('.', '')}`,
  })
  const mode = previewComputerMode()
  if (mode === 'booting') return []
  if (mode === 'first') {
    previewFirstTaskSince ??= Date.now()
    return Date.now() - previewFirstTaskSince < 6_000
      ? []
      : [session('1760000300.000100', 'Fix the flaky checkout test', 'busy', 0)]
  }
  const live = mode === 'quiet' || mode === 'parked' ? 'idle' : 'busy'
  return [
    session('1760000300.000100', 'Fix the flaky checkout test', live, 2),
    session(
      '1760000200.000100',
      'Explain how billing retries work',
      'idle',
      47,
    ),
    session(
      '1760000100.000100',
      'Upgrade to React 19 and list what broke',
      'ended',
      26 * 60,
    ),
  ]
}

let previewProjectServiceAttachments: Array<Record<string, unknown>> = []

// The computer's organization secrets (work 095); `?secrets=none` shows the
// empty page.
const previewSecretActor = (name: string) => ({ member: `usr_${name}`, name })
function previewOrgSecrets() {
  if (new URLSearchParams(window.location.search).get('secrets') === 'none')
    return { secrets: [] }
  const at = (hours: number) =>
    new Date(Date.now() - hours * 3_600_000).toISOString()
  const row = (
    name: string,
    by: string,
    updated: number,
    used: number | null,
    extra: Record<string, unknown> = {},
  ) => ({
    name,
    layer: 'organization',
    kind: 'secret',
    file: false,
    createdAt: at(updated + 240),
    createdBy: previewSecretActor(by),
    updatedAt: at(updated),
    updatedBy: previewSecretActor(by),
    lastUsedAt: used === null ? null : at(used),
    overriddenIn: { threads: 0, people: 0 },
    ...extra,
  })
  return {
    secrets: [
      row('EXECUTOR_API_KEY', 'Ayush', 26, 2, {
        overriddenIn: { threads: 1, people: 0 },
      }),
      row('GITHUB_TOKEN', 'Igor', 240, 0.1, {
        overriddenIn: { threads: 0, people: 2 },
      }),
      row('GCP_SERVICE_ACCOUNT', 'Mohamed', 400, 30, { file: true }),
      row('LINEAR_API_KEY', 'Utpal', 480, 24),
      row('OPENAI_BASE_URL', 'Mohamed', 72, null, {
        kind: 'variable',
        value: 'https://gateway.example.com/v1',
      }),
    ],
  }
}

// Ordered most-specific first. Matched against the path (without /api/dashboard).
const ROUTES: Array<[RegExp, Handler]> = [
  [/^\/me$/, () => me],
  [/^\/managed-agents\/agents$/, () => ({ agents: managedAgentItems })],
  [/^\/managed-agents\/computer$/, previewComputer],
  [/^\/managed-agents\/computer\/secrets$/, previewOrgSecrets],
  [
    /^\/managed-agents\/computer\/sessions$/,
    () => ({ sessions: previewComputerSessions() }),
  ],
  [
    /^\/managed-agents\/github$/,
    () => ({
      // The same accounts the computer reports, with none before setup.
      connections: previewComputer().github.installations.map(
        (installation, index) => ({
          id: `ghc_preview_${installation.id}`,
          githubInstallationId: 1000 + Number(installation.id),
          accountLogin: installation.accountLogin,
          accountType: 'Organization',
          repositorySelection: index === 0 ? 'all' : 'selected',
          state: 'active',
          createdAt: new Date(BASE).toISOString(),
          updatedAt: new Date(BASE).toISOString(),
        }),
      ),
      app: { slug: 'opencomputerdev' },
    }),
  ],
  [
    /^\/managed-agents\/account\/runtime-profile$/,
    () => ({ customized: false, displayName: 'OpenComputer default' }),
  ],
  [/^\/managed-agents\/projects$/, () => ({ projects: managedProjects })],
  [/^\/managed-agents\/projects\?archived=true$/, () => ({ projects: [] })],
  [
    /^\/managed-agents\/projects\/[^/]+\/service-connections$/,
    () => ({ attachments: previewProjectServiceAttachments }),
  ],
  [/^\/managed-agents\/model-access\/connections$/, () => ({ data: [] })],
  [
    /^\/managed-agents\/projects\/[^/]+\/model-access\/bindings$/,
    () => ({ data: [] }),
  ],
  [
    /^\/managed-agents\/projects\/[^/]+$/,
    () => ({
      project: managedProjects[0],
      sessions: [],
      deployments: [],
      connections: [],
      channels: [],
      schedules: [],
      files: [],
      schema: { version: 0, agents: managedProjects[0]?.agents ?? [] },
    }),
  ],
  [
    /^\/managed-agents\/connections$/,
    () => ({
      connections: [previewServiceConnection],
    }),
  ],
  [
    /^\/managed-agents\/channels$/,
    () => ({
      channels: [
        {
          id: 'channel_slack_preview',
          channel: 'slack',
          agentId: 'research-assistant',
          alias: 'production',
          teamName: 'OpenComputer',
          status: 'connected',
          createdAt: new Date(BASE).toISOString(),
          updatedAt: new Date(BASE).toISOString(),
        },
      ],
    }),
  ],
  [
    /^\/managed-agents\/deployments\?agentId=[^&]+$/,
    () => ({
      deployments: [
        {
          id: 'research-assistant:preview',
          agentId: 'research-assistant',
          alias: 'production',
          channels: ['slack'],
          connections: ['gmail'],
          createdAt: new Date(BASE).toISOString(),
        },
      ],
    }),
  ],
  [
    /^\/managed-agents\/deployments\/[^/]+$/,
    () => ({
      id: 'research-assistant:preview',
      agentId: 'research-assistant',
      alias: 'production',
      channels: [],
      connections: [],
      createdAt: new Date(BASE).toISOString(),
      projectDeployment: {
        id: 'research-assistant:preview',
        digest: 'p'.repeat(64),
        localAgentId: 'research-assistant',
        agents: [
          { localId: 'research-assistant', agentId: 'research-assistant' },
        ],
        resources: {
          version: 1,
          channels: [
            {
              id: 'team-slack',
              type: 'slack',
              displayName: 'Engineering Slack',
              destinations: {
                'pull-request-reviews': {
                  type: 'conversation',
                  visibility: 'public',
                },
              },
            },
          ],
          channelRegistrations: [],
          outboxes: [],
          outboxRegistrations: [],
          schedules: [],
        },
      },
    }),
  ],
  [
    /^\/managed-agents\/sessions$/,
    () => ({
      sessions: [
        {
          id: 'session_preview',
          agentId: 'research-assistant',
          deploymentId: 'research-assistant:preview',
          status: 'suspended',
          source: 'channel',
          microvmState: 'suspended',
          createdAt: new Date(BASE).toISOString(),
          updatedAt: new Date(BASE).toISOString(),
          turns: [],
        },
      ],
    }),
  ],
  [
    /^\/managed-agents\/sessions\/[^/]+\/events(?:\?.*)?$/,
    () => ({
      events: [
        { seq: 1, type: 'runtime.connected', data: {} },
        {
          seq: 2,
          type: 'message.completed',
          data: {
            text: 'Here is a concise response from your deployed agent.',
          },
        },
        { seq: 3, type: 'turn.completed', data: {} },
      ],
    }),
  ],
  [
    /^\/managed-agents\/sessions\/[^/]+$/,
    () => ({
      id: 'session_preview',
      agentId: 'research-assistant',
      deploymentId: 'research-assistant:preview',
      status: 'suspended',
      source: 'playground',
      microvmState: 'suspended',
      createdAt: new Date(BASE).toISOString(),
      updatedAt: new Date(BASE).toISOString(),
      turns: [],
    }),
  ],
  [/^\/sessions\/[^/]+\/stats$/, () => sandboxStats],
  [/^\/sessions\/[^/]+$/, () => sessionDetail],
  [/^\/sessions(\?.*)?$/, () => sandboxes],
  [/^\/browsers\/[^/]+$/, () => browserSessions[0]],
  [/^\/browsers(\?.*)?$/, () => ({ browsers: browserSessions })],
  [/^\/browser-profiles$/, () => ({ profiles: browserProfiles })],
  [/^\/images(\?.*)?$/, () => images],
  [
    /^\/checkpoints(\?.*)?$/,
    () => ({ checkpoints, total: checkpoints.length, page: 1, perPage: 20 }),
  ],
  [/^\/api-keys$/, () => apiKeys],
  [/^\/billing\/autumn$/, () => autumnMock()],
  [/^\/billing\/invoices/, () => ({ invoices: [] })],
  [/^\/billing$/, () => billing],
  [/^\/usage\/sandboxes/, () => sandboxUsage],
  [/^\/org\/members$/, () => orgMembers],
  [/^\/org\/invitations$/, () => orgInvitations],
  [/^\/org\/custom-domain$/, () => ({})],
  [/^\/org$/, () => org],
  [
    /^\/webhooks\/[^/]+\/deliveries$/,
    () => ({ data: sandboxWebhookDeliveries }),
  ],
  [
    /^\/webhooks\/[^/]+\/secret$/,
    () => ({ secret: 'whsec_mockSigningSecret123' }),
  ],
  [/^\/webhooks$/, () => ({ data: sandboxWebhooks })],
]

// Mutations the preview needs to echo something parseable (e.g. the Slack
// wizard's POST …/slack/manifest → manifest+steps). Everything else 204-ish.
const POST_ROUTES: [RegExp, () => unknown][] = [
  [/^\/managed-agents\/computer$/, previewComputer],
  [
    /^\/managed-agents\/computer\/slack\/install$/,
    // Round-trips through the page's Slack return handling.
    () => ({ url: `${window.location.origin}/computer?slack=connected` }),
  ],
  [
    /^\/managed-agents\/projects$/,
    () => {
      const timestamp = new Date(BASE).toISOString()
      const project = {
        id: 'prj_preview',
        slug: 'hello-world',
        name: 'Hello World',
        environments: [
          { name: 'development' as const, updatedAt: timestamp },
          { name: 'production' as const, updatedAt: timestamp },
        ],
        agents: [{ id: 'hello-world', name: 'Hello World' }],
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      managedProjects = [project]
      return project
    },
  ],
  [
    /^\/managed-agents\/sessions$/,
    () => ({
      session: { id: 'session_preview', status: 'connecting' },
      deployment: {
        id: 'research-assistant:preview',
        agentId: 'research-assistant',
        alias: 'production',
        channels: [],
        connections: [],
        createdAt: new Date(BASE).toISOString(),
      },
    }),
  ],
  [
    /^\/managed-agents\/sessions\/[^/]+\/turns$/,
    () => ({ turnId: 'turn_preview', duplicate: false }),
  ],
  [
    /^\/managed-agents\/sessions\/[^/]+\/suspend$/,
    () => ({ id: 'session_preview', status: 'suspended' }),
  ],
]

export function mockFetch<T>(path: string, options: RequestInit = {}): T {
  const method = (options.method ?? 'GET').toUpperCase()
  if (
    /^\/managed-agents\/projects\/[^/]+\/service-connections$/.test(path) &&
    (method === 'POST' || method === 'DELETE')
  ) {
    const projectId = path.split('/')[3] ?? 'prj_preview'
    if (method === 'DELETE') {
      previewProjectServiceAttachments = []
      return undefined as T
    }
    const attachment = {
      projectId,
      service: 'gmail',
      provider: 'google',
      label: previewServiceConnection.label,
      connectionId: previewServiceConnection.id,
      connection: previewServiceConnection,
      createdAt: new Date(BASE).toISOString(),
      updatedAt: new Date(BASE).toISOString(),
    }
    previewProjectServiceAttachments = [attachment]
    return attachment as T
  }
  const renameMatch = path.match(/^\/api-keys\/([^/]+)$/)
  if (method === 'PATCH' && renameMatch) {
    const body = typeof options.body === 'string' ? options.body : '{}'
    const { name } = JSON.parse(body) as { name?: string }
    const key = apiKeys.find((k) => k.id === renameMatch[1])
    if (!key) throw new ApiError('Not found', 404)
    key.name = name ?? key.name
    return key as T
  }
  if (method === 'PUT' && path === '/me/preferences') {
    const body = typeof options.body === 'string' ? options.body : '{}'
    const updates = JSON.parse(body) as Partial<
      Pick<typeof me, 'infrastructureEnabled'>
    >
    Object.assign(me, updates)
    return me as T
  }
  if (method !== 'GET' && path.startsWith('/managed-agents/computer/agent/')) {
    return previewAgentRequest(path, method, options.body) as T
  }
  if (method !== 'GET') {
    for (const [re, handler] of POST_ROUTES) {
      if (re.test(path)) return handler() as T
    }
    return {} as T
  }
  for (const [re, handler] of ROUTES) {
    if (re.test(path)) {
      const out = handler()
      if (out === NOT_FOUND) {
        throw new ApiError('Not found', 404)
      }
      return out as T
    }
  }
  // Unknown GET: empty list is the safe default for the list-heavy screens.
  return [] as T
}
