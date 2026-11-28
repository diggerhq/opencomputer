// A session's events (sections 18.3, 37.1, 38.3): a window on the log's end, held by `seq` in
// memory for the life of the client, and in storage with `keepEvents`. The window has no gaps: a
// cursor at its newer edge, a place at its older one. One rule reads it: an empty window is read
// with `last`, a held one with `after`. On the socket the rules are the feed's: apply a pushed
// frame whose `from` is the cursor held, ignore one whose `to` is, read over HTTP otherwise;
// `reset` drops the events above its `seq` and reads on from its cursor.

import { transient, type Ctx, type Op } from "./ctx.js";
import { emitter, type Emitter } from "./signal.js";
import type { EventsUpdate, Stream } from "./client-interface.js";
import type { EventPage, EventPageBefore } from "./http-bodies.js";
import type { ApiEvent } from "./session-objects.js";
import type { ServerFrame } from "./socket-frames.js";

/** The events an empty window is opened with. */
const FIRST = 200;
/** The most a read asks for: a top-up, or a page of earlier events. */
const PAGE = 500;

interface Log {
  id: string;
  events: Map<number, ApiEvent>;
  cursor: string | null;
  /** The place before the first event held, and whether events exist before it. Null: the window is empty. */
  prev: { cursor: string; more: boolean } | null;
  subs: Emitter<EventsUpdate>;
  reading: Promise<void> | null;
  again: boolean;
  /** The log's end as the socket last told it while a read was under way; undefined when it has not. */
  head?: string | null;
  /** A prefetch is reading, though nobody may be subscribed. */
  ahead: boolean;
  earlier: Promise<void> | null;
  /** Storage's copy has been read. */
  loaded: Promise<void>;
}

export interface Events {
  stream(sessionId: string): Stream<EventsUpdate>;
  earlier(sessionId: string): Promise<void>;
  prefetch(sessionId: string): Promise<EventsUpdate | null>;
  connected(): void;
  onSocket(f: ServerFrame): void;
}

const pad = (seq: number) => String(seq).padStart(12, "0");
const bySeq = (a: ApiEvent, b: ApiEvent) => a.seq - b.seq;

