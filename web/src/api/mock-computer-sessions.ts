// Preview data for the Computer API v1 sessions routes (work 107), served by
// mockFetch under VITE_PREVIEW. Times are relative to now so the sidebar reads
// naturally; sending a message plays back a short canned turn.

import { ApiError } from './errors'

type Json = Record<string, unknown>

const now = () => Date.now()
const ago = (min: number) => new Date(now() - min * 60_000).toISOString()

let n = 0
const nextId = (prefix: string) =>
  `${prefix}_${(++n).toString(36).padStart(12, '0')}`

const person = { id: 'usr_igor', name: 'Igor', email: 'igor@digger.dev' }
const settings = {
  model: 'claude-opus-5-5',
  effort: null,
  mode: 'bypassPermissions',
  speed: null,
}

type MockSession = Json & {
  id: string
  title: string
  status: string
  archived: boolean
  asks: Json[]
  lastText: string | null
  lastSeq: number
  lastActiveAt: string
  // The ask set aside in triage; the server keeps it on the session row.
  asideRef?: string | null
}
type MockEvent = Json & { seq: number; type: string }

const sessions: MockSession[] = []
const journal = new Map<string, MockEvent[]>()

function session(
  title: string,
  status: string,
  minAgo: number,
  origin: string,
  lastText: string | null,
  extra: Partial<MockSession> = {},
): MockSession {
  const s: MockSession = {
    id: nextId('cs'),
    title,
    status,
    archived: false,
    owner: person,
    origin: {
      type: origin,
      client: null,
      slack:
        origin === 'slack'
          ? {
              teamId: 'T0',
              channelId: 'C0',
              channelName: 'eng',
              threadTs: '1',
              url: 'https://slack.com',
            }
          : null,
    },
    settings,
    metadata: {},
    activeTurnId: null,
    queued: [],
    asks: [],
    subagents: [],
    lastTurn: null,
    lastText,
    context: null,
    lastSeq: 0,
    createdAt: ago(minAgo + 30),
    lastActiveAt: ago(minAgo),
    urls: { dashboard: null },
    ...extra,
  }
  sessions.push(s)
  journal.set(s.id, [])
  return s
}

function emit(s: MockSession, type: string, data: Json, actor?: Json) {
  const events = journal.get(s.id)!
  const seq = events.length + 1
  events.push({
    id: nextId('ev'),
    seq,
    createdAt: new Date().toISOString(),
    sessionId: s.id,
    turnId: s.activeTurnId ?? null,
    actor: actor ?? null,
    type,
    data,
  })
  s.lastSeq = seq
  s.lastActiveAt = new Date().toISOString()
}

// Writes a past conversation with timestamps spread back from `minAgo`.
function history(
  s: MockSession,
  minAgo: number,
  steps: Array<[string, Json, Json?]>,
  turnId = 'tn_preview',
) {
  const events = journal.get(s.id)!
  steps.forEach(([type, data, actor], i) => {
    events.push({
      id: nextId('ev'),
      seq: events.length + 1,
      createdAt: ago(minAgo + (steps.length - i) * 0.4),
      sessionId: s.id,
      turnId,
      actor: actor ?? null,
      type,
      data,
    })
  })
  s.lastSeq = events.length
}

const me = { id: person.id, name: person.name, via: 'dashboard' }
const viaSlack = { id: person.id, name: person.name, via: 'slack' }
const said = (text: string, actor: Json = me): [string, Json, Json] => [
  'message.received',
  { input: text, delivery: 'started' },
  actor,
]
const tool = (title: string, toolName = 'Bash'): Array<[string, Json]> => {
  const callId = nextId('call')
  return [
    ['tool.started', { toolName, callId, parentCallId: null, title }],
    ['tool.completed', { toolName, callId, parentCallId: null, title }],
  ]
}
const reply = (text: string): [string, Json] => [
  'message.completed',
  { blockId: nextId('b'), parentCallId: null, text },
]
const done: [string, Json] = [
  'turn.completed',
  { text: null, durationMs: 1, silent: false },
]

