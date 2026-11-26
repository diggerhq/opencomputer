import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JournalDelta, JournalEvent } from '../protocol.js';
import { mintId } from '../session-ids.js';
import { dispatch, type WriteHandlers } from './read-methods.js';
import { dialApi, MAX_LINE, serveApi } from './socket.js';
import { ANN, ANN_CTX, openLog, tempSession, turn } from './testing.js';
import type { DetachReason, Writer } from './writer.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const TOKEN = 'secret-token';

/** A SessionLog served on a socket; `turns.send` records a queued turn (two events). */
async function served(extra: WriteHandlers = {}) {
  const t = tempSession();
  const log = await openLog(t.file, t.sessionId);
  const writer: Writer = {
    sessionId: t.sessionId,
    call: dispatch(log, {
      'turns.send': (p, ctx) => {
        const turnId = mintId('tn');
        log.append('message.received', { input: p.input, ifBusy: 'queue', delivery: 'queued', interruptedTurnIds: [], declinedAskIds: [] }, { turnId, actor: ctx.actor });
        const e = log.append('turn.queued', { position: 1, trigger: 'message', subagentId: null }, { turnId, actor: ctx.actor });
        return { result: { turn: log.fold.turn(turnId), delivery: 'queued', duplicate: false, seq: e.seq } };
      },
      ...extra,
    }),
    subscribe: (o) => log.subscribe(o),
  };
  const sock = path.join(t.dir, 'x.api.sock');
  const server = await serveApi(sock, writer, { token: TOKEN });
  cleanups.push(t.cleanup, () => log.release(), () => server.close());
  return { log, sid: t.sessionId, sock, server };
}

function frames() {
  const events: JournalEvent[] = [];
  const deltas: JournalDelta[] = [];
  const detached: DetachReason[] = [];
  return {
    events,
    deltas,
    detached,
    opts: (o: { after?: number; deltas?: boolean } = {}) => ({
      after: o.after,
      deltas: o.deltas ?? true,
      onEvent: (e: JournalEvent) => {
        events.push(e);
      },
      onDelta: (d: JournalDelta) => deltas.push(d),
      onDetached: (r: DetachReason) => detached.push(r),
    }),
  };
}

