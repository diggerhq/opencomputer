// `createClient` (section 42.1): the socket of section 38.3, the three streams, the write queue.
//
// Storage keys: `meta` (the client id and the counters), `queue/<counter>`, `feed/cursor`,
// `feed/ack`, `feed/row/<kind>/<id>`, and with `keepEvents` `ev/<session>/cursor` and
// `ev/<session>/e/<seq>`.
//
// Nothing starts before `ready`: a stream subscribed earlier starts then, and a write made earlier
// throws (its number comes from storage).

import { createCtx, refusal } from "./ctx.js";
import { createEvents } from "./events.js";
import { createFeed } from "./feed.js";
import { makeId } from "./ids.js";
import { createQueue, type Meta } from "./queue.js";
import { emitter, signal, type Emitter } from "./signal.js";
import type { Channel, Client, ClientOptions, Delta, Row, ServerFrame, Stream } from "./types.js";

interface Watch {
  subs: Emitter<Delta>;
  /** The length held of each block. */
  lengths: Map<string, number>;
  /** Blocks asked for with `block` and not yet answered `whole`. */
  asked: Set<string>;
}

export function createClient(o: ClientOptions): Client {
  const ctx = createCtx(o);
  const status = signal<"connecting" | "online" | "offline">("connecting");
  const feed = createFeed(ctx, (frame) => queue.onFeed(frame));
  const events = createEvents(ctx, (id, evs) => queue.onEvents(id, evs));
  const queue = createQueue(ctx, feed);
  const watches = new Map<string, Watch>();
  const failures = queue.failures;

  // ---------- the socket ----------

  let channel: Channel | null = null;
  let attempt = 0;
  let cancelReconnect = () => {};

  function connect(): void {
    if (ctx.closed) return;
    status.set("connecting");
    const ch = o.connect();
    channel = ch;
    let ready = false;
    let early: ServerFrame[] = [];
    ch.onFrame((f) => {
      if (channel !== ch) return;
      if (f.t === "ready") {
        if (f.org !== o.principal.org || f.subject !== o.principal.subject) {
          // Another principal's socket: drop what arrived, and do not try again.
          channel = null;
          ch.close();
          status.set("offline");
          return;
        }
        ready = true;
        attempt = 0;
        status.set("online");
        ctx.wake();
        for (const e of early.splice(0)) route(e);
      } else if (ready) route(f);
      else early.push(f);
    });
    ch.onState((s) => {
      if (s !== "closed" || channel !== ch) return;
      channel = null;
      early = [];
      status.set("offline");
      const ms = Math.min(60_000, (1000 + ctx.random() * 4000) * 2 ** attempt++);
      cancelReconnect = ctx.timer(connect, ms);
    });
    ch.send({ t: "hello", protocol: 1, clientId: ctx.clientId });
    feed.connected();
    events.connected();
    for (const [id, w] of watches) if (w.subs.size()) ch.send({ t: "sub", stream: `deltas:${id}` });
  }

  function route(f: ServerFrame): void {
    if (f.t === "delta") return onDelta(f);
    if (f.t === "feed" || ("stream" in f && f.stream === "feed")) return feed.onSocket(f);
    if (f.t === "events" || "stream" in f) events.onSocket(f);
  }

  ctx.send = (frame) => channel?.send(frame);

  // ---------- deltas ----------

  function onDelta(f: ServerFrame & { t: "delta" }): void {
    const w = watches.get(f.session);
    if (!w || !w.subs.size()) return;
    const { t: _t, ...delta } = f;
    const block = delta.data.blockId;
    if (block !== undefined) {
      const text = delta.data.text ?? "";
      if (delta.whole) {
        w.asked.delete(block);
        w.lengths.set(block, text.length);
      } else if (w.asked.has(block)) return;
      else if (delta.offset !== (w.lengths.get(block) ?? 0)) {
        w.asked.add(block);
        ctx.send({ t: "block", session: f.session, blockId: block });
        return;
      } else w.lengths.set(block, delta.offset + text.length);
    }
    w.subs.emit(delta);
  }

  function deltas(sessionId: string): Stream<Delta> {
    return {
      subscribe(cb) {
        let w = watches.get(sessionId);
        if (!w) watches.set(sessionId, (w = { subs: emitter(), lengths: new Map(), asked: new Set() }));
        const watch = w;
        if (watch.subs.add(cb)) ctx.send({ t: "sub", stream: `deltas:${sessionId}` });
        return () => {
          if (!watch.subs.remove(cb)) return;
          watches.delete(sessionId);
          ctx.send({ t: "unsub", stream: `deltas:${sessionId}` });
        };
      },
    };
  }

  // ---------- start ----------

  const ready = (async () => {
    const s = o.storage;
    const [meta, cursor, ack, rows, queued] = await Promise.all([s.get("meta"), s.get("feed/cursor"), s.get("feed/ack"), s.list("feed/row/"), s.list("queue/")]);
    if (ctx.closed) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stored = queued.map(([, v]) => v as any);
    const m = (meta as Meta | undefined) ?? { clientId: makeId("cl", ctx.random), n: 0, k: 0 };
    // An entry is written before the counters, so the counters may be behind it, never ahead of a gap.
    for (const e of stored) {
      m.k = Math.max(m.k, Number(e.p.key));
      if (e.p.kind === "mutation") m.n = Math.max(m.n, e.p.n);
    }
    if (!meta) ctx.write([{ put: "meta", value: m }]);
    ctx.clientId = m.clientId;
    feed.load((cursor as string | null | undefined) ?? null, (ack as number | undefined) ?? 0, rows.map(([, r]) => r as Row));
    queue.load(m, stored);
    connect();
    queue.pump();
  })();

  /** A stream that starts once storage has been read. */
  function whenReady<T>(stream: () => Stream<T>): Stream<T> {
    return {
      subscribe(cb) {
        let off: (() => void) | null = null;
        let on = true;
        void ready.then(() => {
          if (on && !ctx.closed) off = stream().subscribe(cb);
        });
        return () => {
          on = false;
          off?.();
        };
      },
    };
  }

  function close(): void {
    ctx.closed = true;
    cancelReconnect();
    ctx.wake();
    const ch = channel;
    channel = null;
    ch?.close();
    status.set("offline");
  }

  return {
    get clientId() {
      return ctx.clientId;
    },
    status,
    ready,
    feed: (kinds) => whenReady(() => feed.stream(kinds)),
    events: (sessionId, opts) => whenReady(() => events.stream(sessionId, opts)),
    deltas: (sessionId) => whenReady(() => deltas(sessionId)),
    mutate: (name, args) => queue.add({ kind: "mutation", n: 0, name, args: args as Record<string, unknown> }),
    createSession(body) {
      const id = body.id ?? makeId("cs", ctx.random);
      const turnId = body.turnId ?? makeId("tn", ctx.random);
      const { settled } = queue.add({ kind: "session", sessionId: id, body: { ...body, id, turnId } }, id);
      return { id, turnId, settled };
    },
    send(sessionId, input, opts) {
      const turnId = makeId("tn", ctx.random);
      const { settled } = queue.add({ kind: "turn", sessionId, turnId, input, ifBusy: opts?.ifBusy }, turnId);
      return { turnId, settled };
    },
    answer: (sessionId, askId, answer) => ({ settled: queue.add({ kind: "answer", sessionId, askId, answer }).settled }),
    dismiss: (sessionId, askId) => ({ settled: queue.add({ kind: "dismiss", sessionId, askId }).settled }),
    interrupt: (sessionId) => ({ settled: queue.add({ kind: "interrupt", sessionId }).settled }),
    pending: () => queue.pending,
    failures: {
      subscribe(cb) {
        failures.add(cb);
        return () => void failures.remove(cb);
      },
    },
    async read<T>(path: string): Promise<T> {
      const reply = await ctx.request(path);
      if (reply.status >= 300) throw refusal(reply);
      return reply.body as T;
    },
    close,
    async wipe() {
      close();
      await ready.catch(() => {});
      await ctx.written();
      const keys = await o.storage.list("");
      ctx.write(keys.map(([k]) => ({ delete: k })));
      await ctx.written();
    },
  };
}