/** `onEvents` runs before new events are emitted; what it answers runs after. */
export function createEvents(ctx: Ctx, onEvents: (sessionId: string, events: ApiEvent[]) => () => void): Events {
  const logs = new Map<string, Log>();
  const keep = !!ctx.o.keepEvents;
  const retry = ctx.backoff();

  function logOf(id: string): Log {
    let log = logs.get(id);
    if (!log) {
      log = { id, events: new Map(), cursor: null, prev: null, subs: emitter(), reading: null, again: false, ahead: false, earlier: null, loaded: Promise.resolve() };
      if (keep) log.loaded = load(log);
      logs.set(id, log);
    }
    return log;
  }

  async function load(log: Log): Promise<void> {
    await ctx.written();
    const [cursor, prev, held] = await Promise.all([
      ctx.o.storage.get(`ev/${log.id}/cursor`),
      ctx.o.storage.get(`ev/${log.id}/prev`),
      ctx.o.storage.list(`ev/${log.id}/e/`),
    ]);
    log.cursor = (cursor as string | null | undefined) ?? null;
    // Events kept without their older edge cannot be read back from: the window starts empty.
    if (!prev) return ctx.write(held.map(([key]): Op => ({ delete: key })));
    log.prev = prev as Log["prev"];
    for (const [, e] of held) log.events.set((e as ApiEvent).seq, e as ApiEvent);
  }

  const sorted = (log: Log) => [...log.events.values()].sort(bySeq);
  const puts = (log: Log, events: ApiEvent[]) => events.map((e): Op => ({ put: `ev/${log.id}/e/${pad(e.seq)}`, value: e }));
  /** Read while someone is subscribed, or once for a prefetch. */
  const live = (log: Log) => (log.subs.size() > 0 || log.ahead) && !ctx.closed;

  /** The read of an empty window landed: the whole window, in one update that replaces what a reader holds. */
  function fill(log: Log, page: EventPageBefore): void {
    const events = [...page.events].sort(bySeq);
    for (const e of events) log.events.set(e.seq, e);
    log.cursor = page.cursor;
    log.prev = { cursor: page.prevCursor, more: page.hasMoreBefore };
    if (keep) ctx.write([...puts(log, events), { put: `ev/${log.id}/cursor`, value: log.cursor }, { put: `ev/${log.id}/prev`, value: log.prev }]);
    const after = onEvents(log.id, events);
    log.subs.emit({ events, reset: { seq: null }, hasEarlier: log.prev.more });
    after();
  }

  function add(log: Log, events: ApiEvent[], cursor: string): void {
    const fresh = events.filter((e) => !log.events.has(e.seq)).sort(bySeq);
    for (const e of fresh) log.events.set(e.seq, e);
    log.cursor = cursor;
    if (keep) ctx.write([...puts(log, fresh), { put: `ev/${log.id}/cursor`, value: cursor }]);
    const after = onEvents(log.id, fresh);
    if (fresh.length) log.subs.emit({ events: fresh, hasEarlier: !!log.prev?.more });
    after();
  }

  /** Drops the events above `last` (all of them when null). With none left the window is empty, and says nothing until it is read again. */
  function drop(log: Log, last: number | null, cursor: string | null): void {
    const ops: Op[] = [{ put: `ev/${log.id}/cursor`, value: cursor }];
    for (const s of [...log.events.keys()]) {
      if (last !== null && s <= last) continue;
      log.events.delete(s);
      ops.push({ delete: `ev/${log.id}/e/${pad(s)}` });
    }
    log.cursor = cursor;
    const held = log.prev !== null && log.events.size > 0;
    if (!held) {
      log.prev = null;
      ops.push({ delete: `ev/${log.id}/prev` });
    }
    if (keep) ctx.write(ops);
    if (held) log.subs.emit({ events: [], reset: { seq: last }, hasEarlier: log.prev!.more });
  }

  const reset = (log: Log, cursor: string | null, seq: number | undefined) => drop(log, cursor === null || seq === undefined ? null : seq, cursor);

  function catchUp(log: Log): Promise<void> {
    if (!live(log)) return Promise.resolve();
    if (log.reading) {
      log.again = true;
      return log.reading;
    }
    return (log.reading = read(log).finally(() => (log.reading = null)));
  }

  async function read(log: Log): Promise<void> {
    while (live(log)) {
      log.again = false;
      log.head = undefined;
      const sent = log.cursor;
      const held = log.prev !== null;
      const q = held ? `after=${encodeURIComponent(sent ?? "")}&limit=${PAGE}` : `last=${FIRST}`;
      const reply = await ctx.request(`/sessions/${log.id}/events?${q}`).catch(() => null);
      if (!live(log)) return;
      if (!reply || transient(reply.status)) {
        if (!log.subs.size()) return; // a prefetch does not wait for the network
        await retry.wait();
        continue;
      }
      retry.reset();
      if (sent !== log.cursor || held !== (log.prev !== null)) continue; // a `reset` on the socket overtook this read
      if (reply.status === 409 && reply.body?.error?.code === "reset") {
        reset(log, reply.body.error.cursor ?? null, reply.body.error.seq);
        continue;
      }
      if (reply.status !== 200) return;
      if (!held) fill(log, reply.body as EventPageBefore);
      else {
        const page = reply.body as EventPage;
        // More than a page behind (18.3): the window is read again from the end.
        if (page.hasMore) {
          drop(log, null, sent);
          continue;
        }
        add(log, page.events, page.cursor);
      }
      // A `subd` that named the end this read reached asks for nothing more.
      if (!log.again && (log.head === undefined || log.head === log.cursor)) return;
    }
  }

  /** One page of the events before the window. */
  async function back(log: Log): Promise<void> {
    while (!ctx.closed) {
      const prev = log.prev;
      if (!prev?.more) return;
      const reply = await ctx.request(`/sessions/${log.id}/events?before=${encodeURIComponent(prev.cursor)}&last=${PAGE}`).catch(() => null);
      if (ctx.closed) return;
      if (!reply || transient(reply.status)) {
        if (!log.subs.size()) return;
        await retry.wait();
        continue;
      }
      if (log.prev !== prev) return; // the window was emptied while this was read
      if (reply.status === 409 && reply.body?.error?.code === "reset") {
        // The place before the window is gone, so the window is read again from the end.
        drop(log, null, log.cursor);
        void catchUp(log);
        return;
      }
      if (reply.status !== 200) return;
      const page = reply.body as EventPageBefore;
      const fresh = page.events.filter((e) => !log.events.has(e.seq)).sort(bySeq);
      for (const e of fresh) log.events.set(e.seq, e);
      log.prev = { cursor: page.prevCursor, more: page.hasMoreBefore };
      if (keep) ctx.write([...puts(log, fresh), { put: `ev/${log.id}/prev`, value: log.prev }]);
      log.subs.emit({ events: fresh, hasEarlier: log.prev.more });
      return;
    }
  }

  const start = (log: Log) => {
    ctx.send({ t: "sub", stream: `events:${log.id}`, after: log.cursor ?? undefined });
    void catchUp(log);
  };

  return {
    stream(sessionId) {
      return {
        subscribe(cb) {
          const log = logOf(sessionId);
          let on = true;
          void log.loaded.then(() => {
            if (!on) return;
            if (log.prev) cb({ events: sorted(log), reset: { seq: null }, hasEarlier: log.prev.more });
            if (!log.subs.add(cb)) return;
            start(log);
          });
          return () => {
            on = false;
            if (log.subs.remove(cb)) ctx.send({ t: "unsub", stream: `events:${log.id}` });
          };
        },
      };
    },
    earlier(sessionId) {
      const log = logs.get(sessionId);
      if (!log) return Promise.resolve();
      return (log.earlier ??= back(log).finally(() => (log.earlier = null)));
    },
    async prefetch(sessionId) {
      const log = logOf(sessionId);
      await log.loaded;
      log.ahead = true;
      await catchUp(log).finally(() => (log.ahead = false));
      return log.prev ? { events: sorted(log), reset: { seq: null }, hasEarlier: log.prev.more } : null;
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
        else if (f.to !== log.cursor) void catchUp(log);
      } else if (f.t === "subd" || f.t === "behind") {
        if (log.reading) log.head = f.head;
        else if (f.head !== log.cursor) void catchUp(log);
      } else if (f.t === "reset") {
        // Live refused the `sub` this answers (38.4), so subscribe again from what is left.
        reset(log, f.cursor, f.seq);
        start(log);
      }
    },
  };
}