const until = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('serveApi / dialApi', () => {
  it('creates the socket 0660 and answers calls after hello', async () => {
    const { sid, sock, server } = await served();
    expect(fs.statSync(sock).mode & 0o777).toBe(0o660);
    const c = await dialApi(sock, TOKEN);
    cleanups.push(() => c.close());
    const out = await c.call('sessions.get', { sessionId: sid }, ANN_CTX);
    expect(out.result).toMatchObject({ session: { id: sid } });
    expect((await c.call('sessions.get', { sessionId: mintId('cs') }, ANN_CTX)).error?.code).toBe('session_not_found');
    expect(server.connections()).toBe(1);
  });

  it('closes a connection with a wrong token or another first frame', async () => {
    const { sid, sock } = await served();
    const bad = await dialApi(sock, 'wrong');
    const out = await bad.call('sessions.get', { sessionId: sid }, ANN_CTX);
    expect(out.error).toMatchObject({ code: 'unavailable', status: 503, retryable: true });
    await bad.closed;
    const raw = net.connect(sock);
    raw.write(`${JSON.stringify({ t: 'call', id: '1', method: 'sessions.get', params: { sessionId: sid }, actor: ANN, member: 'usr_ann' })}\n`);
    await new Promise((r) => raw.on('close', r));
  });

  it('closes a connection on a line over 1 MiB', async () => {
    const { sock } = await served();
    const raw = net.connect(sock);
    raw.on('error', () => {});
    raw.write(`${JSON.stringify({ t: 'hello', token: TOKEN })}\n`);
    raw.write('x'.repeat(MAX_LINE + 10));
    await new Promise((r) => raw.on('close', r));
  });

  it('subscribe: the attached result comes before events; replay then live; one per connection', async () => {
    const { log, sid, sock } = await served();
    turn(log);
    const c = await dialApi(sock, TOKEN);
    cleanups.push(() => c.close());
    const f = frames();
    const att = await c.subscribe(f.opts({ after: 0 }));
    expect('attached' in att && att.attached).toMatchObject({ after: 0, lastSeq: 4, epoch: 1, session: { id: sid } });
    await until(() => f.events.length === 4);
    turn(log);
    await until(() => f.events.length === 8);
    expect(f.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const twice = await c.subscribe(frames().opts());
    expect('error' in twice && twice.error).toMatchObject({ code: 'invalid_request', field: 'subscribe' });
  });

  it('on the wire: attached before replayed events, and a write\'s result before the events it caused', async () => {
    const { log, sid, sock } = await served();
    turn(log);
    const raw = net.connect(sock);
    cleanups.push(() => raw.destroy());
    const seen: string[] = [];
    let buf = '';
    raw.on('data', (d) => {
      buf += d.toString();
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        seen.push(m.t === 'event' ? `event:${m.event.seq}` : `${m.t}:${m.id}`);
      }
    });
    const send = (m: unknown) => raw.write(`${JSON.stringify(m)}\n`);
    send({ t: 'hello', token: TOKEN });
    send({ t: 'subscribe', id: 's', after: 2, deltas: false });
    await until(() => seen.length === 3);
    send({ t: 'call', id: 'w', method: 'turns.send', params: { sessionId: sid, input: 'hi' }, actor: ANN, member: 'usr_ann' });
    await until(() => seen.length === 6);
    expect(seen).toEqual(['result:s', 'event:3', 'event:4', 'result:w', 'event:5', 'event:6']);
    // A write sent while replay is due holds the replay too: its result first, then everything in order.
    send({ t: 'call', id: 'w2', method: 'turns.send', params: { sessionId: sid, input: 'again' }, actor: ANN, member: 'usr_ann' });
    await until(() => seen.length === 9);
    expect(seen.slice(6)).toEqual(['result:w2', 'event:7', 'event:8']);
  });

  it('a slow write holds only events: deltas keep streaming until an event is due, then wait behind it', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { log, sid, sock } = await served({ 'sessions.suspend': async () => (await gate, { result: { ok: true } }) });
    const raw = net.connect(sock);
    cleanups.push(() => raw.destroy());
    const seen: string[] = [];
    let buf = '';
    raw.on('data', (d) => {
      buf += d.toString();
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        seen.push(m.t === 'event' ? `event:${m.event.seq}` : m.t === 'delta' ? `delta:${m.delta.data.text}` : `${m.t}:${m.id}`);
      }
    });
    const send = (m: unknown) => raw.write(`${JSON.stringify(m)}\n`);
    send({ t: 'hello', token: TOKEN });
    send({ t: 'subscribe', id: 's', deltas: true });
    await until(() => seen.length === 1);
    send({ t: 'call', id: 'w', method: 'sessions.suspend', params: { sessionId: sid }, actor: ANN, member: 'usr_ann' });
    await new Promise((r) => setTimeout(r, 20));
    const t = mintId('tn');
    log.delta({ type: 'message.delta', turnId: t, data: { blockId: 'b1', parentCallId: null, text: 'a' } });
    await until(() => seen.includes('delta:a'));
    const e = log.append('turn.queued', { position: 1, trigger: 'message', subagentId: null }, { turnId: t, actor: ANN });
    log.delta({ type: 'message.delta', turnId: t, data: { blockId: 'b1', parentCallId: null, text: 'b' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual(['result:s', 'delta:a']);
    release();
    await until(() => seen.length === 5);
    expect(seen.slice(2)).toEqual(['result:w', `event:${e.seq}`, 'delta:b']);
  });

  it('refuses a cursor ahead, forwards deltas and detached', async () => {
    const { log, sock } = await served();
    const c = await dialApi(sock, TOKEN);
    cleanups.push(() => c.close());
    const f = frames();
    const ahead = await c.subscribe(f.opts({ after: 50 }));
    expect('error' in ahead && ahead.error.code).toBe('cursor_ahead');
    await c.subscribe(f.opts());
    const t = mintId('tn');
    log.delta({ type: 'message.delta', turnId: t, data: { blockId: 'b1', parentCallId: null, text: 'hey' } });
    await until(() => f.deltas.length === 1);
    expect(f.deltas[0]).toMatchObject({ type: 'message.delta', data: { text: 'hey' } });
    log.hub.detachAll('moved');
    await until(() => f.detached.length === 1);
    expect(f.detached).toEqual(['moved']);
  });

  it('pending calls resolve unavailable when the server goes away', async () => {
    const { log, sid, sock, server } = await served();
    const c = await dialApi(sock, TOKEN);
    const t = mintId('tn');
    log.append('turn.queued', { position: 1, trigger: 'message', subagentId: null }, { turnId: t, actor: ANN });
    const waiting = c.call('turns.get', { sessionId: sid, turnId: t, waitMs: 5000 }, ANN_CTX);
    await new Promise((r) => setTimeout(r, 20));
    await server.close();
    expect((await waiting).error).toMatchObject({ code: 'unavailable', retryable: true });
    await c.closed;
    expect((await c.call('sessions.get', { sessionId: sid }, ANN_CTX)).error?.code).toBe('unavailable');
    expect(fs.existsSync(sock)).toBe(false);
  });
});
