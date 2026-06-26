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

const sessions = [
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

const autumn = { isHalted: false, balance: 4210, currency: 'usd' }

type Handler = () => unknown

// Ordered most-specific first. Matched against the path (without /api/dashboard).
const ROUTES: Array<[RegExp, Handler]> = [
  [/^\/me$/, () => me],
  [/^\/sessions\/[^/]+\/stats$/, () => ({})],
  [/^\/sessions\/[^/]+$/, () => sessions[0]],
  [/^\/sessions(\?.*)?$/, () => sessions],
  [/^\/images(\?.*)?$/, () => images],
  [
    /^\/checkpoints(\?.*)?$/,
    () => ({ checkpoints, total: checkpoints.length, page: 1, perPage: 20 }),
  ],
  [/^\/api-keys$/, () => apiKeys],
  [/^\/billing\/autumn$/, () => autumn],
  [/^\/billing\/invoices/, () => []],
  [/^\/org\/members$/, () => []],
  [/^\/org\/invitations$/, () => []],
  [/^\/org\/custom-domain$/, () => ({})],
  [/^\/usage\/sandboxes/, () => []],
  [/^\/agents$/, () => []],
]

export async function mockFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase()
  if (method !== 'GET') return {} as T
  for (const [re, handler] of ROUTES) {
    if (re.test(path)) return handler() as T
  }
  // Unknown GET: empty list is the safe default for the list-heavy screens.
  return [] as T
}