// An open ask as the computer records it (computer-api.v1 `Ask`).
function openAsk(
  s: MockSession,
  minAgo: number,
  turnId: string,
  fields: Pick<Json, 'kind'> & Json,
): Json {
  return {
    id: nextId('ak'),
    sessionId: s.id,
    turnId,
    status: 'open',
    createdAt: ago(minAgo),
    closedAt: null,
    closedBy: null,
    answer: null,
    approval: null,
    question: null,
    secret: null,
    ...fields,
  }
}

// An approval as Claude Code or Codex asks it: `input` is the tool's own
// input, `title` Claude Code's permission title or "Claude wants to use X",
// `alwaysAllows` the rule "Allow for this session" adds (null when it cannot
// be remembered).
function approvalAsk(
  s: MockSession,
  minAgo: number,
  turnId: string,
  toolName: string,
  input: Json,
  alwaysAllows: string | null = toolName,
): Json {
  return openAsk(s, minAgo, turnId, {
    kind: 'approval',
    approval: {
      toolName,
      callId: nextId('call'),
      input,
      title:
        toolName === 'ExitPlanMode'
          ? 'Plan ready for review'
          : `Claude wants to use ${toolName}`,
      alwaysAllows,
    },
  })
}

function questionAsk(
  s: MockSession,
  minAgo: number,
  turnId: string,
  text: string,
  options: Array<[string, string | null]>,
  multiSelect = false,
): Json {
  return openAsk(s, minAgo, turnId, {
    kind: 'question',
    question: {
      questions: [
        {
          id: 'q1',
          header: text.split(' ').slice(0, 2).join(' '),
          text,
          multiSelect,
          options: options.map(([label, description]) => ({
            label,
            description,
          })),
        },
      ],
    },
  })
}

