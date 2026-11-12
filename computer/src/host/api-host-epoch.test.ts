// Review r1 P1-1/P1-2 (recovery-fix): a gateway outage longer than the DO's 60 s
// grace during a running turn. The DO recovers the session under epoch + 1 at
// ack + 1…; the host must end up with the DO's events verbatim, no seq collision,
// and nothing of the old epoch past the ack reaching the DO.

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSessionJournalDir, Journal, journalPath, readJournalFile } from '../api/journal.js';
import type { ApiClient } from '../api/socket.js';
import type { SubscribeOptions } from '../api/writer.js';
import { createTelemetry } from '../telemetry/emitter.js';
import type { ApiActor, GatewayToHost, HostToGateway, JournalEvent, SessionSpec } from '../protocol.js';
import { apiHost, type ApiHostDeps, type WireLinkLike } from './api-host.js';
import { apiMeter } from './api-meter.js';
import { scanJournals } from './session-writer.js';

const S = 'cs_0000000000000002';
const actor: ApiActor = { id: 'usr_1', name: 'Ada', via: 'api', client: null };
const owner = { userId: 'usr_1', name: 'Ada', email: 'ada@example.com', dir: 'user-usr_1', gitName: 'Ada', gitEmail: 'ada@example.com' };
const spec: SessionSpec = { key: S, kind: 'api', sessionId: S, owner, title: 'hi', mode: 'default' } as SessionSpec;
const welcome = { t: 'welcome', protocol: 4, credentials: {}, people: [{ ...owner, admin: true }] } as unknown as GatewayToHost;
const until = async (f: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !f(); ) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const dirs: string[] = [];
afterEach(() => {
  // Retried: a writer a test stopped may still be closing a file in it (seen under load: ENOTEMPTY).
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** The SessionLog DO as far as the mirror sees it: stores batches of its epoch, gapless, acks them. */
function fakeDo() {
  const log: JournalEvent[] = [];
  let epoch = 1;
  const stale: number[] = [];
  return {
    log,
    stale,
    get epoch() {
      return epoch;
    },
    store(m: Extract<HostToGateway, { t: 'journal' }>) {
      if (m.epoch !== epoch) return void stale.push(...m.events.map((e) => e.seq));
      for (const e of m.events) if (e.seq === (log.at(-1)?.seq ?? 0) + 1) log.push(e);
    },
    /** recover(): epoch + 1, the runtime_lost events at ack + 1… (blue's SessionLog.recover). */
    recover(ack: number) {
      log.splice(ack);
      epoch++;
      const startSeq = ack + 1;
      for (const type of ['tool.failed', 'turn.failed', 'runtime.suspended', 'session.status_changed'])
        log.push({
          id: `ev_do${log.length + 1}`,
          seq: log.length + 1,
          createdAt: '2026-10-26T00:00:00.000Z',
          sessionId: S,
          turnId: 'tn_1',
          type,
          actor: null,
          data: { by: 'do' },
        });
      return { t: 'epoch', sessionId: S, epoch, startSeq, lastSeq: log.length, tail: log.slice(startSeq - 1) } as const;
    },
  };
}

/** A runner holding the journal's lock at epoch 1, behind a fake socket. */
async function fakeRunner(file: string) {
  const j = await Journal.open(file, { sessionId: S, epoch: 1, lastSeq: 0 });
  const subs = new Set<SubscribeOptions>();
  return {
    j,
    append(type: string) {
      const e = j.append(type, {}, { turnId: 'tn_1', actor });
      for (const s of subs) s.onEvent(e);
      return e;
    },
    dial: async (): Promise<ApiClient> => {
      let h: SubscribeOptions | undefined;
      return {
        call: async () => ({ result: {} }),
        subscribe: async (o) => {
          h = o;
          subs.add(o);
          queueMicrotask(() => {
            for (const e of j.read(o.after ?? 0)) o.onEvent(e);
          });
          return { attached: { session: {}, after: o.after ?? 0, lastSeq: j.lastSeq, epoch: j.epoch } as never };
        },
        ack() {},
        close: () => void (h && subs.delete(h)),
        closed: new Promise(() => {}),
      };
    },
    gone() {
      for (const s of [...subs]) s.onDetached('moved');
      subs.clear();
    },
  };
}

describe('epoch adoption (recovery-fix)', () => {
  it('a > 60 s outage during a running turn: the host takes the DO events verbatim, continues at L + 1, and old-epoch events past the ack never reach the DO', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'apiepoch-'));
    dirs.push(root);
    const dataDir = path.join(root, 'data');
    const file = journalPath(dataDir, S);
    ensureSessionJournalDir(dataDir, S);
    mkdirSync(path.join(root, 'runners'));
    const runner = await fakeRunner(file);
    const dO = fakeDo();
    let linked = true;
    const sent: HostToGateway[] = [];
    const retired: string[] = [];
    const a = apiHost({
      dataDir,
      stateDir: path.join(root, 'state'),
      runDir: path.join(root, 'run'),
      runnersDir: path.join(root, 'runners'),
      send: (m) => {
        if (!linked) return false;
        sent.push(m);
        if (m.t === 'journal') dO.store(m);
        return true;
      },
      start: async () => 'busy',
      dial: runner.dial,
      scan: async () => [],
      flushMs: 1,
      retire: async (id) => {
        retired.push(id);
        runner.gone();
        await runner.j.release();
        a.down(id);
      },
    });
    a.onGateway(welcome);
    a.onGateway({ t: 'start', id: 's1', session: spec, epoch: 1, lastSeq: 0 });
    await a.mint(spec, 'r1');
    a.up('r1');
    // The turn runs: the DO gets 1..5 and acks 3 before the link drops.
    for (const type of ['message.received', 'turn.started', 'tool.started', 'text.completed', 'tool.started']) runner.append(type);
    await until(() => dO.log.length === 5);
    a.onGateway({ t: 'journal-ack', sessionId: S, epoch: 1, seq: 3 });

    // Outage (> 60 s at the DO): the turn goes on locally; the DO recovers under epoch 2 from its ack.
    linked = false;
    runner.append('tool.completed');
    runner.append('turn.completed');
    const frame = dO.recover(3);
    expect(frame).toMatchObject({ epoch: 2, startSeq: 4, lastSeq: 7 });

    // Reconnect: the hello says which epoch the host's journal is at, the mirror resends what was unacked (stale at the DO).
    linked = true;
    expect(a.journals()).toEqual([{ sessionId: S, epoch: 1, startSeq: 1, lastSeq: 7 }]);
    a.onGateway(welcome);
    await until(() => dO.stale.length > 0);
    // A frame ahead of the host never moves the epoch by itself.
    a.onGateway({ t: 'api', id: 'g1', sessionId: S, method: 'sessions.get', params: {}, actor, member: 'usr_1', epoch: 2, lastSeq: 7 });
    expect(readJournalFile(file, 0).epoch).toBe(1);

    const before = sent.length;
    a.onGateway(frame);
    await until(() => retired.length === 1 && readJournalFile(file, 0).epoch === 2);
    await new Promise((r) => setTimeout(r, 20));

    // The local journal equals the DO's at every seq ≤ L, byte for byte in content.
    const local = readJournalFile(file, 0).events;
    expect(local).toEqual(dO.log);
    expect(a.journals()).toEqual([{ sessionId: S, epoch: 2, startSeq: 4, lastSeq: 7 }]);
    // Nothing from the old epoch went up after the adoption.
    expect(sent.slice(before).filter((m) => m.t === 'journal' && m.epoch === 1)).toEqual([]);

    // The next write (the host's own writer now) is L + 1 under epoch 2, and the DO stores it.
    a.onGateway({ t: 'api', id: 'w1', sessionId: S, method: 'sessions.update', params: { title: 'after' }, actor, member: 'usr_1' });
    await until(() => sent.some((m) => m.t === 'api-result' && m.id === 'w1'));
    const next = sent.slice(before).find((m): m is Extract<HostToGateway, { t: 'journal' }> => m.t === 'journal');
    expect(next?.epoch).toBe(2);
    expect(next?.events[0].seq).toBe(8);
    // Read your writes on a writer opened by this very call (review r1 P2-4): the batch leaves before the result.
    expect(sent.indexOf(next!)).toBeLessThan(sent.findIndex((m) => m.t === 'api-result' && m.id === 'w1'));
    expect(dO.log.at(-1)?.seq).toBeGreaterThanOrEqual(8);
    expect(readJournalFile(file, 0).events.slice(0, 7)).toEqual(dO.log.slice(0, 7));
    // A repeat of the frame is a no-op.
    a.onGateway(frame);
    await new Promise((r) => setTimeout(r, 20));
    expect(retired).toEqual(['r1']);
    await a.stop();
  });

  /** A host whose session S has a runner at epoch 1 that wrote 1..5 (the DO acked 3), then lost the gateway. */
  async function outage(o: Partial<ApiHostDeps> = {}) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'apiepoch-'));
    dirs.push(root);
    const dataDir = path.join(root, 'data');
    const file = journalPath(dataDir, S);
    ensureSessionJournalDir(dataDir, S);
    mkdirSync(path.join(root, 'runners'));
    const runner = await fakeRunner(file);
    const dO = fakeDo();
    const sent: HostToGateway[] = [];
    const moves: string[] = [];
    const clock = { now: 1_000_000 };
    const wire: WireLinkLike = { setKey() {}, setAccess() {}, setAdmins() {}, revoked() {}, moved: (s) => void moves.push(s), close: async () => {} };
    const a = apiHost({
      dataDir,
      stateDir: path.join(root, 'state'),
      runDir: path.join(root, 'run'),
      runnersDir: path.join(root, 'runners'),
      send: (m) => (sent.push(m), m.t === 'journal' && dO.store(m), true),
      start: async () => 'busy',
      dial: runner.dial,
      scan: async () => [],
      flushMs: 1,
      wire: async () => wire as never,
      now: () => clock.now,
      lockWaitMs: 50,
      ...o,
    });
    a.onGateway(welcome);
    a.onGateway({ t: 'start', id: 's1', session: spec, epoch: 1, lastSeq: 0 });
    await a.mint(spec, 'r1');
    a.up('r1');
    for (const type of ['message.received', 'turn.started', 'tool.started', 'text.completed', 'tool.started']) runner.append(type);
    await until(() => dO.log.length === 5);
    a.onGateway({ t: 'journal-ack', sessionId: S, epoch: 1, seq: 3 });
    await settle();
    moves.length = 0; // the runner's start
    return { a, runner, dO, sent, moves, clock, file, dataDir };
  }
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it('a runner that will not let go is retired once: resends back off, nothing is said moved, and the adoption runs once it goes (review r2 P2-3, P2-7)', async () => {
    const retired: string[] = [];
    const t = await outage({ retire: async (id) => void retired.push(id) }); // never exits, never releases
    const frame = t.dO.recover(3);
    t.a.onGateway(frame);
    await until(() => retired.length === 1);
    await settle();
    expect(readJournalFile(t.file, 0).epoch).toBe(1); // the lock is held: not adopted
    expect(t.moves).toEqual([]);
    // The gateway's resends (every 5 s): within the backoff they do nothing; after it, the open is retried, never the retire.
    t.a.onGateway(frame);
    await settle();
    t.clock.now += 60_000;
    t.a.onGateway(frame);
    await settle();
    expect(retired).toEqual(['r1']);
    expect(t.moves).toEqual([]);
    expect(readJournalFile(t.file, 0).epoch).toBe(1);
    // The runner finally goes (its own deadline): the next resend adopts at once, and only now the relay hears `moved`.
    t.runner.gone();
    await t.runner.j.release();
    t.a.down('r1');
    const movesBefore = t.moves.length;
    t.a.onGateway(frame);
    await until(() => readJournalFile(t.file, 0).epoch === 2);
    await settle();
    expect(readJournalFile(t.file, 0).events).toEqual(t.dO.log);
    expect(t.moves.length).toBe(movesBefore + 1);
    expect(retired).toEqual(['r1']);
    await t.a.stop();
  });

  /** A retire that works: the runner lets go of its lock and its socket closes. */
  const cooperative = (t: { runner: Awaited<ReturnType<typeof fakeRunner>>; a: ReturnType<typeof apiHost> }) => async (id: string) => {
    t.runner.gone();
    await t.runner.j.release();
    t.a.down(id);
  };

  it('a host whose adoption dies mid-tail reports the old epoch at hello, and the resent frame adopts (review r2 P1-2, P2-7)', async () => {
    const ref: { t?: Awaited<ReturnType<typeof outage>> } = {};
    // What the host's meter hears of adoptions, and nothing else of it: an attempt is over when it is told.
    const attempts: boolean[] = [];
    const real = apiMeter(createTelemetry({ service: 'host', version: 't', region: 'local', send: () => {} }), { journals: path.join(os.tmpdir(), 'apiepoch-none'), intervalMs: 3_600_000 });
    const meter = { ...real, adopted: (x: Parameters<typeof real.adopted>[0]) => (attempts.push(x.ok), real.adopted(x)) };
    const t = (ref.t = await outage({ retire: (id) => cooperative(ref.t!)(id), meter }));
    const good = t.dO.recover(3);
    // The write of the tail's second event throws (the crash, a full disk) after its first is on file.
    const torn = { ...good, tail: [good.tail[0], { ...good.tail[1], data: { bad: 1n } }, ...good.tail.slice(2)] } as never;
    t.a.onGateway(torn);
    await until(() => t.moves.length > 0); // the runner's own `down`
    // The attempt has failed, and its backoff is counted from before the clock moves below: on a slow machine it
    // was still running after a fixed wait, the backoff then started at the later time and the resent frame was dropped.
    await until(() => attempts.length === 1);
    expect(attempts).toEqual([false]);
    await settle();
    const moves = t.moves.length;
    // The hello a restarted host would send: still epoch 1, so the gateway sends `epoch` again.
    expect(t.a.journals()).toEqual([{ sessionId: S, epoch: 1, startSeq: 1, lastSeq: 4 }]);
    t.clock.now += 60_000;
    t.a.onGateway(good);
    await until(() => attempts.length === 2); // over, the relay told: the epoch on file comes some steps before that
    expect(attempts).toEqual([false, true]);
    expect(readJournalFile(t.file, 0).events).toEqual(t.dO.log);
    expect(t.a.journals()).toEqual([{ sessionId: S, epoch: 2, startSeq: 4, lastSeq: 7 }]);
    expect(t.moves.length).toBe(moves + 1);
    await t.a.stop();
    real.stop();
  });

  it('a journal whose epoch line is ahead of its events is left alone by the boot scan and repaired by the same-epoch frame (review r2 P1-2, P2-7)', async () => {
    const ref: { t?: Awaited<ReturnType<typeof outage>> } = {};
    const t = (ref.t = await outage({ retire: (id) => cooperative(ref.t!)(id) }));
    const frame = t.dO.recover(3);
    await cooperative(t)('r1');
    // A torn adoption: cut at 4 and the commit record on file (through 7), none of the DO's events.
    const kept = readFileSync(t.file, 'utf8').split('\n').filter((l) => l && !(JSON.parse(l).seq >= 4));
    rmSync(t.file);
    appendFileSync(t.file, `${kept.join('\n')}\n${JSON.stringify({ k: 'epoch', sessionId: S, epoch: 2, startSeq: 4, through: 7, at: 0 })}\n`);
    const scanned = await scanJournals(path.join(t.dataDir, 'journals'));
    expect(scanned).toMatchObject([{ sessionId: S, epoch: 2, skipped: 'torn', lastSeq: 3 }]);
    expect(readJournalFile(t.file, 0).lastSeq).toBe(3); // nothing synthesized
    expect(t.a.journals()).toEqual([{ sessionId: S, epoch: 2, startSeq: 4, lastSeq: 3 }]);
    // The gateway sees lastSeq 3 < startSeq - 1 + tail: it resends `epoch` at the same epoch, which fills the gap.
    t.a.onGateway(frame);
    await until(() => readJournalFile(t.file, 0).lastSeq === 7);
    expect(readJournalFile(t.file, 0).events).toEqual(t.dO.log);
    await t.a.stop();
  });

  it('a deliver and an api call right behind an epoch frame wait for the slow adoption, then run under the new epoch with nothing lost (review r2 P1-1)', async () => {
    const ref: { t?: Awaited<ReturnType<typeof outage>> } = {};
    const t = (ref.t = await outage({ retire: async (id) => (await settle(), await settle(), cooperative(ref.t!)(id)) }));
    const frame = t.dO.recover(3);
    t.a.onGateway(frame);
    const msg = { userId: 'U1', text: 'next', ts: '2' };
    const delivered = t.a.onGateway({ t: 'deliver', id: 'd2', session: spec, msg, epoch: 2, lastSeq: 7 });
    const update = t.a.onGateway({ t: 'api', id: 'w2', sessionId: S, method: 'sessions.update', params: { title: 'held' }, actor, member: 'usr_1', epoch: 2, lastSeq: 7 });
    expect(delivered).toBeInstanceOf(Promise);
    expect(update).toBeInstanceOf(Promise);
    const order: string[] = [];
    const seen = Promise.all([
      (delivered as Promise<boolean>).then((own) => (order.push(`deliver@${readJournalFile(t.file, 0).epoch}`), own)),
      (update as Promise<boolean>).then((own) => (order.push(`api@${readJournalFile(t.file, 0).epoch}`), own)),
    ]);
    await settle();
    expect(order).toEqual([]); // the adoption is still retiring the runner: neither ran under epoch 1
    expect(t.sent.some((m) => m.t === 'api-result' && m.id === 'w2')).toBe(false);
    expect(await seen).toEqual([false, true]); // the deliver goes on to main, the api call was the API's
    expect(order).toEqual(['deliver@2', 'api@2']);
    await until(() => t.sent.some((m) => m.t === 'api-result' && m.id === 'w2'));
    const local = readJournalFile(t.file, 0).events;
    expect(local.slice(0, 7)).toEqual(t.dO.log.slice(0, 7));
    expect(local.at(-1)).toMatchObject({ seq: 8, type: 'session.updated' });
    await until(() => t.dO.log.length === 8);
    expect(t.dO.log).toEqual(local);
    expect(t.sent.filter((m) => m.t === 'journal' && m.events.some((e) => e.seq === 8)).map((m) => (m as { epoch: number }).epoch)).toEqual([2]);
    // The turn main starts for the deliver gets a runner at the new epoch, after the DO's events and the held write.
    const api = await t.a.mint(spec, 'r2');
    expect(api).toMatchObject({ epoch: 2 });
    expect(api!.lastSeq).toBeGreaterThanOrEqual(7); // the DO's lastSeq as last framed; the journal itself is at 8
    await t.a.stop();
  });

  it('a frame held behind an adoption that fails stays held through the backoff, and runs once the adoption commits (review r2 P1-1)', async () => {
    const t = await outage({ retire: async () => {} }); // never lets go
    const frame = t.dO.recover(3);
    t.a.onGateway(frame);
    let done = false;
    const delivered = t.a.onGateway({ t: 'deliver', id: 'd3', session: spec, msg: { userId: 'U1', text: 'x', ts: '3' }, epoch: 2, lastSeq: 7 });
    void (delivered as Promise<boolean>).then(() => (done = true));
    await settle();
    await settle();
    expect(readJournalFile(t.file, 0).epoch).toBe(1);
    expect(done).toBe(false);
    t.a.onGateway(frame); // a resend inside the backoff
    await settle();
    expect(done).toBe(false);
    t.runner.gone();
    await t.runner.j.release();
    t.a.down('r1'); // no resend: down() reruns the kept frame (review r3 P1-1)
    await until(() => done);
    expect(readJournalFile(t.file, 0).epoch).toBe(2);
    await t.a.stop();
  });

  it('a frame held past the deadline with no epoch frame coming asks the gateway with an empty batch at the old epoch, and runs once it adopts (review r3 P1-1)', async () => {
    const ref: { t?: Awaited<ReturnType<typeof outage>> } = {};
    const t = (ref.t = await outage({ holdAskMs: 20, retire: (id) => cooperative(ref.t!)(id) }));
    const frame = t.dO.recover(3); // the DO moved to epoch 2, and the frame was lost
    const delivered = t.a.onGateway({ t: 'deliver', id: 'd4', session: spec, msg: { userId: 'U1', text: 'x', ts: '4' }, epoch: 2, lastSeq: 7 });
    const asked = () => t.sent.filter((m) => m.t === 'journal' && m.epoch === 1 && m.events.length === 0).length;
    await until(() => asked() >= 2); // asked again every deadline while held
    t.a.onGateway(frame); // the gateway's rule 3 answer
    expect(await delivered).toBe(false);
    expect(readJournalFile(t.file, 0).epoch).toBe(2);
    const n = asked();
    await settle();
    expect(asked()).toBe(n); // nothing held: no more asking
    await t.a.stop();
  });

  it('a held write retried with the same idempotency key runs once; the retry is answered from the stored result (review r3 P2-2)', async () => {
    const ref: { t?: Awaited<ReturnType<typeof outage>> } = {};
    const t = (ref.t = await outage({ retire: async (id) => (await settle(), cooperative(ref.t!)(id)) }));
    t.a.onGateway(t.dO.recover(3));
    const call = (id: string) =>
      t.a.onGateway({ t: 'api', id, sessionId: S, method: 'sessions.update', params: { title: 'once' }, actor, member: 'usr_1', idempotencyKey: 'k1', epoch: 2, lastSeq: 7 });
    expect(call('w5')).toBeInstanceOf(Promise);
    expect(call('w6')).toBeInstanceOf(Promise); // the client's retry after the DO's 503
    await until(() => ['w5', 'w6'].every((id) => t.sent.some((m) => m.t === 'api-result' && m.id === id)));
    const results = ['w5', 'w6'].map((id) => t.sent.find((m): m is Extract<HostToGateway, { t: 'api-result' }> => m.t === 'api-result' && m.id === id));
    expect(results[0]?.error).toBeUndefined();
    expect(results[1]?.result).toEqual(results[0]?.result);
    expect(readJournalFile(t.file, 0).events.filter((e) => e.type === 'session.updated')).toHaveLength(1);
    await t.a.stop();
  });

  it('an adoption into a new file torn before its epoch line holds frames for the session and is adopted, not taken as already there (review r3 P2-4)', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'apiepoch-'));
    dirs.push(root);
    const dataDir = path.join(root, 'data');
    const file = journalPath(dataDir, S);
    ensureSessionJournalDir(dataDir, S);
    const dO = fakeDo();
    for (const type of ['message.received', 'turn.started', 'tool.started']) dO.log.push({ id: `ev_${type}`, seq: dO.log.length + 1, createdAt: '2026-10-26T00:00:00.000Z', sessionId: S, turnId: 'tn_1', type, actor: null, data: {} });
    const frame = dO.recover(3);
    // The whole tail landed, then the crash: events, no epoch line.
    appendFileSync(file, frame.tail.map((e) => `${JSON.stringify(e)}\n`).join(''));
    const sent: HostToGateway[] = [];
    const a = apiHost({ dataDir, stateDir: path.join(root, 'state'), runDir: path.join(root, 'run'), runnersDir: root, send: (m) => (sent.push(m), true), start: async () => 'idle', scan: async () => [], flushMs: 1 });
    a.onGateway(welcome);
    expect(a.journals()).toEqual([{ sessionId: S, epoch: 0, startSeq: 0, lastSeq: 7 }]);
    const delivered = a.onGateway({ t: 'deliver', id: 'd7', session: spec, msg: { userId: 'U1', text: 'x', ts: '7' }, epoch: 2, lastSeq: 7 });
    expect(delivered).toBeInstanceOf(Promise);
    a.onGateway(frame);
    expect(await delivered).toBe(false);
    expect(readJournalFile(file, 0)).toMatchObject({ epoch: 2, startSeq: 4, lastSeq: 7 });
    expect(readJournalFile(file, 0).events).toEqual(frame.tail);
    await a.stop();
  });

  it('the hello reads a journal again only once it changed on disk (084 perf fix 6)', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'apiepoch-'));
    dirs.push(root);
    const dataDir = path.join(root, 'data');
    const file = journalPath(dataDir, S);
    ensureSessionJournalDir(dataDir, S);
    const ev = (seq: number) => `${JSON.stringify({ id: `ev_${seq}`, seq, createdAt: '2026-10-26T00:00:00.000Z', sessionId: S, turnId: null, type: 'runtime.suspended', actor: null, data: {} })}\n`;
    appendFileSync(file, `${JSON.stringify({ k: 'epoch', sessionId: S, epoch: 1, startSeq: 1, at: 0 })}\n${ev(1)}${ev(2)}`);
    const a = apiHost({ dataDir, stateDir: path.join(root, 'state'), runDir: path.join(root, 'run'), runnersDir: root, send: () => true, start: async () => 'idle', scan: async () => [], flushMs: 1 });
    utimesSync(file, 1e9, 1e9);
    expect(a.journals()).toEqual([{ sessionId: S, epoch: 1, startSeq: 1, lastSeq: 2 }]);
    // Same inode, size and mtime: not read (a file changed behind them all, which no writer does, shows the old report).
    writeFileSync(file, readFileSync(file, 'utf8').replace('"seq":2', '"seq":9'));
    utimesSync(file, 1e9, 1e9);
    expect(a.journals()).toEqual([{ sessionId: S, epoch: 1, startSeq: 1, lastSeq: 2 }]);
    appendFileSync(file, ev(10));
    expect(a.journals()).toEqual([{ sessionId: S, epoch: 1, startSeq: 1, lastSeq: 10 }]);
    rmSync(file);
    expect(a.journals()).toEqual([]);
    await a.stop();
  });
});
