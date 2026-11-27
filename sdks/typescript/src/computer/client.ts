// `createClient` (section 42.1): the socket of section 38.3, the three streams, the write queue.
//
// Storage keys: `meta` (the client id), `queue/<ms>-<key>`, `att/<id>` (a pending attachment),
// `feed/cursor`, `feed/row/<kind>/<id>`, and with `keepEvents` `ev/<session>/cursor` and
// `ev/<session>/e/<seq>`. The bytes of a pending attachment are in `files`.
//
// Nothing starts before `ready`: a stream subscribed earlier starts then, and a write made earlier
// throws (the queue comes from storage).

import { ATTACHMENTS_PER_MESSAGE, createAttachments, type StoredAttachment } from "./attachments.js";
import { createCtx, refusal } from "./ctx.js";
import { createEvents } from "./events.js";
import { createFeed } from "./feed.js";
import { makeId } from "./ids.js";
import { memoryFiles } from "./memory-files.js";
import { createQueue } from "./queue.js";
import { emitter, signal, type Emitter } from "./signal.js";
import { Refused, type Channel, type Client, type ClientOptions, type Stream } from "./client-interface.js";
import type { Row } from "./feed-rows.js";
import type { Delta, ServerFrame } from "./socket-frames.js";

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
  const attachments = createAttachments(ctx, o.files ?? memoryFiles());
  const queue = createQueue(ctx, feed, attachments);
  attachments.changed.add(() => queue.pump());
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
    ch.send({ t: "hello", protocol: 1 });
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
    const [meta, cursor, rows, queued, attached] = await Promise.all([
      s.get("meta"),
      s.get("feed/cursor"),
      s.list("feed/row/"),
      s.list("queue/"),
      s.list("att/"),
    ]);
    if (ctx.closed) return;
    const m = (meta as { clientId: string } | undefined) ?? { clientId: makeId("cl", ctx.random) };
    if (!meta) ctx.write([{ put: "meta", value: m }]);
    ctx.clientId = m.clientId;
    feed.load((cursor as string | null | undefined) ?? null, rows.map(([, r]) => r as Row));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queue.load(queued.map(([, v]) => v as any));
    attachments.load(attached.map(([, v]) => v as StoredAttachment));
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

  function tooMany(ids: string[] | undefined): void {
    if (ids && ids.length > ATTACHMENTS_PER_MESSAGE) throw new Refused("too_many_attachments", `a message can carry at most ${ATTACHMENTS_PER_MESSAGE} files`);
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
    mutate: (name, args) => queue.add({ kind: "mutation", name, args: args as Record<string, unknown> }),
    createSession(body) {
      tooMany(body.attachments);
      const id = body.id ?? makeId("cs", ctx.random);
      const turnId = body.turnId ?? makeId("tn", ctx.random);
      const { settled } = queue.add({ kind: "session", sessionId: id, body: { ...body, id, turnId } }, id);
      return { id, turnId, settled };
    },
    send(sessionId, input, opts) {
      tooMany(opts?.attachments);
      const turnId = makeId("tn", ctx.random);
      const p = { kind: "turn" as const, sessionId, turnId, input, ifBusy: opts?.ifBusy, attachments: opts?.attachments?.length ? opts.attachments : undefined };
      const { settled } = queue.add(p, turnId);
      return { turnId, settled };
    },
    attach: (sessionId, file, opts) => attachments.attach(sessionId, file, opts?.name),
    attachments: () => attachments.list,
    attachmentFile: (id) => attachments.file(id),
    removeAttachment: (id) => attachments.remove(id),
    readAttachment: (sessionId, id) => attachments.read(sessionId, id),
    answer: (sessionId, askId, answer) => ({ settled: queue.add({ kind: "answer", sessionId, askId, answer }).settled }),
    dismiss: (sessionId, askId) => ({ settled: queue.add({ kind: "dismiss", sessionId, askId }).settled }),
    interrupt: (sessionId) => ({ settled: queue.add({ kind: "interrupt", sessionId }).settled }),
    settings: (sessionId, settings) => ({ settled: queue.add({ kind: "settings", sessionId, settings }).settled }),
    async setSecret(sessionId, name, secret) {
      const reply = await ctx.request(`/sessions/${encodeURIComponent(sessionId)}/secrets/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(secret),
      });
      if (reply.status >= 300) throw refusal(reply);
    },
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