function seed() {
  // Approval: a short shell command.
  const rotate = session(
    'Rotate the staging database password',
    'waiting',
    3,
    'dashboard',
    'Ready to rotate the password and update the secret.',
  )
  const ask = approvalAsk(rotate, 3, 'tn_rotate_2', 'Bash', {
    command: `psql "$STAGING_URL" -c "ALTER ROLE app WITH PASSWORD '$NEW_PASSWORD'"`,
    description: 'Set a new password on the app role in staging',
    timeout: 60000,
  })
  rotate.asks = [ask]
  history(
    rotate,
    9,
    [
      said('Which services read the staging database password?'),
      ...tool('grep -rn STAGING_DB_PASSWORD .'),
      reply('Only the app does, through `STAGING_DB_PASSWORD`.'),
      done,
    ],
    'tn_rotate_1',
  )
  history(
    rotate,
    3,
    [
      said('Rotate the staging database password and update the app secret.'),
      ...tool('Read deploy/staging.env', 'Read'),
      reply(
        'The app reads `STAGING_DB_PASSWORD` from the organization secrets. I will set a new password on the `app` role, then update the secret.',
      ),
      ['ask.opened', { ask }],
    ],
    'tn_rotate_2',
  )

  // Question, three options, one answer.
  const charts = session(
    'Pick a chart library for the usage page',
    'waiting',
    18,
    'slack',
    null,
  )
  const question = questionAsk(
    charts,
    18,
    'tn_preview',
    'Which chart library should the usage page use?',
    [
      ['Recharts', 'Already in the bundle'],
      ['visx', 'Lower level, smaller'],
      ['ECharts', 'Heavier, more chart types'],
    ],
  )
  charts.asks = [question]
  history(charts, 18, [
    said('Add a daily usage chart to the billing page', viaSlack),
    ...tool('Read web/src/pages/Billing.tsx', 'Read'),
    reply(
      'The billing page has room for one chart above the invoices table. Three libraries fit; Recharts is already in the bundle, so it adds nothing to the download.',
    ),
    ['ask.opened', { ask: question }],
  ])

  // Secret request.
  const docs = session(
    'Deploy the docs preview',
    'waiting',
    40,
    'dashboard',
    null,
  )
  const secret = openAsk(docs, 40, 'tn_preview', {
    kind: 'secret',
    secret: {
      name: 'VERCEL_TOKEN',
      purpose: 'To deploy the docs site to a Vercel preview with the CLI.',
      file: false,
    },
  })
  docs.asks = [secret]
  history(docs, 40, [
    said('Deploy a preview of the docs site for the Sessions launch.'),
    ...tool('Read docs/vercel.json', 'Read'),
    reply('The deploy needs a Vercel token, and none is set.'),
    ['ask.opened', { ask: secret }],
  ])

  // Approval: a long multi-line command, from Codex (which gives the cwd).
  const backfill = session(
    'Backfill usage rows for October after the meter outage on the EU cluster',
    'waiting',
    7,
    'slack',
    null,
  )
  const long = approvalAsk(backfill, 7, 'tn_preview', 'Bash', {
    command: [
      'set -euo pipefail',
      'for day in $(seq -w 1 31); do',
      '  psql "$EU_REPLICA_URL" -At -c "',
      '    INSERT INTO usage_daily (org_id, day, cpu_seconds, gb_hours)',
      "    SELECT org_id, DATE '2026-10-$day', sum(cpu_seconds), sum(gb_hours)",
      '    FROM meter_events',
      "    WHERE ts >= '2026-10-$day' AND ts < DATE '2026-10-$day' + 1",
      '    GROUP BY org_id',
      '    ON CONFLICT (org_id, day) DO UPDATE SET cpu_seconds = EXCLUDED.cpu_seconds, gb_hours = EXCLUDED.gb_hours;"',
      '  echo "backfilled 2026-10-$day"',
      'done',
    ].join('\n'),
    cwd: '/workspace/opencomputer/services/billing',
  })
  backfill.asks = [long]
  history(backfill, 7, [
    said(
      'The meter was down on eu-1 from Oct 3 to Oct 9; backfill usage_daily from meter_events.',
      viaSlack,
    ),
    ...tool('Read services/billing/schema.sql', 'Read'),
    ...tool('psql "$EU_REPLICA_URL" -c "select count(*) from meter_events"'),
    reply(
      'meter_events has every event for October, so `usage_daily` can be rebuilt from it. The upsert below is idempotent: days that were already right are rewritten with the same numbers.',
    ),
    ['ask.opened', { ask: long }],
  ])

  // Approval: a file edit.
  const limits = session(
    'Raise the public API rate limit for enterprise keys',
    'waiting',
    12,
    'dashboard',
    null,
  )
  const edit = approvalAsk(limits, 12, 'tn_preview', 'Edit', {
    file_path: '/workspace/opencomputer/internal/api/ratelimit.go',
    old_string: '\tcase PlanEnterprise:\n\t\treturn 600 // requests a minute',
    new_string:
      '\tcase PlanEnterprise:\n\t\treturn 3000 // requests a minute, per key\n\tcase PlanEnterpriseTrial:\n\t\treturn 600',
  })
  limits.asks = [edit]
  history(limits, 12, [
    said('Enterprise keys should get 3000 requests a minute.'),
    ...tool('Read internal/api/ratelimit.go', 'Read'),
    reply(
      'The limit is per plan in `limitFor`. I will raise enterprise to 3000 and keep trials at 600.',
    ),
    ['ask.opened', { ask: edit }],
  ])

  // Approval: a tool that is not a shell (an MCP server's).
  const merge = session(
    'Merge the Sessions launch docs',
    'waiting',
    25,
    'slack',
    null,
  )
  const mcp = approvalAsk(
    merge,
    25,
    'tn_preview',
    'mcp__github__merge_pull_request',
    {
      owner: 'diggerhq',
      repo: 'opencomputer',
      pull_number: 4188,
      merge_method: 'squash',
      commit_title: 'docs: sessions launch (#4188)',
    },
    null,
  )
  merge.asks = [mcp]
  history(merge, 25, [
    said('Once the checks pass, merge the launch docs PR.', viaSlack),
    ...tool('gh pr checks 4188'),
    reply('All 14 checks passed and it has one approval.'),
    ['ask.opened', { ask: mcp }],
  ])

  // Question, two options.
  const flag = session(
    'Turn on usage-based billing for new orgs',
    'waiting',
    31,
    'dashboard',
    null,
  )
  const two = questionAsk(
    flag,
    31,
    'tn_preview',
    'Roll out to every new org at once, or 10% first?',
    [
      ['Everyone at once', 'Simpler; the flag can still be turned off'],
      ['10% first', 'Watch invoices for a week, then widen'],
    ],
  )
  flag.asks = [two]
  history(flag, 31, [
    said('Turn on usage-based billing for orgs created from today.'),
    ...tool('Read internal/billing/flags.go', 'Read'),
    reply(
      'The flag `usage_billing_new_orgs` exists and is off. It can take a percentage.',
    ),
    ['ask.opened', { ask: two }],
  ])

  // Question, five options, any number of answers.
  const regions = session(
    'Pick regions for the EU data residency beta',
    'waiting',
    55,
    'slack',
    null,
  )
  const five = questionAsk(
    regions,
    55,
    'tn_preview',
    'Which regions should the beta run in?',
    [
      ['Frankfurt', 'eu-central-1; most beta customers are in Germany'],
      ['Ireland', 'eu-west-1; cheapest of the five'],
      ['Paris', 'eu-west-3'],
      ['Stockholm', 'eu-north-1; lowest carbon'],
      ['Milan', 'eu-south-1; no GPU capacity yet'],
    ],
    true,
  )
  regions.asks = [five]
  history(regions, 55, [
    said('Set up the EU data residency beta.', viaSlack),
    ...tool('Read deploy/regions.yaml', 'Read'),
    reply('Five EU regions have capacity for workers today.'),
    ['ask.opened', { ask: five }],
  ])

  // A plain reply: the turn ended in text that needs the person
  // (attention.reason = reply, tech design 3.7).
  const pricing = session(
    'Compare the cost of the three sandbox sizes on the new hosts',
    'waiting',
    64,
    'dashboard',
    'Here is the comparison. Shall I update the pricing page?',
    {
      attention: {
        reason: 'reply',
        ref: 'tn_pricing',
        line: 'Shall I update the pricing page with the new sizes?',
        at: ago(64),
      },
    },
  )
  history(
    pricing,
    64,
    [
      said('Compare what the three sandbox sizes cost us on the new hosts.'),
      ...tool('Query PostHog: sandbox hours by size', 'mcp__posthog__query'),
      ...tool('Read internal/billing/prices.go', 'Read'),
      reply(
        [
          'Here is what each size costs us per hour on the new hosts, against what we charge:',
          '',
          '| Size | vCPU | Memory | Cost / h | Price / h | Margin |',
          '| --- | --- | --- | --- | --- | --- |',
          '| Small | 1 | 2 GB | $0.011 | $0.025 | 56% |',
          '| Medium | 2 | 4 GB | $0.019 | $0.050 | 62% |',
          '| Large | 4 | 8 GB | $0.034 | $0.100 | 66% |',
          '',
          'The prices live in one table:',
          '',
          '```go',
          'var hourly = map[Size]Cents{',
          '\tSmall:  2.5,',
          '\tMedium: 5.0,',
          '\tLarge:  10.0,',
          '}',
          '```',
          '',
          'Margins went up 9 points on average because the new hosts pack more sandboxes per machine. Small is the one size under 60%.',
          '',
          'Shall I update the pricing page with the new sizes, or keep the current prices and only change the copy?',
        ].join('\n'),
      ),
      done,
    ],
    'tn_pricing',
  )

  // Set aside earlier: a plan to review.
  const plan = session(
    'Move session titles to a fast model',
    'waiting',
    90,
    'dashboard',
    null,
  )
  const planAsk = approvalAsk(
    plan,
    90,
    'tn_preview',
    'ExitPlanMode',
    {
      plan: [
        '## Titles from a fast model',
        '',
        '1. Add `titleModel` to the runner config, defaulting to Haiku.',
        '2. Call it once, after the first turn, with the first message only.',
        '3. Keep the current title when the call fails or takes over 10 s.',
        '4. Tests: a failing model keeps the old title; a slow one is cut off.',
      ].join('\n'),
    },
    'acceptEdits',
  )
  plan.asks = [planAsk]
  plan.asideRef = planAsk.id as string
  history(plan, 90, [
    said('Plan how to make session titles cheaper. Do not change code yet.'),
    ...tool('Read computer/src/runner/harness/claude/title.ts', 'Read'),
    reply('Titles start a one-shot Claude Code today. The plan is below.'),
    ['ask.opened', { ask: planAsk }],
  ])

  const flaky = session(
    'Fix the flaky checkout e2e test',
    'running',
    0,
    'dashboard',
    'Running the suite 20 times to confirm the fix…',
    { activeTurnId: 'tn_preview' },
  )
  history(flaky, 6, [
    said(
      'checkout.spec.ts fails about one run in five on CI. Find out why and fix it.',
    ),
    ...tool('Read e2e/checkout.spec.ts', 'Read'),
    ...tool('npx playwright test checkout --repeat-each 10'),
    reply(
      'It fails when the cart badge renders before the price API answers: the test clicks **Checkout** while the button is still disabled. I will wait for the price instead of the badge.',
    ),
    ...tool('Edit e2e/checkout.spec.ts', 'Edit'),
    [
      'tool.started',
      {
        toolName: 'Bash',
        callId: 'call_live',
        parentCallId: null,
        title: 'npx playwright test checkout --repeat-each 20',
      },
    ],
  ])

  const churn = session(
    'Weekly churn report',
    'idle',
    52,
    'slack',
    'Posted the report: churn is 2.1%, down from 2.6% last week.',
  )
  history(churn, 52, [
    said('Run the weekly churn report and post it in #metrics', viaSlack),
    ...tool('Query PostHog: active orgs by week', 'mcp__posthog__query'),
    ...tool('Render churn chart', 'Bash'),
    reply(
      'Posted the report in #metrics.\n\n| Week | Churn |\n| --- | --- |\n| Nov 3 | 2.6% |\n| Nov 10 | 2.1% |\n\nThe drop comes from fewer cancellations on the Pro plan.',
    ),
    done,
  ])

  const more: Array<[string, string, number, string, string]> = [
    [
      'Upgrade React Router to v7',
      'idle',
      180,
      'opc',
      'Opened #4182: all routes load and tests pass.',
    ],
    [
      'Investigate 502s on api-edge',
      'suspended',
      60 * 20,
      'slack',
      'The 502s came from a cold Durable Object; fixed in #4170.',
    ],
    [
      'Draft the launch post for Sessions',
      'suspended',
      60 * 26,
      'dashboard',
      'Draft is in docs/launch/sessions.md.',
    ],
    [
      'Why did the November invoice double?',
      'suspended',
      60 * 50,
      'slack',
      'Two subscriptions overlapped for a day; refunded the extra.',
    ],
    [
      'Add rate limits to the public API',
      'suspended',
      60 * 74,
      'api',
      'Merged #4101: 600 requests a minute per key.',
    ],
    [
      'Clean up stale feature flags',
      'suspended',
      60 * 98,
      'dashboard',
      'Removed 14 flags; 3 still read in production.',
    ],
  ]
  for (const [title, status, min, origin, text] of more) {
    const s = session(title, status, min, origin, text)
    history(s, min, [
      said(title),
      ...tool('Explore the repository', 'Task'),
      reply(text),
      done,
    ])
  }
}
seed()

