// @vitest-environment node
// The product's journeys (tracks-and-threads spec, section 11) at the level of
// the store: an action is called and the derived views are read. The server is
// the managed-agents Worker run locally (services/managed-agents/test/fixtures/
// stack.ts); the test is the computer and the agent, making the calls the
// runner's work tools make (computer/src/runner/work-tools.ts).

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { makeId, memoryStorage, type Failure } from '@opencomputer/sdk/computer'
import {
  startStack,
  type Stack,
} from '../../../../services/managed-agents/test/fixtures/stack'
import type { Host, Location } from '../host'
import { NOWHERE } from '../host'
import { createSurface } from './surface-store'
import { buildTranscript } from './transcript'
import type { Mark, ThreadView, TrackView } from './views'

vi.setConfig({ testTimeout: 30_000 })

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))
type Note = Parameters<Host['notify']>[0]

let stack: Stack
let orgs = 0
beforeAll(async () => {
  stack = await startStack()
}, 60_000)
afterAll(() => stack?.close())

const closers: (() => void)[] = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
})

async function until(what: () => unknown, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end)
      throw new Error(`timed out waiting for ${String(what)}`)
    await sleep(10)
  }
}

// A surface over the stack, in this process: nothing of a browser.
async function open() {
  const org = `org_j${++orgs}${Math.random().toString(36).slice(2, 8)}`
  const me = await stack.member(org, 'ada')
  const computer = await stack.host(org)
  const net = me.net()
  const notes: Note[] = []
  let loc: Location = NOWHERE
  const host: Host = {
    platform: 'web',
    principal: { org, subject: me.principal.subject },
    api: { fetch: (path, init) => net.fetch(path, init) },
    connect: () => net.connect(),
    notify: (n) => void notes.push(n),
    badge: () => {},
    openExternal: () => {},
    onOpen: () => {},
    location: {
      get: () => loc,
      set: (l) => void (loc = l),
      onChange: () => () => {},
    },
  }
  const s = createSurface({
    host,
    storage: memoryStorage(),
    visible: () => true,
  })
  const failures: Failure[] = []
  const stop = s.client.failures.subscribe((f) => void failures.push(f))
  closers.push(() => (stop(), s.close()))
  await until(() => s.get().ready && s.get().synced)

  const wait = (what: () => unknown) => until(what)
  const loose = (sid: string): ThreadView | undefined =>
    s.list().threads.find((t) => t.id === sid)
  const track = (tid: string): TrackView | undefined =>
    s.list().tracks.find((t) => t.id === tid)
  // Nobody is waiting on anybody, and nothing of ours is unconfirmed.
  const settled = (sid: string) => {
    const t = s.thread(sid)
    return (
      !!t &&
      t.session.status === 'idle' &&
      t.session.lastAgentSeq > 0 &&
      !s.get().pending.length
    )
  }
  // Every mark a thread shows from here on.
  const marks = (sid: string) => {
    const seen = new Set<Mark>()
    const note = () => {
      const t = s.thread(sid)
      if (t) seen.add(t.mark)
    }
    note()
    closers.push(s.store.subscribe(note))
    return seen
  }
  // The messages of a conversation, as the pane would list them.
  const transcript = (sid: string) =>
    buildTranscript(s.get().convos[sid]?.events ?? [])

  // ---- the agent: a call of one of its tools, as session `sid`
  async function agent<T = unknown>(
    sid: string,
    method: string,
    path: string,
    body: unknown = {},
  ): Promise<T> {
    const a = await stack.agent(org, sid)
    const r = await a.fetch(path, {
      method,
      body: JSON.stringify(body),
      headers: { 'idempotency-key': `idem_${makeId('op').slice(3)}` },
    })
    if (r.status >= 300)
      throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`)
    return (r.status === 204 ? null : await r.json()) as T
  }
  // The agent's turn: it waits for the next message, does `act`, says `text` and ends.
  async function turn(
    sid: string,
    text: string,
    act?: (input: string) => Promise<unknown>,
  ): Promise<void> {
    const t = await computer.turn(sid)
    await act?.(t.input)
    computer.say(sid, text)
    computer.end(sid)
  }

  // J5's opening, for the journeys that happen in a track: the start box's
  // agent starts a track; its agent starts two threads, all quiet.
  const startTrack = async () => {
    const sid = s.start('Build the billing page, track it', { open: true })
    const tid = makeId('trk')
    const lead = makeId('cs')
    await turn(sid, 'Started a track.', (input) =>
      agent(sid, 'POST', '/work/tracks', {
        tid,
        agentSessionId: lead,
        firstInput: input,
        name: 'Billing page',
      }),
    )
    const threads: string[] = []
    await turn(lead, 'Two threads are on it.', async () => {
      for (const input of ['Draft the billing page', 'Wire the billing API']) {
        const r = await agent<{ session: { id: string } }>(
          lead,
          'POST',
          '/sessions',
          { input, trackId: tid },
        )
        threads.push(r.session.id)
      }
    })
    for (const t of threads) await turn(t, 'On it.')
    await wait(
      () =>
        track(tid)?.threads.length === 2 &&
        track(tid)!.threads.every((t) => settled(t.id)) &&
        track(tid)!.agent?.status === 'idle',
    )
    return { tid, lead, threads: track(tid)!.threads.map((t) => t.id) }
  }

  return {
    org,
    me,
    net,
    computer,
    s,
    notes,
    failures,
    wait,
    loose,
    track,
    settled,
    marks,
    transcript,
    agent,
    turn,
    startTrack,
  }
}

const text = (
  items: ReturnType<typeof buildTranscript>,
  kind: 'user' | 'agent',
) => items.flatMap((i) => (i.kind === kind ? [i.text] : []))

describe('journeys', () => {
  it('J1 first use: a row under Threads at once, the agent names it, the transcript has both sides', async () => {
    const { s, wait, loose, settled, transcript, computer, turn } = await open()
    expect(s.list()).toMatchObject({ tracks: [], threads: [], earlier: 0 })

    const sid = s.start('What does the handler do? Keep it short', {
      open: true,
    })
    // Before the server has heard of it.
    expect(s.list().threads.map((t) => t.id)).toEqual([sid])
    expect(loose(sid)!.title).toBe('What does the handler do? Keep it short')
    expect(s.get().loc.thread).toBe(sid)
    const stop = s.watch(sid)

    await turn(sid, 'It parses the request and calls the store.')
    computer.name(
      sid,
      'What does the handler do? Keep it short',
      'What the handler does',
    )
    await wait(
      () => settled(sid) && loose(sid)?.title === 'What the handler does',
    )
    expect(s.list().threads.map((t) => t.id)).toEqual([sid])
    expect(s.list().tracks).toEqual([])

    await wait(() => text(transcript(sid), 'agent').length)
    expect(text(transcript(sid), 'user')).toEqual([
      'What does the handler do? Keep it short',
    ])
    expect(text(transcript(sid), 'agent')).toEqual([
      'It parses the request and calls the store.',
    ])
    stop()
  })

  it('J2 a quick question: quiet and bold until read', async () => {
    const { s, wait, loose, settled, turn } = await open()
    const sid = s.start('Why is the build slow', { open: false })
    expect(s.get().loc.thread).toBeNull()
    await turn(sid, 'The cache is cold on every run.')
    await wait(() => settled(sid))
    // Answered, not proposed as done (R8): no mark, bold.
    expect(loose(sid)).toMatchObject({
      mark: null,
      unread: true,
      proposals: [],
    })

    s.openThread(sid)
    await wait(() => loose(sid)?.unread === false && !s.get().pending.length)
  })

  it('J3/J4 the agent makes a track around a thread; Undo puts the thread back', async () => {
    const { s, wait, loose, settled, track, agent, turn } = await open()
    const sid = s.start('Speed up the handler', { open: true })
    await turn(sid, 'Done a first pass.')
    await wait(() => settled(sid))

    s.send(sid, 'This is several pieces now: make it a track')
    const tid = makeId('trk')
    await turn(sid, 'This thread is now in a track.', () =>
      agent(sid, 'POST', '/work/tracks', {
        tid,
        agentSessionId: makeId('cs'),
        sid,
        name: 'Handler speed',
      }),
    )
    await wait(() => track(tid)?.threads.length && settled(sid))
    expect(s.list().threads).toEqual([])
    expect(track(tid)!.threads.map((t) => t.id)).toEqual([sid])
    // The person stays in the thread (R22).
    expect(s.get().loc.thread).toBe(sid)

    const op = [...s.get().rows.op.values()].find(
      (o) => o.name === 'track.create' && o.trackId === tid,
    )
    expect(op).toBeDefined()
    s.undo(op!.id)
    await wait(() => !track(tid) && !s.get().pending.length)
    await wait(() => loose(sid))
    expect(s.thread(sid)!.trackId).toBeNull()
    expect(s.get().loc.thread).toBe(sid)
  })

  it('J5 starting with "track it": a track appears with its threads, and the start thread goes', async () => {
    const { s, wait, track, startTrack } = await open()
    const { tid, threads } = await startTrack()
    const k = track(tid)!
    expect(s.list().threads).toEqual([])
    expect(k.name).toBe('Billing page')
    expect(k.threads.map((t) => t.id).sort()).toEqual([...threads].sort())
    await wait(() => s.get().rows.session.size === 3)
  })

  it("S4 the Doc: a save over a Doc the agent changed meanwhile merges both, and marks the person's lines", async () => {
    const { s, wait, agent, startTrack } = await open()
    const { tid, lead } = await startTrack()
    const doc = (rev: number, text: string) =>
      agent(lead, 'PUT', `/work/tracks/${tid}/doc`, { baseRev: rev, text })
    await doc(0, '## Goal\nA billing page\n\n## Plan\nOne page')
    await wait(() => s.get().rows.doc.get(tid)?.text)
    const before = s.get().rows.doc.get(tid)!
    const base = { rev: before.rev, text: before.text }
    // The person edits the first line while the agent appends a change of course.
    const lines = before.text.split('\n')
    lines[0] = '## Goal, as I see it'
    const mine = lines.join('\n')
    await doc(before.rev, `${before.text}\n\n## Changed course\nUse Stripe`)
    await wait(() => s.get().rows.doc.get(tid)!.rev > base.rev)
    const { conflicts } = await s.saveDoc(tid, mine, base)
    expect(conflicts).toBe(0)
    await wait(() => !s.get().pending.length)
    const after = s.get().rows.doc.get(tid)!
    expect(after.text.split('\n')[0]).toBe('## Goal, as I see it')
    expect(after.text).toContain('## Changed course')
    expect(after.spans).toEqual([
      { from: 0, to: 1, by: `user:${s.host.principal.subject}` },
    ])
  })

  it('J7/J8 a blocked thread: a dot on its row and on its track, announced once; answering clears it', async () => {
    const { s, wait, track, settled, marks, notes, computer, startTrack } =
      await open()
    const { tid, threads } = await startTrack()
    const [sid, other] = threads
    expect(track(tid)!.mark).toBeNull()
    expect(s.list().blocked).toBe(0)
    expect(notes).toEqual([])

    s.send(sid, 'Restart the service, you have my permission to try')
    await computer.turn(sid)
    const askId = computer.ask(sid, {
      kind: 'approval',
      approval: {
        toolName: 'Bash',
        title: 'Restart the service',
        command: 'systemctl restart api',
        input: { command: 'systemctl restart api' },
      },
    })
    await wait(() => s.thread(sid)?.mark === 'blocked')
    const ask = s.thread(sid)!.ask!
    expect(ask).toMatchObject({ id: askId, kind: 'approval' })
    expect(s.thread(sid)!.word).toBe('blocked on you')
    expect(track(tid)!.mark).toBe('blocked')
    expect(s.thread(other)!.mark).toBeNull()
    expect(s.list().blocked).toBe(1)
    // Nothing moved, and nobody was taken anywhere.
    expect(track(tid)!.threads.map((t) => t.id)).toEqual(threads)
    expect(s.get().loc.thread).toBeNull()
    expect(notes.map((n) => n.threadId)).toEqual([sid])
    expect(notes[0]).toMatchObject({
      askId,
      choices: [{ id: 'allow' }, { id: 'deny' }],
    })

    const seen = marks(sid)
    s.answer(sid, askId, { decision: 'allow' })
    // At once, and the dot does not come back while the server catches up.
    expect(s.thread(sid)!.mark).toBe('working')
    seen.clear()
    await wait(() => !s.thread(sid)!.ask && !s.get().pending.length)
    computer.say(sid, 'Restarted.')
    computer.end(sid)
    await wait(() => settled(sid))
    expect(s.thread(sid)!.mark).toBeNull()
    expect(track(tid)!.mark).toBeNull()
    expect(s.list().blocked).toBe(0)
    expect([...seen]).not.toContain('blocked')
    expect(notes).toHaveLength(1)
  })

  it('J9 a thread with a pull request: ring, cleared by reading; Done, Undo, and a reply returns it to working', async () => {
    const { s, wait, loose, settled, marks, agent, turn } = await open()
    const sid = s.start('Open a PR for the slow query', { open: false })
    const pr = makeId('res')
    await turn(sid, 'The PR is up.', async () => {
      await agent(sid, 'PUT', `/work/results/${pr}`, {
        sid,
        kind: 'pr',
        ref: 'https://github.com/acme/app/pull/7',
        title: 'Index the slow query',
      })
      await agent(sid, 'PUT', `/work/threads/${sid}/ready`, {
        what: 'The PR is ready to review',
        resultId: pr,
      })
      await agent(sid, 'POST', '/work/proposals', {
        proposalId: makeId('prp'),
        kind: 'done',
        target: sid,
        what: 'Opened the PR',
      })
    })
    await wait(
      () =>
        settled(sid) &&
        loose(sid)?.mark === 'ready' &&
        loose(sid)!.proposals.length,
    )
    const t = loose(sid)!
    expect(t.word).toBe('ready for you')
    expect(t.unread).toBe(true)
    expect(t.results.map((r) => r.type)).toEqual(['pr'])
    expect(t.readyResult).toBe(pr)
    expect(t.proposals.map((p) => p.type)).toEqual(['done'])

    // A look is not acceptance (R7): the ring and the bold go, nothing else.
    s.openThread(sid)
    await wait(() => loose(sid)?.mark === null && !s.get().pending.length)
    expect(loose(sid)).toMatchObject({
      unread: false,
      done: false,
      readyResult: null,
    })
    expect(loose(sid)!.proposals).toHaveLength(1)

    s.done(sid)
    // At once: out of the open list, and the person is on the start box.
    expect(s.list().threads).toEqual([])
    expect(s.get().loc).toMatchObject({ thread: null, start: true })
    expect(s.get().toasts.slice(-1)[0]).toMatchObject({ text: 'Marked done' })
    await wait(() => !s.get().pending.length && s.list().earlier === 1)
    expect(s.list().threads).toEqual([])

    expect(s.undoLast()).toBe(true)
    await wait(() => loose(sid) && !s.get().pending.length)
    expect(loose(sid)).toMatchObject({ done: false, mark: null })
    expect(s.list().earlier).toBe(0)

    const seen = marks(sid)
    s.send(sid, 'also handle the empty case')
    await wait(() => seen.has('working'))
    await turn(sid, 'Handled.')
    await wait(() => settled(sid))
    expect(loose(sid)!.done).toBe(false)
  })

  it('J11 the track’s agent suggests done: a ring on the track; Done closes it', async () => {
    const { s, wait, track, agent, startTrack } = await open()
    const { tid, lead, threads } = await startTrack()
    expect(track(tid)!.mark).toBeNull()

    for (const sid of threads) s.done(sid)
    await wait(
      () => !s.get().pending.length && track(tid)!.threads.length === 0,
    )
    await agent(lead, 'POST', '/work/proposals', {
      proposalId: makeId('prp'),
      kind: 'done',
      target: tid,
      what: 'The billing page is live',
    })
    await wait(() => track(tid)?.proposals.length)
    const k = track(tid)!
    expect(k.proposals.map((p) => p.type)).toEqual(['done'])
    expect(k.mark).toBe('ready')

    s.accept(k.proposals[0].id)
    await wait(() => !track(tid) && !s.get().pending.length)
    expect(s.list().tracks).toEqual([])
    expect(s.list().earlierTracks.map((x) => x.id)).toEqual([tid])
    expect(s.list().earlierTracks[0]).toMatchObject({ done: true, mark: null })
  })

  it('J11 Keep open: the ring clears and the track stays', async () => {
    const { s, wait, track, agent, startTrack } = await open()
    const { tid, lead } = await startTrack()
    await agent(lead, 'POST', '/work/proposals', {
      proposalId: makeId('prp'),
      kind: 'done',
      target: tid,
      what: 'The billing page is live',
    })
    await wait(() => track(tid)?.mark === 'ready')
    const p = track(tid)!.proposals[0]

    // What the Keep open button does.
    s.trackKeep(tid, true)
    s.dismissProposal(p.id)
    expect(track(tid)).toMatchObject({ mark: null, keep: true })
    await wait(() => !s.get().pending.length)
    await wait(() => track(tid)!.proposals.length === 0)
    expect(track(tid)).toMatchObject({ mark: null, keep: true, done: false })
    expect(s.list().earlierTracks).toEqual([])
  })

  it('J13 a done track reopens on a message in one of its threads', async () => {
    const { s, wait, track, turn, startTrack } = await open()
    const { tid, threads } = await startTrack()
    s.openTrack(tid)
    s.trackDone(tid)
    // At once, and the person lands on the start box (A11).
    expect(s.list().tracks).toEqual([])
    expect(s.get().loc).toMatchObject({ track: null, start: true })
    await wait(() => !s.get().pending.length && s.list().earlierTracks.length)
    expect(s.list().earlierTracks[0]).toMatchObject({ id: tid, done: true })

    s.send(threads[0], 'One more thing: the totals are off')
    await turn(threads[0], 'Fixed the totals.')
    await wait(() => track(tid))
    expect(track(tid)!.done).toBe(false)
    expect(s.list().earlierTracks).toEqual([])
    await wait(() => track(tid)!.threads.some((t) => t.id === threads[0]))
  })

  it('offline: an action shows at once and is confirmed after the connection returns', async () => {
    const { me, net, s, wait, loose, settled, turn } = await open()
    const sid = s.start('Why is the build slow', { open: true })
    await turn(sid, 'The cache is cold.')
    await wait(() => settled(sid))
    const title = async () => {
      const frame = (await (await me.fetch('/feed?kinds=session')).json()) as {
        rows: { id: string; title: string }[]
      }
      return frame.rows.find((r) => r.id === sid)?.title
    }

    net.offline(true)
    await wait(() => s.get().status === 'offline')
    s.rename(sid, 'Slow builds')
    expect(loose(sid)!.title).toBe('Slow builds')
    expect(s.get().pending).toHaveLength(1)
    await sleep(50)
    expect(loose(sid)!.title).toBe('Slow builds')
    expect(s.get().pending).toHaveLength(1)
    expect(await title()).toBe('Why is the build slow')

    net.offline(false)
    // The client tries again 1 to 5 seconds after the connection drops.
    await until(
      () => s.get().status === 'online' && !s.get().pending.length,
      20_000,
    )
    expect(await title()).toBe('Slow builds')
    expect(loose(sid)!.title).toBe('Slow builds')
    expect(s.get().toasts.filter((t) => t.tone === 'error')).toEqual([])
  })

  it('a refused write rolls back and lands in failures', async () => {
    const { s, wait, loose, settled, failures, turn } = await open()
    const sid = s.start('Why is the build slow', { open: false })
    await turn(sid, 'The cache is cold.')
    await wait(() => settled(sid))

    const missing = makeId('trk')
    s.place(sid, missing)
    // Shown as asked, until the server says no.
    expect(loose(sid)).toBeUndefined()
    expect(s.thread(sid)!.trackId).toBe(missing)

    await wait(() => failures.length)
    expect(failures[0].entry).toMatchObject({
      kind: 'mutation',
      name: 'thread.place',
    })
    expect(s.get().pending).toEqual([])
    expect(loose(sid)).toBeDefined()
    expect(s.thread(sid)!.trackId).toBeNull()
    const said = s.get().toasts.filter((t) => t.tone === 'error')
    expect(said).toHaveLength(1)
    expect(said[0].text).toMatch(/^Could not move it: /)
  })

  it.todo(
    'J2 a read thread goes under Earlier once aged: a server clock rule (Org tests), not the surface’s',
  )
  it.todo(
    'J9 merging the pull request makes the thread done: the merge arrives from GitHub, which the stack does not run',
  )
  it.todo(
    'J6 a one-line question to the start box becomes a thread: covered by J1, there is no second action',
  )
  it.todo(
    'J8 clicking the notification opens the thread at the block: Host.onOpen is the host’s to call; at the block is the UI’s',
  )
})
