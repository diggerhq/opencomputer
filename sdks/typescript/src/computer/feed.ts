// The feed (sections 18.4, 37.1, 38.3): one cursor and the rows read so far, both in storage.
//
// - A pushed frame is applied when its `from` is the cursor held; ignored when its `to` is; any
//   other means a gap, and the client reads over HTTP from its cursor.
// - While a read is in flight pushed frames are ignored, and one more read follows it, so a frame
//   that raced the reply is not lost.
// - `reset` drops the rows and reads from the cursor it names (a snapshot when null).
// - On each connection a read catches up from the cursor.

import { transient, type Ctx, type Op } from "./ctx.js";
import { emitter } from "./signal.js";
import type { Stream } from "./client-interface.js";
import type { Row } from "./feed-rows.js";
import type { FeedFrame } from "./http-bodies.js";
import type { ServerFrame } from "./socket-frames.js";

export interface Feed {
  stream(kinds: string[]): Stream<FeedFrame>;
  /** Storage's copy, read at start. */
  load(cursor: string | null, rows: Row[]): void;
  /** A new socket: subscribe again and catch up. */
  connected(): void;
  onSocket(f: ServerFrame): void;
  /** Read from the cursor now. */
  catchUp(): void;
  active(): boolean;
  /** The feed version of the last frame applied in this run; 0 before one. */
  version(): number;
  row(kind: string, id: string): Row | undefined;
}

/** `onFrame` runs after a frame's rows are stored and before it is emitted; what it answers runs after. */
export function createFeed(ctx: Ctx, onFrame: (frame: FeedFrame) => () => void): Feed {
  const { org, subject } = ctx.o.principal;
  const rows = new Map<string, Row>();
  const subs = emitter<FeedFrame>();
  const retry = ctx.backoff();
  let cursor: string | null = null;
  let version = 0;
  let kinds: string[] = [];
  let active = false;
  let reading = false;
  let again = false;

  const frameOf = (from: string | null, to: string, r: Row[]): FeedFrame => ({ protocol: 1, org, subject, from, to, more: false, rows: r, gone: [], version });

  function apply(frame: FeedFrame): void {
    const ops: Op[] = [];
    if (frame.from === null) {
      for (const k of rows.keys()) ops.push({ delete: `feed/row/${k}` });
      rows.clear();
    }
    for (const r of frame.rows) {
      rows.set(`${r.kind}/${r.id}`, r);
      ops.push({ put: `feed/row/${r.kind}/${r.id}`, value: r });
    }
    for (const g of frame.gone) {
      rows.delete(`${g.kind}/${g.id}`);
      ops.push({ delete: `feed/row/${g.kind}/${g.id}` });
    }
    cursor = frame.to;
    version = frame.version;
    ops.push({ put: "feed/cursor", value: cursor });
    ctx.write(ops);
    const after = onFrame(frame);
    subs.emit(frame);
    after();
  }

  /** `reset`: nothing held is good any more. */
  function drop(to: string | null): void {
    const ops: Op[] = [...rows.keys()].map((k) => ({ delete: `feed/row/${k}` }));
    rows.clear();
    cursor = to;
    version = 0;
    ctx.write([...ops, { put: "feed/cursor", value: cursor }]);
    if (to !== null) subs.emit(frameOf(null, to, []));
  }

  function catchUp(): void {
    if (!active || ctx.closed) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    void read().finally(() => (reading = false));
  }

  async function read(): Promise<void> {
    const live = () => active && !ctx.closed;
    while (live()) {
      again = false;
      const sent = cursor;
      const q = new URLSearchParams();
      if (sent !== null) q.set("after", sent);
      q.set("kinds", kinds.join(","));
      const reply = await ctx.request(`/feed?${q}`).catch(() => null);
      if (!live()) return;
      if (!reply || transient(reply.status)) {
        await retry.wait();
        continue;
      }
      retry.reset();
      if (sent !== cursor) continue; // a `reset` on the socket overtook this read
      if (reply.status === 409 && reply.body?.error?.code === "reset") {
        drop(reply.body.error.cursor ?? null);
        continue;
      }
      if (reply.status !== 200) return;
      const frame = reply.body as FeedFrame;
      if (frame.org !== org || frame.subject !== subject) return; // computed for another principal (section 20)
      apply(frame);
      if (!frame.more && !again) return;
    }
  }

  function start(): void {
    active = true;
    ctx.send({ t: "sub", stream: "feed", after: cursor ?? undefined, kinds });
    catchUp();
  }

  function stop(): void {
    active = false;
    ctx.send({ t: "unsub", stream: "feed" });
  }

  return {
    stream(k) {
      return {
        subscribe(cb) {
          if (cursor !== null) cb(frameOf(null, cursor, [...rows.values()]));
          if (subs.add(cb)) {
            kinds = k;
            start();
          }
          return () => {
            if (subs.remove(cb)) stop();
          };
        },
      };
    },
    load(c, held) {
      cursor = c;
      for (const r of held) rows.set(`${r.kind}/${r.id}`, r);
    },
    connected() {
      if (!active) return;
      ctx.send({ t: "sub", stream: "feed", after: cursor ?? undefined, kinds });
      catchUp();
    },
    onSocket(f) {
      if (!active) return;
      if (f.t === "feed") {
        if (reading) again = true;
        else if (f.from === cursor) apply({ protocol: 1, org, subject, more: false, from: f.from, to: f.to, rows: f.rows, gone: f.gone, version: f.version });
        else if (f.to !== cursor) catchUp();
      } else if (f.t === "subd" || f.t === "behind") {
        if (f.head !== cursor) catchUp();
      } else if (f.t === "reset") {
        // Live refused the `sub` this answers (38.4), so subscribe again from what is left.
        drop(f.cursor);
        ctx.send({ t: "sub", stream: "feed", after: cursor ?? undefined, kinds });
        catchUp();
      }
    },
    catchUp,
    active: () => active,
    version: () => version,
    row: (kind, id) => rows.get(`${kind}/${id}`),
  };
}