const capabilities = {
  models: [
    {
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      contextWindow: 1_000_000,
      default: true,
    },
    {
      id: 'claude-sonnet-5-5',
      name: 'Claude Sonnet 5.5',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      contextWindow: 1_000_000,
      default: false,
    },
    {
      id: 'gpt-6.1-sol',
      name: 'GPT-6.1 Sol (Codex)',
      efforts: ['low', 'medium', 'high', 'xhigh'],
      contextWindow: 400_000,
      default: false,
    },
  ],
  modes: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
  features: {
    steer: true,
    compact: true,
    terminal: true,
    workspace: true,
    reasoning: true,
    subagents: true,
  },
}

// A short canned turn: two tool calls and a reply, then idle.
function playTurn(s: MockSession, input: string) {
  s.status = 'running'
  s.activeTurnId = nextId('tn')
  s.lastText = 'Working…'
  const steps: Array<() => void> = [
    () => emit(s, 'turn.started', { model: s.settings, trigger: 'message' }),
    () => {
      const callId = nextId('call')
      emit(s, 'tool.started', {
        toolName: 'Bash',
        callId,
        parentCallId: null,
        title: 'git log --oneline -5',
      })
      setTimeout(
        () =>
          emit(s, 'tool.completed', {
            toolName: 'Bash',
            callId,
            parentCallId: null,
            title: 'git log --oneline -5',
          }),
        700,
      )
    },
    () => {
      const text = `Done. This is preview data, so nothing ran; in production Computer would now work on: “${input.slice(0, 120)}”.`
      emit(s, 'message.completed', {
        blockId: nextId('b'),
        parentCallId: null,
        text,
      })
      s.lastText = text
    },
    () => {
      emit(s, 'turn.completed', { text: null, durationMs: 4000, silent: false })
      s.status = 'idle'
      s.activeTurnId = null
    },
  ]
  steps.forEach((step, i) => setTimeout(step, 600 + i * 1300))
}

