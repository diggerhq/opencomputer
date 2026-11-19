// Preview data for the Computer API v1 sessions routes (work 107), served by
// mockFetch under VITE_PREVIEW. Times are relative to now so the sidebar reads
// naturally; sending a message plays back a short canned turn.

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
) {
  const events = journal.get(s.id)!
  steps.forEach(([type, data, actor], i) => {
    events.push({
      id: nextId('ev'),
      seq: events.length + 1,
      createdAt: ago(minAgo + (steps.length - i) * 0.4),
      sessionId: s.id,
      turnId: 'tn_preview',
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

function approvalAsk(s: MockSession, title: string, command: string): Json {
  return {
    id: nextId('ak'),
    sessionId: s.id,
    turnId: 'tn_preview',
    kind: 'approval',
    status: 'open',
    createdAt: ago(3),
    closedAt: null,
    closedBy: null,
    answer: null,
    approval: {
      toolName: 'Bash',
      callId: 'call_x',
      input: { command },
      title,
      alwaysAllows: 'Bash(psql:*)',
    },
    question: null,
    secret: null,
  }
}

function seed() {
  const rotate = session(
    'Rotate the staging database password',
    'waiting',
    3,
    'dashboard',
    'Ready to rotate the password and update the secret.',
  )
  const ask = approvalAsk(
    rotate,
    'Run psql on staging',
    'psql $STAGING_URL -c "ALTER ROLE app PASSWORD \'…\'"',
  )
  rotate.asks = [ask]
  history(rotate, 3, [
    said('Rotate the staging database password and update the app secret.'),
    ...tool('Read deploy/staging.env', 'Read'),
    ...tool('grep -rn STAGING_DB_PASSWORD .'),
    reply(
      'The app reads `STAGING_DB_PASSWORD` from the organization secrets. I will set a new password on the `app` role, then update the secret.',
    ),
    ['ask.opened', { ask }],
  ])

  const charts = session(
    'Pick a chart library for the usage page',
    'waiting',
    18,
    'slack',
    null,
  )
  const question = {
    id: nextId('ak'),
    sessionId: charts.id,
    turnId: 'tn_preview',
    kind: 'question',
    status: 'open',
    createdAt: ago(18),
    closedAt: null,
    closedBy: null,
    answer: null,
    approval: null,
    question: {
      questions: [
        {
          id: 'q1',
          header: 'Library',
          text: 'Which chart library should the usage page use?',
          multiSelect: false,
          options: [
            { label: 'Recharts', description: 'Already in the bundle' },
            { label: 'visx', description: 'Lower level, smaller' },
            { label: 'ECharts', description: 'Heavier, more chart types' },
          ],
        },
      ],
    },
    secret: null,
  }
  charts.asks = [question]
  history(charts, 18, [
    said('Add a daily usage chart to the billing page', viaSlack),
    ...tool('Read web/src/pages/Billing.tsx', 'Read'),
    ['ask.opened', { ask: question }],
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
    return { sessions: rows, nextCursor: null }
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
    return { session: s }
  }

  const m = rest.match(/^\/sessions\/([^/]+)(\/.*)?$/)
  if (!m) return undefined
  const s = sessions.find((x) => x.id === m[1])
  if (!s) return undefined
  const sub = m[2] ?? ''

  if (sub === '' && method === 'GET') return { session: s }
  if (sub === '' && method === 'PATCH') {
    Object.assign(s, pick(input, ['title', 'archived']))
    s.settings = {
      ...(s.settings as Json),
      ...pick(input, ['model', 'effort', 'mode']),
    }
    return { session: s, seq: s.lastSeq }
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
    return { session: s }
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
