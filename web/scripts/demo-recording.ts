// Records what the surface reads from the real server for a small organization
// into src/surface/demo-data.json, which `?fake` shows (src/surface/host-demo.ts).
// The server is the managed-agents Worker run locally; this script is the person,
// the computer and its agents.
//
//   node scripts/demo-recording.ts      (from web/, after `npm ci` in services/managed-agents)

import { writeFileSync } from 'node:fs'
import { startStack } from '../../services/managed-agents/test/fixtures/stack.ts'

const KINDS = [
  'session',
  'place',
  'track',
  'result',
  'proposal',
  'doc',
  'read',
  'pref',
  'machine',
  'op',
]
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
const id = (prefix: string, length = 16) =>
  `${prefix}_${Array.from({ length }, () => ALPHABET[Math.floor(Math.random() * 32)]).join('')}`
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

const stack = await startStack()
try {
  const org = 'org_demo'
  const me = await stack.member(org, 'igor')
  const computer = await stack.host(org)
  const send = async (
    caller: { fetch(p: string, i?: RequestInit): Promise<Response> },
    method: string,
    path: string,
    body: unknown,
  ) => {
    const r = await caller.fetch(path, {
      method,
      body: JSON.stringify(body),
      headers: { 'idempotency-key': id('idem') },
    })
    if (r.status >= 300)
      throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`)
    return r.status === 204 ? null : ((await r.json()) as unknown)
  }
  const agent = async (
    sid: string,
    method: string,
    path: string,
    body: unknown = {},
  ) => send(await stack.agent(org, sid), method, path, body)
  const start = async (input: string) => {
    const sid = id('cs')
    await send(me, 'POST', '/sessions', {
      id: sid,
      turnId: id('tn', 12),
      input,
      role: 'start',
    })
    return sid
  }
  const answer = async (sid: string, text: string) => {
    await computer.turn(sid)
    computer.say(sid, text)
    computer.end(sid)
  }

  // A thread answered and read.
  const quick = await start('Why is the build slow?')
  await answer(
    quick,
    'The dependency cache is keyed on the lockfile’s mtime, so every run misses it. Keying it on the hash fixes it.',
  )

  // A track, started from the start box, with a Doc and two threads: one
  // blocked on a permission, one with a pull request it proposes is done.
  const opener = await start('Build the billing page, track it')
  const tid = id('trk')
  const lead = id('cs')
  {
    const t = await computer.turn(opener)
    await agent(opener, 'POST', '/work/tracks', {
      tid,
      agentSessionId: lead,
      firstInput: t.input,
      name: 'Billing page',
    })
    computer.say(opener, 'Started a track for the billing page.')
    computer.end(opener)
  }
  const threads: string[] = []
  {
    await computer.turn(lead)
    await agent(lead, 'PUT', `/work/tracks/${tid}/doc`, {
      baseRev: 0,
      text: '## Goal\nA billing page: plan, invoices, card.\n\n## Plan\n- Page and layout\n- Stripe API wiring',
    })
    await agent(lead, 'PUT', `/work/tracks/${tid}/stand`, {
      stand: 'Layout drafted; wiring the API is waiting on a restart.',
    })
    for (const input of [
      'Draft the billing page layout',
      'Wire the billing API to Stripe',
    ]) {
      threads.push(
        (
          (await agent(lead, 'POST', '/sessions', { input, trackId: tid })) as {
            session: { id: string }
          }
        ).session.id,
      )
    }
    computer.say(lead, 'Two threads are on it.')
    computer.end(lead)
  }
  const [layout, wiring] = threads
  {
    await computer.turn(layout)
    computer.tool(layout, 'Edit web/src/billing/Page.tsx')
    const pr = id('res')
    await agent(layout, 'PUT', `/work/results/${pr}`, {
      sid: layout,
      kind: 'pr',
      ref: 'https://github.com/acme/app/pull/42',
      title: 'Billing page layout',
    })
    await agent(layout, 'PUT', `/work/threads/${layout}/ready`, {
      what: 'The layout PR is ready to review',
      resultId: pr,
    })
    await agent(layout, 'POST', '/work/proposals', {
      proposalId: id('prp'),
      kind: 'done',
      target: layout,
      what: 'Opened the layout PR',
    })
    computer.say(
      layout,
      'The layout is in PR #42: plan card, invoice table and the card form.',
    )
    computer.end(layout)
  }
  {
    await computer.turn(wiring)
    computer.tool(wiring, 'Read services/billing/stripe.ts')
    computer.ask(wiring, {
      kind: 'approval',
      approval: {
        toolName: 'Bash',
        title: 'Restart the billing service',
        command: 'systemctl restart billing',
        input: { command: 'systemctl restart billing' },
      },
    })
  }

  // Everyone settled: nothing left running but the blocked thread. The start
  // box's thread is gone into the track (J5).
  const feed = async () =>
    (await (await me.fetch(`/feed?kinds=${KINDS.join(',')}`)).json()) as {
      rows: { kind: string; id: string; status?: string; role?: string }[]
    }
  for (let i = 0; ; i++) {
    const sessions = (await feed()).rows.filter((r) => r.kind === 'session')
    if (
      sessions.length === 4 &&
      sessions.every((s) => s.id === wiring || s.status === 'idle')
    )
      break
    if (i > 200)
      throw new Error(
        `the organization did not settle: ${JSON.stringify(sessions.map((s) => [s.id, s.status, s.role]))}`,
      )
    await sleep(50)
  }
  await send(me, 'PUT', `/work/reads/${quick}`, { seq: 1_000_000 }).catch(() =>
    send(me, 'PUT', `/work/reads/${quick}`, { seq: 1 }),
  )

  const replies: Record<string, unknown> = {}
  const record = async (path: string) => {
    const r = await me.fetch(path)
    if (r.status !== 200)
      throw new Error(`GET ${path}: ${r.status} ${await r.text()}`)
    replies[path.split('?')[0]] = await r.json()
  }
  await record(`/feed?kinds=${KINDS.join(',')}`)
  for (const sid of [quick, lead, layout, wiring])
    await record(`/sessions/${sid}/events?tailTurns=20`)
  await record('/capabilities')
  await record('/work/threads?done=1&limit=50')

  const out = new URL('../src/surface/demo-data.json', import.meta.url)
  writeFileSync(
    out,
    `${JSON.stringify({ principal: { org, subject: me.principal.subject }, replies }, null, 1)}\n`,
  )
  console.log(`wrote ${out.pathname}`)
} finally {
  await stack.close()
}