// A session as the API returns it: `aside` while the ask set aside is still
// the oldest open one.
function view(s: MockSession): Json {
  const { asideRef, ...rest } = s
  const open = s.asks
    .filter((a) => a.status === 'open')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  return { ...rest, aside: !!asideRef && open[0]?.id === asideRef }
}

const wait = <T>(ms: number, value: () => T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value()), ms))

const PREFIX = '/managed-agents/computer'

// Returns undefined for paths it does not serve.
export function computerSessionsMock(
  path: string,
  method: string,
  body: unknown,
): unknown {
  const [pathname, search = ''] = path.split('?')
  const query = new URLSearchParams(search)
  if (!pathname.startsWith(PREFIX)) return undefined
  const rest = pathname.slice(PREFIX.length)
  const input = (
    typeof body === 'string' ? JSON.parse(body || '{}') : {}
  ) as Json

  if (rest === '/capabilities') return { capabilities }

  // The old dashboard list shares the path without a query; leave it alone.
  if (rest === '/sessions' && method === 'GET' && search) {
    const statuses = query.get('status')?.split(',')
    const q = query.get('q')?.toLowerCase()
    const archived = query.get('archived') ?? 'false'
    const rows = sessions
      .filter((s) => !statuses || statuses.includes(s.status))
      .filter((s) => !q || s.title.toLowerCase().includes(q))
      .filter((s) => archived === 'all' || s.archived === (archived === 'true'))
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
    return { sessions: rows.map(view), nextCursor: null }
  }
  if (rest === '/sessions' && method === 'POST') {
    const text = typeof input.input === 'string' ? input.input : ''
    const s = session(
      text.split('\n')[0].slice(0, 60) || 'New session',
      'starting',
      0,
      'dashboard',
      null,
    )
    s.settings = { ...settings, ...pick(input, ['model', 'effort', 'mode']) }
    emit(s, 'message.received', { input: text, delivery: 'started' }, me)
    playTurn(s, text)
    return { session: view(s) }
  }

  const m = rest.match(/^\/sessions\/([^/]+)(\/.*)?$/)
  if (!m) return undefined
  const s = sessions.find((x) => x.id === m[1])
  if (!s) return undefined
  const sub = m[2] ?? ''

  if (sub === '' && method === 'GET') return { session: view(s) }
  if (sub === '' && method === 'PATCH') {
    Object.assign(s, pick(input, ['title', 'archived']))
    s.settings = {
      ...(s.settings as Json),
      ...pick(input, ['model', 'effort', 'mode']),
    }
    return { session: view(s), seq: s.lastSeq }
  }
  if (sub === '/aside' && method === 'PUT') {
    s.asideRef = typeof input.ref === 'string' ? input.ref : null
    return { session: view(s) }
  }
  if (sub === '/aside' && method === 'DELETE') {
    s.asideRef = null
    return { session: view(s) }
  }
  if (sub === '/events') {
    const events = journal.get(s.id)!
    const after = query.get('after')
    const page = () => {
      const from = after === null ? 0 : Number(after)
      return {
        events: events.filter((e) => e.seq > from),
        earlierTurns: null,
        lastSeq: s.lastSeq,
        hasMore: false,
      }
    }
    const waitMs = Number(query.get('waitMs') ?? 0)
    if (after !== null && Number(after) >= s.lastSeq && waitMs) {
      // Hold like the server does, but wake early when something arrives.
      return new Promise((resolve) => {
        const started = now()
        const tick = setInterval(() => {
          if (s.lastSeq > Number(after) || now() - started > waitMs) {
            clearInterval(tick)
            resolve(page())
          }
        }, 250)
      })
    }
    return page()
  }
  if (sub === '/turns' && method === 'POST') {
    const text = typeof input.input === 'string' ? input.input : ''
    // Steering a waiting session answers its open asks with the message.
    // Preview of a failed send: a message containing "[offline]" is refused.
    if (text.includes('[offline]'))
      return Promise.reject(new ApiError('Network error', 503))
    s.attention = null
    if (input.ifBusy === 'steer') {
      for (const ask of s.asks.filter((a) => a.status === 'open')) {
        Object.assign(ask, {
          status: 'declined',
          closedAt: new Date().toISOString(),
        })
        emit(s, 'ask.closed', { ask })
      }
      s.asks = []
    }
    emit(
      s,
      'message.received',
      { input: text, ifBusy: input.ifBusy, delivery: 'started' },
      me,
    )
    playTurn(s, text)
    return wait(300, () => ({
      turn: { id: s.activeTurnId, status: 'running' },
      delivery: 'started',
      duplicate: false,
      seq: s.lastSeq,
    }))
  }
  if (sub === '/interrupt' && method === 'POST') {
    emit(s, 'turn.cancelled', {})
    s.status = 'idle'
    s.activeTurnId = null
    return { session: view(s) }
  }
  const askMatch = sub.match(/^\/asks\/([^/]+)\/(answer|dismiss)$/)
  if (askMatch && method === 'POST') {
    const ask = s.asks.find((a) => a.id === askMatch[1])
    if (!ask) return undefined
    Object.assign(ask, {
      status: askMatch[2] === 'answer' ? 'answered' : 'dismissed',
      closedAt: new Date().toISOString(),
      answer: input,
    })
    s.asks = []
    s.attention = null
    emit(s, 'ask.closed', { ask })
    playTurn(s, 'continue after your answer')
    return { ask, seq: s.lastSeq }
  }
  return undefined
}

function pick(o: Json, keys: string[]): Json {
  return Object.fromEntries(
    keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]),
  )
}
