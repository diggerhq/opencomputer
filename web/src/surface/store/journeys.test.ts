// @vitest-environment node
// The product's journeys (tracks-and-threads spec, section 11) at the level of
// the store: an action is called and the derived views are read. The server is
// the SDK's fake, with its scripted agents answering at once.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { memoryStorage, type Failure } from '@opencomputer/sdk/computer'
import { createFakeServer, type FakeOptions, type FakeServer } from '@opencomputer/sdk/computer/fake'
import type { Host, Location } from '../host'
import { NOWHERE } from '../host'
import { createSurface } from './index'
import { buildTranscript } from './transcript'
import type { Mark, ThreadView, TrackView } from './views'

const DAY = 24 * 60 * 60 * 1000
// The real one, for a turn of the event loop while the clock is faked.
const realTimeout = globalThis.setTimeout
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type Note = Parameters<Host['notify']>[0]

const closers: (() => void)[] = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
  vi.useRealTimers()
})

async function until(fake: FakeServer, what: () => unknown, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${String(what)}`)
    await fake.idle()
    await sleep(1)
  }
}

// A surface over a fake server in this process: nothing of a browser.
async function open(o: FakeOptions = {}) {
  const fake = createFakeServer({ seed: 'empty', pace: 0, latency: 0, ...o })
  const notes: Note[] = []
  let loc: Location = NOWHERE
  const host: Host = {
    platform: 'web',
    principal: fake.principal,
    api: { fetch: (path, init) => fake.fetch(path, init) },
    connect: () => fake.connect(),
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
  const s = createSurface({ host, storage: memoryStorage(), visible: () => true })
  const failures: Failure[] = []
  const stop = s.client.failures.subscribe((f) => void failures.push(f))
  closers.push(() => (stop(), s.close()))
  await until(fake, () => s.get().ready && s.get().synced)

  const wait = (what: () => unknown) => until(fake, what)
  const loose = (sid: string): ThreadView | undefined => s.list().threads.find((t) => t.id === sid)
  const track = (tid: string): TrackView | undefined => s.list().tracks.find((t) => t.id === tid)
  // Nobody is waiting on anybody, and nothing of ours is unconfirmed.
  const settled = (sid: string) => {
    const t = s.thread(sid)
    return !!t && t.session.status === 'idle' && t.session.lastAgentSeq > 0 && !s.get().pending.length
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
  const transcript = (sid: string) => buildTranscript(s.get().convos[sid]?.events ?? [])

  // J5's opening, for the journeys that happen in a track: a track with the
  // two threads its agent starts, all quiet.
  const startTrack = async () => {
    s.start('Build the billing page, track it', { open: true })
    await wait(() => s.list().tracks[0]?.threads.length === 2)
    const tid = s.list().tracks[0].id
    await wait(() => track(tid)!.threads.every((t) => settled(t.id)) && track(tid)!.agent?.status === 'idle')
    return { tid, threads: track(tid)!.threads.map((t) => t.id) }
  }

  return { fake, s, notes, failures, wait, loose, track, settled, marks, transcript, startTrack }
}

const text = (items: ReturnType<typeof buildTranscript>, kind: 'user' | 'agent') =>
  items.flatMap((i) => (i.kind === kind ? [i.text] : []))

describe('journeys', () => {
  it('J1 first use: a row under Threads at once, the agent names it, the transcript has both sides', async () => {
    const { s, wait, loose, settled, transcript } = await open()
    expect(s.list()).toMatchObject({ tracks: [], threads: [], earlier: 0 })

    const sid = s.start('What does the handler do? Keep it short', { open: true })
    // Before the server has heard of it.
    expect(s.list().threads.map((t) => t.id)).toEqual([sid])
    expect(loose(sid)!.title).toBe('What does the handler do? Keep it short')
    expect(s.get().loc.thread).toBe(sid)
    const stop = s.watch(sid)

    await wait(() => settled(sid))
    expect(s.list().threads.map((t) => t.id)).toEqual([sid])
    expect(s.list().tracks).toEqual([])
    expect(loose(sid)!.title).toBe('What does the handler do')

    await wait(() => text(transcript(sid), 'agent').length)
    expect(text(transcript(sid), 'user')).toEqual(['What does the handler do? Keep it short'])
    expect(text(transcript(sid), 'agent')[0]).toContain('On it: What does the handler do?')
    stop()
  })

  it('J2 a quick question: quiet and bold until read, then under Earlier once aged', async () => {
    const { fake, s, wait, loose, settled } = await open()
    const sid = s.start('Why is the build slow', { open: false })
    expect(s.get().loc.thread).toBeNull()
    await wait(() => settled(sid))
    // Answered, not proposed as done (R8): no mark, bold.
    expect(loose(sid)).toMatchObject({ mark: null, unread: true, proposals: [] })

    // Unread does not age.
    fake.age(8 * DAY)
    await fake.idle()
    await sleep(5)
    expect(loose(sid)).toMatchObject({ unread: true, earlier: false })

    s.openThread(sid)
    await wait(() => loose(sid)?.unread === false && !s.get().pending.length)
    s.openStart()

    fake.age(8 * DAY)
    await wait(() => !loose(sid))
    expect(s.list().threads).toEqual([])
    expect(s.list().earlier).toBe(1)
  })

  it('J3/J4 the agent proposes a track around a thread: accept puts the thread in it, undo puts it back', async () => {
    const { s, wait, loose, settled, track } = await open()
    const sid = s.start('Speed up the handler', { open: true })
    await wait(() => settled(sid))

    s.send(sid, 'This is several pieces now: make it a track')
    await wait(() => s.thread(sid)?.proposals.length && settled(sid))
    const proposal = s.thread(sid)!.proposals[0]
    expect(proposal.type).toBe('wrap')
    // A suggestion is a ring that reading does not clear (A5).
    expect(loose(sid)!.mark).toBe('ready')
    expect(s.list().tracks).toEqual([])

    s.accept(proposal.id)
    await wait(() => s.list().tracks.length && !s.get().pending.length)
    const tid = s.list().tracks[0].id
    expect(s.list().threads).toEqual([])
    expect(track(tid)!.threads.map((t) => t.id)).toEqual([sid])
    expect(s.thread(sid)!.proposals).toEqual([])
    // The person stays in the thread (R22).
    expect(s.get().loc.thread).toBe(sid)

    const op = [...s.get().rows.op.values()].find((o) => o.name === 'track.create' && o.trackId === tid)
    expect(op).toBeDefined()
    s.undo(op!.id)
    await wait(() => !s.list().tracks.length && !s.get().pending.length)
    expect(s.list().threads.map((t) => t.id)).toEqual([sid])
    expect(s.thread(sid)!.trackId).toBeNull()
    expect(s.get().loc.thread).toBe(sid)
  })

  it('J5 starting with "track it": a track appears with a first thread, and the person lands on the track', async () => {
    const { s, wait } = await open()
    const sid = s.start('Build the billing page, track it', { open: true })
    // Until the agent decides, it is a thread like any other.
    expect(s.list().threads.map((t) => t.id)).toEqual([sid])

    await wait(() => s.list().tracks[0]?.threads.length)
    const k = s.list().tracks[0]
    expect(s.list().threads).toEqual([])
    expect(s.thread(sid)).toBeUndefined()
    await wait(() => s.list().tracks[0].name !== 'New track')
    expect(s.list().tracks[0].name).toBe('Build the billing page, track it')
    await wait(() => s.get().rows.doc.get(k.id)?.text)
    expect(s.get().rows.doc.get(k.id)!.text).toContain('Build the billing page')
    // L4: the track, no thread, until the person clicks one (R22).
    expect(s.get().loc).toMatchObject({ thread: null, track: k.id, start: false })
    expect(s.get().openTracks[k.id]).toBe(true)
  })

  it('J7/J8 a blocked thread: a dot on its row and on its track, announced once; answering clears it', async () => {
    const { s, wait, track, settled, marks, notes, startTrack } = await open()
    const { tid, threads } = await startTrack()
    const [sid, other] = threads
    expect(track(tid)!.mark).toBeNull()
    expect(s.list().blocked).toBe(0)
    expect(notes).toEqual([])

    s.send(sid, 'Restart the service, you have my permission to try')
    await wait(() => s.thread(sid)?.mark === 'blocked')
    const ask = s.thread(sid)!.ask!
    expect(ask.kind).toBe('approval')
    expect(s.thread(sid)!.word).toBe('blocked on you')
    expect(track(tid)!.mark).toBe('blocked')
    expect(s.thread(other)!.mark).toBeNull()
    expect(s.list().blocked).toBe(1)
    // Nothing moved, and nobody was taken anywhere.
    expect(track(tid)!.threads.map((t) => t.id)).toEqual(threads)
    expect(s.get().loc).toMatchObject({ thread: null, track: tid })
    expect(notes.map((n) => n.threadId)).toEqual([sid])
    expect(notes[0]).toMatchObject({ askId: ask.id, choices: [{ id: 'allow' }, { id: 'deny' }] })

    const seen = marks(sid)
    s.answer(sid, ask.id, { decision: 'allow' })
    // At once, and the dot does not come back while the server catches up.
    expect(s.thread(sid)!.mark).toBe('working')
    seen.clear()
    await wait(() => settled(sid) && !s.thread(sid)!.ask)
    expect(s.thread(sid)!.mark).toBeNull()
    expect(track(tid)!.mark).toBeNull()
    expect(s.list().blocked).toBe(0)
    expect([...seen]).not.toContain('blocked')
    expect(notes).toHaveLength(1)
  })

  it('J9 a thread with a pull request: ring, cleared by reading; Done, Undo, and a reply returns it to working', async () => {
    const { s, wait, loose, settled, marks } = await open()
    const sid = s.start('Open a PR for the slow query', { open: false })
    await wait(() => settled(sid) && loose(sid)?.mark === 'ready')
    const t = loose(sid)!
    expect(t.word).toBe('ready for you')
    expect(t.unread).toBe(true)
    expect(t.results.map((r) => r.type).sort()).toEqual(['changes', 'pr'])
    expect(t.readyResult).toBe(t.results.find((r) => r.type === 'pr')!.id)
    expect(t.proposals.map((p) => p.type)).toEqual(['done'])

    // A look is not acceptance (R7): the ring and the bold go, nothing else.
    s.openThread(sid)
    await wait(() => loose(sid)?.mark === null && !s.get().pending.length)
    expect(loose(sid)).toMatchObject({ unread: false, done: false, readyResult: null })
    expect(loose(sid)!.proposals).toHaveLength(1)

    s.done(sid)
    // At once: out of the open list, and the person is on the start box.
    expect(s.list().threads).toEqual([])
    expect(s.get().loc).toMatchObject({ thread: null, start: true })
    expect(s.get().toasts.slice(-1)[0]).toMatchObject({ text: 'Marked done' })
    await wait(() => !s.get().pending.length && s.list().earlier === 1)
    expect(s.list().threads).toEqual([])
    const kept = s.thread(sid)
    if (kept) expect(kept).toMatchObject({ done: true, outcome: 'done', earlier: true })

    expect(s.undoLast()).toBe(true)
    await wait(() => loose(sid) && !s.get().pending.length)
    expect(loose(sid)).toMatchObject({ done: false, mark: null })
    expect(s.list().earlier).toBe(0)

    const seen = marks(sid)
    s.send(sid, 'also handle the empty case')
    await wait(() => seen.has('working'))
    await wait(() => settled(sid))
    expect(loose(sid)!.done).toBe(false)
  })

  it('J9 merging the pull request makes the thread done, wherever the merge happens', async () => {
    const { fake, s, wait, loose, settled } = await open()
    const sid = s.start('Open a PR for the slow query', { open: false })
    await wait(() => settled(sid) && loose(sid)?.mark === 'ready')
    const pr = loose(sid)!.results.find((r) => r.type === 'pr')!

    fake.agent.pull(pr.id, 'merged')
    await wait(() => !loose(sid))
    expect(s.list().threads).toEqual([])
    expect(s.list().earlier).toBe(1)
    const kept = s.thread(sid)
    if (kept) expect(kept).toMatchObject({ done: true, outcome: 'done' })
  })

  it('J11 the track’s agent suggests done: a ring on the track; Done closes it', async () => {
    const { s, wait, track, startTrack } = await open()
    const { tid, threads } = await startTrack()
    expect(track(tid)!.mark).toBeNull()

    for (const sid of threads) s.done(sid)
    await wait(() => track(tid)?.proposals.length)
    const k = track(tid)!
    expect(k.proposals.map((p) => p.type)).toEqual(['done'])
    expect(k.mark).toBe('ready')
    expect(k.threads).toEqual([])

    s.accept(k.proposals[0].id)
    await wait(() => !track(tid) && !s.get().pending.length)
    expect(s.list().tracks).toEqual([])
    expect(s.list().earlierTracks.map((x) => x.id)).toEqual([tid])
    expect(s.list().earlierTracks[0]).toMatchObject({ done: true, mark: null })
    expect(s.list().earlier).toBe(1)
  })

  it('J11 Keep open: the ring clears and the track stays', async () => {
    const { s, wait, track, startTrack } = await open()
    const { tid, threads } = await startTrack()
    for (const sid of threads) s.done(sid)
    await wait(() => track(tid)?.mark === 'ready')
    const p = track(tid)!.proposals[0]

    // What the Keep open button does.
    s.trackKeep(tid, true)
    s.dismissProposal(p.id)
    expect(track(tid)).toMatchObject({ mark: null, keep: true })
    await wait(() => !s.get().pending.length)
    await sleep(5)
    expect(track(tid)).toMatchObject({ mark: null, keep: true, done: false, proposals: [] })
    expect(s.list().earlierTracks).toEqual([])
  })

  it('J13 a done track reopens on a message in one of its threads', async () => {
    const { s, wait, track, startTrack } = await open()
    const { tid, threads } = await startTrack()
    s.openTrack(tid)
    s.trackDone(tid)
    // At once, and the person lands on the start box (A11).
    expect(s.list().tracks).toEqual([])
    expect(s.get().loc).toMatchObject({ track: null, start: true })
    await wait(() => !s.get().pending.length && s.list().earlierTracks.length)
    expect(s.list().earlierTracks[0]).toMatchObject({ id: tid, done: true })

    s.send(threads[0], 'One more thing: the totals are off')
    await wait(() => track(tid))
    expect(track(tid)!.done).toBe(false)
    expect(s.list().earlierTracks).toEqual([])
    await wait(() => track(tid)!.threads.some((t) => t.id === threads[0]))
    expect(s.thread(threads[0])!.done).toBe(false)
  })

  it('offline: an action shows at once and is confirmed after the connection returns', async () => {
    const { fake, s, wait, loose, settled } = await open()
    const sid = s.start('Why is the build slow', { open: true })
    await wait(() => settled(sid))

    // The client tries again 1 to 5 seconds after the connection drops: from
    // here the clock is moved, not waited for.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tick = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms)
      await new Promise<void>((resolve) => realTimeout(resolve, 0))
    }
    fake.setOffline(true)
    for (let i = 0; i < 50 && s.get().status !== 'offline'; i++) await tick(1)
    expect(s.get().status).toBe('offline')

    s.rename(sid, 'Slow builds')
    expect(loose(sid)!.title).toBe('Slow builds')
    expect(s.get().pending).toHaveLength(1)
    await tick(20)
    expect(loose(sid)!.title).toBe('Slow builds')
    expect(s.get().pending).toHaveLength(1)
    expect(fake.row('session', sid)).toMatchObject({ title: 'Why is the build slow' })

    fake.setOffline(false)
    for (let i = 0; i < 100 && (s.get().pending.length || s.get().status !== 'online'); i++) await tick(250)
    vi.useRealTimers()

    expect(s.get().status).toBe('online')
    expect(s.get().pending).toEqual([])
    expect(fake.row('session', sid)).toMatchObject({ title: 'Slow builds' })
    expect(loose(sid)!.title).toBe('Slow builds')
    expect(s.get().toasts.filter((t) => t.tone === 'error')).toEqual([])
  })

  it('a refused write rolls back and lands in failures', async () => {
    const { s, wait, loose, settled, failures } = await open()
    const sid = s.start('Why is the build slow', { open: false })
    await wait(() => settled(sid))

    s.place(sid, 'trk_nosuchtrack')
    // Shown as asked, until the server says no.
    expect(loose(sid)).toBeUndefined()
    expect(s.thread(sid)!.trackId).toBe('trk_nosuchtrack')

    await wait(() => failures.length)
    expect(failures[0].entry).toMatchObject({ kind: 'mutation', name: 'thread.place' })
    expect(s.get().pending).toEqual([])
    expect(loose(sid)).toBeDefined()
    expect(s.thread(sid)!.trackId).toBeNull()
    const said = s.get().toasts.filter((t) => t.tone === 'error')
    expect(said).toHaveLength(1)
    expect(said[0].text).toMatch(/^Could not move it: /)
  })

  it.todo('J13 a done track reopens on a message to the track itself (T12): the fake reopens a track only on a reply in one of its done threads')
  it.todo('J3.3 the wrapped track opens with the user’s message and its agent starts further threads: the fake’s track agent only does this for a track made from the start box')
  it.todo('J4 the agent does not wrap the same thread again after Undo (R30, R34): the fake’s script proposes on every message with "track"')
  it.todo('J6 a one-line question to the start box becomes a thread: covered by J1, there is no second action')
  it.todo('J8 clicking the notification opens the thread at the block: Host.onOpen is the host’s to call; at the block is the UI’s')
  it.todo('J10 changing course from the track (G4): the fake’s track agent passes a message on but stops no thread and rewrites no stand')
  it.todo('J12 a standing track is not suggested again after Keep open: the fake’s clock cannot make a track "quiet for weeks"')
})
