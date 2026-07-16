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

// Fixed clock so screenshots are deterministic.
const BASE = new Date('2026-06-26T17:00:00Z').getTime()
const at = (daysAgo: number, hoursAgo = 0) =>
  new Date(BASE - daysAgo * 86_400_000 - hoursAgo * 3_600_000).toISOString()

const me = {
  id: 'user_2abc',
  email: 'igor@digger.dev',
  orgId: 'org_digger',
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
    createdAt: at(14),
  },
]

const autumn = {
  isHalted: false,
  creditsRemainingCents: 4210,
  concurrencyPlan: 'base',
  maxConcurrentSandboxes: 5,
  autoTopup: { enabled: false, threshold: 5, quantity: 25 },
  hasToppedUp: true,
  currency: 'usd',
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

// ── Durable Agent Sessions ─────────────────────────────────────────────
const agents = [
  {
    id: 'agt_3kf9xz',
    name: 'PR Reviewer',
    prompt:
      'You are a meticulous code reviewer. Flag correctness, security, and clarity issues; be concise and cite line numbers.',
    prompt_hash: 'sha256:9c1a4f',
    model: 'anthropic/claude-opus-4-8',
    runtime: 'claude',
    credential_id: 'cred_anth_1',
    revision: 3,
    created_at: at(20),
  },
  {
    id: 'agt_7mq2aa',
    name: 'Docs Writer',
    prompt:
      'You write clear, friendly developer documentation. Prefer short sentences and runnable examples.',
    prompt_hash: 'sha256:42bd07',
    model: 'anthropic/claude-sonnet-5',
    runtime: 'claude',
    credential_id: null,
    revision: 1,
    created_at: at(6),
  },
]

// ── Deploy from GitHub (admin) ───────────────────────────────────────────────
// The AgentDeploySource panel renders one of three states off two endpoints
// (GET /v3/github/deploy-app + GET …/deployment-source). The backend can't
// produce these locally yet (no OC-App install record), so flip DEPLOY_PREVIEW
// to eyeball each state with no backend:
//   'not_installed' → the "Install GitHub App" CTA
//   'installed'     → the repo picker (App installed, this agent not yet linked)
//   'connected'     → a linked agent showing live status + Disconnect
const DEPLOY_PREVIEW = 'installed' as
  'not_installed' | 'installed' | 'connected'

const deployAppInstalled = {
  installed: true,
  install_url: 'https://github.com/apps/opencomputerdev/installations/new',
  configure_url:
    'https://github.com/apps/opencomputerdev/installations/select_target',
  account: 'acme',
  repository_selection: 'selected' as const,
  repositories: [
    {
      id: 'repo_01k0acmeagents000000000',
      full_name: 'acme/agents',
      default_branch: 'main',
      private: true,
    },
    {
      id: 'repo_01k0supportbot00000000',
      full_name: 'acme/support-bot',
      default_branch: 'main',
      private: false,
    },
    {
      id: 'repo_01k0acmeinfra000000000',
      full_name: 'acme/infra',
      default_branch: 'production',
      private: true,
    },
  ],
}
const deployAppNotInstalled = {
  installed: false,
  install_url: 'https://github.com/apps/opencomputerdev/installations/new',
  configure_url: null,
  account: null,
  repository_selection: null,
  repositories: [],
}
const deployApp =
  DEPLOY_PREVIEW === 'not_installed'
    ? deployAppNotInstalled
    : deployAppInstalled

// The linked source for the 'connected' preview (echoed for any agent id).
const deploymentSource = {
  agent_id: 'agt_3kf9xz',
  repo_id: 'repo_acme_agents',
  path: 'agents/pr-reviewer',
  production_ref: 'main',
  status: 'active',
  latest_seen_sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
  active_deployed_sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
  full_name: 'acme/agents',
}

const flueInspection = {
  repository: {
    id: 'repo_01k0supportbot00000000',
    full_name: 'acme/support-bot',
    default_branch: 'main',
  },
  root: '',
  production_ref: 'main',
  sha: 'cbb8766d972199b01d03389d2680970dc29d1d34',
  interpretation: {
    disposition: 'exact' as const,
    source_profile: 'flue-app-v1' as const,
    source_profile_version: 1 as const,
    summary: 'Flue agent detected',
    reason_code: 'flue_detected',
    assumptions: [],
    agent: {
      runtime: 'flue' as const,
      model: 'anthropic/claude-haiku-4-5',
    },
  },
  profile: {
    source_profile: 'flue-app-v1' as const,
    source_profile_version: 1 as const,
    manifest: {
      schema_version: 1 as const,
      entrypoint: 'support-triage',
      model: 'anthropic/claude-haiku-4-5',
      runtime: { family: 'flue' as const, type: 'default' },
      vars: { SUPPORT_QUEUE: 'priority' },
    },
    package: {
      name: 'oc-flue-starter',
      node_engine: '>=22.19 <23',
      flue_cli: '0.1.0',
    },
    lockfile: { version: 3 },
    builder: { node: '22.19.0' },
    source: { files: 28, bytes: 164_208 },
    variable_names: ['SUPPORT_QUEUE'],
    warnings: [],
  },
  review_fingerprint: 'sha256:mock-flue-review',
  candidate_roots: [],
  candidate_roots_truncated: false,
}

const importedAgent = {
  id: 'agt_flue_import',
  name: 'Support triage',
  prompt: null,
  prompt_hash: null,
  model: 'anthropic/claude-haiku-4-5',
  runtime: 'flue',
  credential_id: 'managed',
  revision: 0,
  active_revision_id: null,
  active_revision: null,
  deployment_status: {
    deployment_id: 'dep_flue_building',
    state: 'building',
    result: null,
    error_class: null,
    live_touched: false,
    live_status: null,
    updated_at: at(0, 0),
  },
  flue: { agent_name: 'support-triage', live: null },
  created_at: at(0, 1),
}

const importedSource = {
  agent_id: importedAgent.id,
  repo_id: flueInspection.repository.id,
  path: '',
  production_ref: 'main',
  status: 'active',
  latest_seen_sha: flueInspection.sha,
  active_deployed_sha: null,
  full_name: flueInspection.repository.full_name,
  source_profile: 'flue-app-v1',
  source_profile_version: 1,
  review_fingerprint: flueInspection.review_fingerprint,
}

const flueDeployment = {
  id: 'dep_flue_building',
  state: 'building',
  phase: 'build',
  terminal: false,
  result: null,
  input_type: 'github',
  revision_id: null,
  revision: null,
  source: {
    via: 'repo',
    repo_id: flueInspection.repository.id,
    path: '',
    git_sha: flueInspection.sha,
  },
  source_relation: {
    repo: {
      id: flueInspection.repository.id,
      full_name: flueInspection.repository.full_name,
    },
    path: '',
    production_ref: 'main',
    status: 'active',
    ref: 'main',
    sha: flueInspection.sha,
    commit_url: `https://github.com/${flueInspection.repository.full_name}/commit/${flueInspection.sha}`,
  },
  actor: { kind: 'human', id: 'user_2abc' },
  ref: 'main',
  sha: flueInspection.sha,
  error: null,
  error_class: null,
  build: {
    schema_version: 1,
    root: '',
    node: '22.19.0',
    npm: '10.9.3',
    lockfile_version: 3,
    builder: 'oc@dev',
    attempts: 1,
    source_files: 28,
    source_bytes: 164_208,
  },
  configuration: {
    entrypoint: 'support-triage',
    model: 'anthropic/claude-haiku-4-5',
    runtime: { family: 'flue', type: 'default' },
    variable_names: ['SUPPORT_QUEUE'],
  },
  log_bytes: 862,
  log_truncated: false,
  live_touched: false,
  agent_live: null,
  restore_eligibility: 'none',
  redeploy_of: null,
  allowed_actions: ['view_commit'],
  active: false,
  timing: {
    accepted_at: at(0, 1),
    started_at: at(0, 1),
    finished_at: null,
    cancel_requested_at: null,
    queue_ms: 420,
    run_ms: null,
    total_ms: null,
  },
  created_at: at(0, 1),
  updated_at: at(0, 0),
  started_at: at(0, 1),
  finished_at: null,
}

const failedFlueDeployment = {
  ...flueDeployment,
  id: 'dep_flue_failed',
  state: 'failed',
  phase: 'failed',
  terminal: true,
  result: 'failed',
  error: {
    class: 'install_failed',
    phase: 'install',
    message: 'npm ci failed because package-lock.json is out of date.',
    retryable: false,
  },
  error_class: 'install_failed',
  allowed_actions: ['view_commit', 'deploy_latest'],
  finished_at: at(0, 0),
  timing: {
    ...flueDeployment.timing,
    finished_at: at(0, 0),
    run_ms: 12_000,
    total_ms: 12_420,
  },
}

const flueDeploymentLogs = [
  {
    seq: '101',
    cursor: 'deployment-log-101',
    recorded_at: at(0, 1),
    phase: 'source',
    stream: 'system',
    chunk: 'Materialized acme/support-bot at cbb8766',
  },
  {
    seq: '102',
    cursor: 'deployment-log-102',
    recorded_at: at(0, 1),
    phase: 'install',
    stream: 'stdout',
    chunk: 'added 214 packages in 4s\n',
  },
  {
    seq: '103',
    cursor: 'deployment-log-103',
    recorded_at: at(0, 0),
    phase: 'build',
    stream: 'system',
    chunk: 'Running offline Flue artifact builder',
  },
]

// Revisions / deploys / skills for the agent Overview + Deployments tab.
const agentRevisions = [
  {
    id: 'rev_3',
    number: 3,
    digest: 'sha256:c0ffee0011223344',
    created_at: at(0, 1),
    active: true,
    sha: '4a3f654010a5c16a101a6f0b3bf7aec1d3839d4f',
    ref: 'main',
  },
  {
    id: 'rev_2',
    number: 2,
    digest: 'sha256:deadbeef55667788',
    created_at: at(0, 3),
    active: false,
    sha: null,
    ref: null,
  },
  {
    id: 'rev_1',
    number: 1,
    digest: 'sha256:0123456789abcdef',
    created_at: at(2),
    active: false,
    sha: null,
    ref: null,
  },
]
const agentDeploys = [
  {
    id: 'dep_3',
    state: 'ready',
    result: 'created',
    source: { via: 'repo', git_sha: '4a3f654010a5c16a' },
    actor: null,
    revision_id: 'rev_3',
    created_at: at(0, 1),
  },
  {
    id: 'dep_2',
    state: 'ready',
    result: 'created',
    source: { via: 'api' },
    actor: null,
    revision_id: 'rev_2',
    created_at: at(0, 3),
  },
  {
    id: 'dep_1',
    state: 'failed',
    result: 'failed',
    source: { via: 'repo', git_sha: 'badc0ffee1234567' },
    actor: null,
    revision_id: null,
    created_at: at(1),
  },
]
const agentSkills = {
  revision: { id: 'rev_3', number: 3, digest: 'sha256:c0ffee0011223344' },
  skill_bundle_digest: 'sha256:c0ffee0011223344',
  skills: [
    {
      name: 'hello',
      description: 'A trivial example skill.',
      files: [{ path: 'hello/SKILL.md', mode: 33188, size: 240 }],
    },
  ],
}

// A connected Slack app for the first agent (the AgentDetail Slack panel).
const slackConnection = {
  id: 'sla_5p6q7r',
  agent_id: 'agt_3kf9xz',
  handle: 'PR Reviewer',
  slack_app_id: 'A0123ABCDEF',
  team_id: 'T0123ABCDEF',
  account_login: 'Acme',
  status: 'active',
  bot_token_verified: true,
  signing_verified: false,
  created_at: at(5),
  updated_at: at(0, 2),
}

// START-intent response for the Slack connect wizard (POST …/slack/manifest).
const slackManifest = {
  manifest: {
    display_information: { name: 'PR Reviewer' },
    features: {
      bot_user: { display_name: 'PR Reviewer', always_online: true },
    },
    oauth_config: { scopes: { bot: ['app_mentions:read', 'chat:write'] } },
    settings: {
      event_subscriptions: {
        request_url: 'https://api.opencomputer.dev/v3/slack/events/abc123nonce',
        bot_events: ['app_mention'],
      },
    },
  },
  create_url: 'https://api.slack.com/apps',
  steps: [
    'Open api.slack.com/apps → Create New App → From a manifest.',
    'Pick your workspace, paste the manifest, and click Create.',
    'Click Install to Workspace and approve.',
    'Copy three values back here: App ID, Bot User OAuth Token (xoxb-…), and Signing Secret.',
  ],
  status: 'pending',
}

const credentials = [
  {
    id: 'cred_anth_1',
    provider: 'anthropic',
    name: 'Production',
    last4: 'a1b2',
    is_default: true,
    created_at: at(20),
  },
  {
    id: 'cred_anth_2',
    provider: 'anthropic',
    name: 'Staging',
    last4: 'c3d4',
    is_default: false,
    created_at: at(8),
  },
]

const sessions = [
  {
    // A flue (CF-native) session — meters at the gateway, so its `usage` is empty here
    // (spend renders "—"); the runtime badge is accented to set it apart from brain-box.
    id: 'ses_a1b2c3',
    status: 'running',
    agent_id: 'agt_3kf9xz',
    agent_snapshot: { runtime: 'flue', model: 'anthropic/claude-haiku-4-5' },
    head: 24,
    usage: {},
    created_at: at(0, 1),
    last_turn: { state: 'running' },
    sandboxes: { brain: 'sbx_a1b2c3d4e5', hands: 'sbx_f6g7h8i9j0' },
  },
  {
    id: 'ses_d4e5f6',
    status: 'awaiting_input',
    agent_id: 'agt_3kf9xz',
    agent_snapshot: { runtime: 'claude', model: 'anthropic/claude-sonnet-5' },
    head: 12,
    usage: { cost_usd: 0.0231, input_tokens: 8200, output_tokens: 640 },
    created_at: at(0, 3),
    last_turn: { state: 'ok', yield_reason: 'needs_input' },
  },
  {
    id: 'ses_g7h8i9',
    status: 'idle',
    agent_id: 'agt_7mq2aa',
    agent_snapshot: { runtime: 'pi', model: 'anthropic/claude-sonnet-5' },
    head: 41,
    // No cost reported → the spend column falls back to a token total.
    usage: { input_tokens: 15000, output_tokens: 2200 },
    created_at: at(1, 2),
    last_turn: { state: 'ok', yield_reason: 'completed' },
  },
  {
    id: 'ses_j1k2l3',
    status: 'failed',
    agent_id: 'agt_3kf9xz',
    agent_snapshot: { runtime: 'codex', model: 'openai/gpt-5.3-codex' },
    head: 8,
    usage: { cost_usd: 0.11 },
    created_at: at(2, 5),
    last_turn: { state: 'error', yield_reason: 'error' },
  },
  {
    id: 'ses_m4n5o6',
    status: 'archived',
    agent_id: 'agt_7mq2aa',
    agent_snapshot: { runtime: 'claude', model: 'anthropic/claude-opus-4-8' },
    head: 60,
    usage: { cost_usd: 1.42, input_tokens: 320000, output_tokens: 18400 },
    created_at: at(4, 1),
    last_turn: { state: 'ok', yield_reason: 'completed' },
  },
]

const sessionEvents = [
  {
    id: 'evt_1',
    seq: 1,
    type: 'user.message',
    level: 'user',
    actor: { type: 'user', display: 'You' },
    body: {
      text: 'Review PR #412 and open a follow-up if anything needs fixing.',
    },
    ts: at(0, 1),
  },
  {
    id: 'evt_2',
    seq: 2,
    type: 'turn.started',
    level: 'progress',
    actor: { type: 'runtime' },
    ts: at(0, 1),
  },
  {
    id: 'evt_3',
    seq: 3,
    type: 'agent.thinking',
    level: 'progress',
    actor: { type: 'agent', display: 'PR Reviewer' },
    body: {
      text: 'Fetch the PR head, then read the auth middleware diff before commenting.',
    },
    ts: at(0, 1),
  },
  {
    id: 'evt_4',
    seq: 4,
    type: 'tool.call',
    level: 'progress',
    actor: { type: 'runtime' },
    body: { tool: 'bash', input: 'git fetch origin pull/412/head' },
    ts: at(0, 1),
  },
  {
    id: 'evt_5',
    seq: 5,
    type: 'exec.completed',
    level: 'progress',
    actor: { type: 'runtime' },
    body: {
      tool: 'bash',
      summary: 'fetched pull/412/head → FETCH_HEAD',
      duration_ms: 412,
    },
    ts: at(0, 1),
  },
  {
    id: 'evt_6',
    seq: 6,
    type: 'agent.message',
    level: 'user',
    actor: { type: 'agent', display: 'PR Reviewer' },
    body: {
      text: 'The diff touches the auth middleware. The token-refresh path looks correct, but the retry has no ceiling — I will flag it.',
    },
    ts: at(0, 1),
  },
  {
    id: 'evt_7',
    seq: 7,
    type: 'turn.completed',
    level: 'user',
    actor: { type: 'runtime' },
    body: { yield_reason: 'needs_input' },
    ts: at(0, 1),
  },
]

// Turns power the submission-health panel (GET /v3/sessions/:id/turns), newest first.
const sessionTurns = [
  {
    id: 'trn_2',
    state: 'ok',
    yield_reason: 'needs_input',
    started_at: at(0, 1),
    completed_at: at(0, 1),
    active_seconds: 6.4,
    usage: { cost_usd: 0.0121, input_tokens: 4200, output_tokens: 310 },
  },
  {
    id: 'trn_1',
    state: 'error',
    yield_reason: 'error',
    started_at: at(0, 2),
    completed_at: at(0, 2),
    active_seconds: 2.1,
    usage: {},
    error: {
      code: 'provision_infra',
      message: 'brain sandbox failed to start',
    },
  },
]

const destinations = [
  {
    id: 'dst_1',
    url: 'https://acme.dev/hooks/oc',
    level: 'user',
    types: ['turn.completed', 'error.*'],
    enabled: true,
    has_secret: true,
    created_at: at(0, 2),
    updated_at: at(0, 2),
  },
]

const deliveries = [
  {
    id: 'dlv_1',
    destination: 'dst_1',
    event_id: 'evt_7',
    event_seq: 7,
    status: 'delivered',
    attempts: 1,
    last_attempt_at: at(0, 1),
    response_code: 200,
    created_at: at(0, 1),
  },
  {
    id: 'dlv_2',
    destination: 'dst_1',
    event_id: 'evt_6',
    event_seq: 6,
    status: 'failed',
    attempts: 3,
    last_attempt_at: at(0, 1),
    response_code: 502,
    error: 'upstream returned 502',
    created_at: at(0, 1),
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
// missing resource) — used for an agent with no deployment-source link.
const NOT_FOUND = Symbol('not_found')

// Ordered most-specific first. Matched against the path (without /api/dashboard).
const ROUTES: Array<[RegExp, Handler]> = [
  [/^\/me$/, () => me],
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
  [/^\/billing\/autumn$/, () => autumn],
  [/^\/billing\/invoices/, () => ({ invoices: [] })],
  [/^\/billing$/, () => billing],
  [/^\/usage\/sandboxes/, () => sandboxUsage],
  [/^\/org\/members$/, () => orgMembers],
  [/^\/org\/invitations$/, () => orgInvitations],
  [/^\/org\/custom-domain$/, () => ({})],
  [/^\/org$/, () => org],
  [/^\/agents$/, () => []],
  // Durable Agent Sessions — lists return the { data: [...] } envelope.
  [/^\/v3\/agents\/[^/]+\/slack$/, () => slackConnection],
  [/^\/v3\/github\/deploy-app$/, () => deployApp],
  [
    /^\/v3\/agents\/[^/]+\/deployments\/[^/]+\/logs(?:\?.*)?$/,
    () => ({
      data: flueDeploymentLogs,
      next_cursor: 'deployment-log-103',
      has_more: false,
    }),
  ],
  [
    /^\/v3\/agents\/[^/]+\/deployments\/dep_flue_failed$/,
    () => failedFlueDeployment,
  ],
  [
    /^\/v3\/agents\/agt_flue_import\/deployments(?:\?.*)?$/,
    () => ({
      data: [flueDeployment, failedFlueDeployment],
      next_cursor: null,
    }),
  ],
  [
    /^\/v3\/agents\/[^/]+\/deployments(?:\?.*)?$/,
    () => ({ data: [], next_cursor: null }),
  ],
  [/^\/v3\/agents\/[^/]+\/deployments\/[^/]+$/, () => flueDeployment],
  [
    /^\/v3\/agents\/agt_flue_import\/deployment-source$/,
    () => ({ source: importedSource }),
  ],
  [
    /^\/v3\/agents\/[^/]+\/deployment-source$/,
    () =>
      DEPLOY_PREVIEW === 'connected' ? { source: deploymentSource } : NOT_FOUND,
  ],
  [/^\/v3\/agents\/[^/]+\/deploys$/, () => ({ data: agentDeploys })],
  [/^\/v3\/agents\/[^/]+\/revisions$/, () => ({ data: agentRevisions })],
  [/^\/v3\/agents\/[^/]+\/skills$/, () => agentSkills],
  [/^\/v3\/agents\/agt_flue_import$/, () => importedAgent],
  [/^\/v3\/agents\/[^/]+$/, () => agents[0]],
  [/^\/v3\/agents$/, () => ({ data: [...agents, importedAgent] })],
  [/^\/v3\/credentials$/, () => ({ data: credentials })],
  [/^\/v3\/sessions\/[^/]+\/events/, () => ({ data: sessionEvents })],
  [/^\/v3\/sessions\/[^/]+\/turns$/, () => ({ data: sessionTurns })],
  [
    /^\/v3\/sessions\/[^/]+\/result$/,
    () => ({ last_turn: sessionTurns[0], result: sessionEvents[6] }),
  ],
  [/^\/v3\/sessions\/[^/]+\/destinations$/, () => ({ data: destinations })],
  [/^\/v3\/sessions\/[^/]+\/deliveries$/, () => ({ data: deliveries })],
  [/^\/v3\/sessions\/[^/]+$/, () => sessions[0]],
  [/^\/v3\/sessions(\?.*)?$/, () => ({ data: sessions, next_cursor: null })],
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
  [/^\/v3\/github\/deploy-app\/inspect$/, () => flueInspection],
  [
    /^\/v3\/agents\/import$/,
    () => ({
      agent: importedAgent,
      source: importedSource,
      deployment: flueDeployment,
    }),
  ],
  [
    /^\/v3\/agents\/[^/]+\/deployments$/,
    () => ({
      deployment: {
        id: flueDeployment.id,
        state: flueDeployment.state,
        revision_id: flueDeployment.revision_id,
        active: flueDeployment.active,
      },
    }),
  ],
  [/^\/v3\/agents$/, () => agents[0]],
  [/^\/v3\/agents\/[^/]+\/slack\/manifest$/, () => slackManifest],
  [
    /^\/v3\/agents\/[^/]+\/slack$/,
    () => ({ ...slackConnection, status: 'active' }),
  ],
]

export function mockFetch<T>(path: string, options: RequestInit = {}): T {
  const method = (options.method ?? 'GET').toUpperCase()
  if (method !== 'GET') {
    for (const [re, handler] of POST_ROUTES) {
      if (re.test(path)) return handler() as T
    }
    return {} as T
  }
  for (const [re, handler] of ROUTES) {
    if (re.test(path)) {
      const out = handler()
      if (out === NOT_FOUND) throw new Error('Not found') // mimic a 404
      return out as T
    }
  }
  // Unknown GET: empty list is the safe default for the list-heavy screens.
  return [] as T
}
