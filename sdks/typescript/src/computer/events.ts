// A session's events (sections 18.3, 37.1, 38.3): held by `seq` in memory for the life of the
// client, and in storage with `keepEvents`. The rules are the feed's: apply a pushed frame whose
// `from` is the cursor held, ignore one whose `to` is, read over HTTP otherwise; `reset` drops the
// events above its `seq` and reads on from its cursor.

import { transient, type Ctx, type Op } from "./ctx.js";
import { emitter, type Emitter } from "./signal.js";
import type { EventsUpdate, Stream } from "./client-interface.js";
import type { EventPage } from "./http-bodies.js";
import type { ApiEvent } from "./session-objects.js";
import type { ServerFrame } from "./socket-frames.js";

interface Log {
  id: string;
  events: Map<number, ApiEvent>;
  cursor: string | null;
  subs: Emitter<EventsUpdate>;
  tailTurns: number;
  reading: boolean;
  again: boolean;
  /** Storage's copy has been read. */
  loaded: Promise<void>;
}

export interface Events {
  stream(sessionId: string, o?: { tailTurns?: number }): Stream<EventsUpdate>;
  connected(): void;
  onSocket(f: ServerFrame): void;
}

const pad = (seq: number) => String(seq).padStart(12, "0");

/** `onEvents` runs before new events are emitted; what it answers runs after. */
export function createEvents(ctx: Ctx, onEvents: (sessionId: string, events: ApiEvent[]) => () => void): Events {
  const logs = new Map<string, Log>();
  const keep = !!ctx.o.keepEvents;
  const retry = ctx.backoff();

  function logOf(id: string): Log {
    let log = logs.get(id);
    if (!log) {
      log = { id, events: new Map(), cursor: null, subs: emitter(), tailTurns: 20, reading: false, again: false, loaded: Promise.resolve() };
      if (keep) log.loaded = load(log);
      logs.set(id, log);
    }
    return log;
  }

  async function load(log: Log): Promise<void> {
    await ctx.written();
    const [cursor, held] = await Promise.all([ctx.o.storage.get(`ev/${log.id}/cursor`), ctx.o.storage.list(`ev/${log.id}/e/`)]);
    log.cursor = (cursor as string | null | undefined) ?? null;
    for (const [, e] of held) log.events.set((e as ApiEvent).seq, e as ApiEvent);
  }

  const sorted = (log: Log) => [...log.events.values()].sort((a, b) => a.seq - b.seq);

  function add(log: Log, events: ApiEvent[], cursor: string): void {
    const fresh = events.filter((e) => !log.events.has(e.seq)).sort((a, b) => a.seq - b.seq);
    for (const e of fresh) log.events.set(e.seq, e);
    log.cursor = cursor;
    if (keep) ctx.write([...fresh.map((e): Op => ({ put: `ev/${log.id}/e/${pad(e.seq)}`, value: e })), { put: `ev/${log.id}/cursor`, value: cursor }]);
    const after = onEvents(log.id, fresh);
    if (fresh.length) log.subs.emit({ events: fresh });
    after();
  }

  function reset(log: Log, cursor: string | null, seq: number | undefined): void {
    const last = cursor === null || seq === undefined ? null : seq;
    const ops: Op[] = [{ put: `ev/${log.id}/cursor`, value: cursor }];
    for (const s of [...log.events.keys()]) {
      if (last !== null && s <= last) continue;
      log.events.delete(s);
      ops.push({ delete: `ev/${log.id}/e/${pad(s)}` });
    }
    log.cursor = cursor;
    if (keep) ctx.write(ops);
    log.subs.emit({ events: [], reset: { seq: last } });
  }

  function catchUp(log: Log): void {
    if (!log.subs.size() || ctx.closed) return;
    if (log.reading) {
      log.again = true;
      return;
    }
    log.reading = true;
    void read(log).finally(() => (log.reading = false));
  }

  async function read(log: Log): Promise<void> {
    const live = () => log.subs.size() > 0 && !ctx.closed;
    while (live()) {
      log.again = false;
      const sent = log.cursor;
      const q = sent !== null ? `after=${encodeURIComponent(sent)}` : `tailTurns=${log.tailTurns}`;
      const reply = await ctx.request(`/sessions/${log.id}/events?${q}`).catch(() => null);
      if (!live()) return;
      if (!reply || transient(reply.status)) {
        await retry.wait();
        continue;
      }
      retry.reset();
      if (sent !== log.cursor) continue; // a `reset` on the socket overtook this read
      if (reply.status === 409 && reply.body?.error?.code === "reset") {
        reset(log, reply.body.error.cursor ?? null, reply.body.error.seq);
        continue;
      }
      if (reply.status !== 200) return;
      const page = reply.body as EventPage;
      add(log, page.events, page.cursor);
      if (!page.hasMore && !log.again) return;
    }
  }

  const start = (log: Log) => {
    ctx.send({ t: "sub", stream: `events:${log.id}`, after: log.cursor ?? undefined });
    catchUp(log);
  };

  return {
    stream(sessionId, o) {
      return {
        subscribe(cb) {
          const log = logOf(sessionId);
          let on = true;
          void log.loaded.then(() => {
            if (!on) return;
            if (log.events.size) cb({ events: sorted(log) });
            if (!log.subs.add(cb)) return;
            log.tailTurns = o?.tailTurns ?? 20;
            start(log);
          });
          return () => {
            on = false;
            if (log.subs.remove(cb)) ctx.send({ t: "unsub", stream: `events:${log.id}` });
          };
        },
      };
    },
    connected() {
      for (const log of logs.values()) if (log.subs.size()) start(log);
    },
    onSocket(f) {
      const id = f.t === "events" ? f.session : "stream" in f && f.stream.startsWith("events:") ? f.stream.slice(7) : null;
      const log = id === null ? undefined : logs.get(id);
      if (!log || !log.subs.size()) return;
      if (f.t === "events") {
        if (log.reading) log.again = true;
        else if (f.from === log.cursor) add(log, f.events, f.to);
        else if (f.to !== log.cursor) catchUp(log);
      } else if (f.t === "subd" || f.t === "behind") {
        if (f.head !== log.cursor) catchUp(log);
      } else if (f.t === "reset") {
        // Live refused the `sub` this answers (38.4), so subscribe again from what is left.
        reset(log, f.cursor, f.seq);
        start(log);
      }
    },
  };
}
