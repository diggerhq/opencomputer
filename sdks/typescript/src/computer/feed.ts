// The feed (sections 18.4, 37.1, 38.3): one cursor and the rows read so far, both in storage.
//
// - A pushed frame is applied when its `from` is the cursor held; ignored when its `to` is; any
//   other means a gap, and the client reads over HTTP from its cursor.
// - While a read is in flight pushed frames are ignored, and one more read follows it, so a frame
//   that raced the reply is not lost.
// - `reset` drops the rows and reads from the cursor it names (a snapshot when null).
// - On each connection and hourly a read asks for the checksum; a difference is reported and a
//   snapshot replaces the rows. The sum is over the rows held less the `session` and `place` rows of
//   a thread whose place has `earlierAt` set, since a snapshot would not send those.

import { transient, type Ctx, type Op } from "./ctx.js";
import { emitter } from "./signal.js";
import { checksum } from "./sum.js";
import type { FeedFrame, Row, ServerFrame, Stream } from "./types.js";

const HOUR = 3_600_000;

export interface Feed {
  stream(kinds: string[]): Stream<FeedFrame>;
  /** Storage's copy, read at start. */
  load(cursor: string | null, ack: number, rows: Row[]): void;
  /** A new socket: subscribe again and catch up, with the checksum. */
  connected(): void;
  onSocket(f: ServerFrame): void;
  /** Read from the cursor now. */
  catchUp(): void;
  active(): boolean;
  row(kind: string, id: string): Row | undefined;
}

/** `onFrame` runs after a frame's rows are stored and before it is emitted; what it answers runs after. */
export function createFeed(ctx: Ctx, onFrame: (frame: FeedFrame) => () => void): Feed {
  const { org, subject } = ctx.o.principal;
  const rows = new Map<string, Row>();
  const subs = emitter<FeedFrame>();
  const retry = ctx.backoff();
  let cursor: string | null = null;
  let ack = 0;
  let kinds: string[] = [];
  let active = false;
  let reading = false;
  let again = false;
  let wantSum = false;
  let stopHourly = () => {};

  const frameOf = (from: string | null, to: string, r: Row[]): FeedFrame => ({ protocol: 1, org, subject, from, to, more: false, rows: r, gone: [] });

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
    ops.push({ put: "feed/cursor", value: cursor });
    for (const e of frame.errors ?? []) ack = Math.max(ack, e.n);
    if (frame.errors?.length) ops.push({ put: "feed/ack", value: ack });
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
    ctx.write([...ops, { put: "feed/cursor", value: cursor }]);
    if (to !== null) subs.emit(frameOf(null, to, []));
  }

  function sumRows(): Row[] {
    const earlier = new Set<string>();
    for (const r of rows.values()) if (r.kind === "place" && r.earlierAt != null) earlier.add(r.id);
    return [...rows.values()].filter((r) => !((r.kind === "place" || r.kind === "session") && earlier.has(r.id)));
  }

  function catchUp(sum = false): void {
    if (!active || ctx.closed) return;
    wantSum ||= sum;
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
      const sum = wantSum;
      const sent = cursor;
      const q = new URLSearchParams();
      if (sent !== null) q.set("after", sent);
      q.set("kinds", kinds.join(","));
      q.set("client", ctx.clientId);
      q.set("ack", String(ack));
      if (sum) q.set("sum", "1");
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
      if (frame.more) continue;
      if (sum) {
        wantSum = false;
        if (frame.sum !== undefined) {
          const mine = await checksum(sumRows());
          if (!live()) return;
          if (mine !== frame.sum) {
            const body = JSON.stringify({ clientId: ctx.clientId, cursor: frame.to, server: frame.sum, client: mine });
            await ctx.request("/feed/mismatch", { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => null);
            drop(null);
            continue;
          }
        }
      }
      if (!again && !wantSum) return;
    }
  }

  function start(): void {
    active = true;
    ctx.send({ t: "sub", stream: "feed", after: cursor, kinds });
    catchUp(true);
    const tick = () => {
      catchUp(true);
      stopHourly = ctx.timer(tick, HOUR);
    };
    stopHourly = ctx.timer(tick, HOUR);
  }

  function stop(): void {
    active = false;
    stopHourly();
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
    load(c, a, held) {
      cursor = c;
      ack = a;
      for (const r of held) rows.set(`${r.kind}/${r.id}`, r);
    },
    connected() {
      if (!active) return;
      ctx.send({ t: "sub", stream: "feed", after: cursor, kinds });
      catchUp(true);
    },
    onSocket(f) {
      if (!active) return;
      if (f.t === "feed") {
        if (reading) again = true;
        else if (f.from === cursor) apply({ protocol: 1, org, subject, more: false, from: f.from, to: f.to, rows: f.rows, gone: f.gone, lastMutation: f.lastMutation, errors: f.errors });
        else if (f.to !== cursor) catchUp();
      } else if (f.t === "subd" || f.t === "behind") {
        if (f.head !== cursor) catchUp();
      } else if (f.t === "reset") {
        drop(f.cursor);
        catchUp();
      }
    },
    catchUp: () => catchUp(),
    active: () => active,
    row: (kind, id) => rows.get(`${kind}/${id}`),
  };
}
