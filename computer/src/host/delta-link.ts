// The deltas of watched sessions, up the gateway link (work 118, sections 36.3
// and 40.5): what the mirror's subscription hears of open blocks, merged per
// block for `mergeMs` (40 ms) and sent as `delta` frames with each delta's
// `offset`, while someone watches.
//
// Invariants:
// - A watch is a lease: `watch(sessionId, until)` lets the session's deltas go
//   until `until`, and nothing renews it here. Unwatched, nothing is sent.
// - Never acknowledged, never resent, never ahead of the journal: a flush that
//   finds the socket holding more than `holdBytes` (the journal's holding
//   mark) drops what it had, as does a closed link.
// - `offset` is the length of the block's text before the delta, counted from
//   every delta heard, sent or not; so a reader that missed some (a drop, a
//   watch that began mid-block) sees an offset it does not hold and asks with
//   `block`, answered by the block so far at `offset: 0`, marked `whole`.
// - A delta that begins its block here (`offset: 0`) is `whole`: after the
//   mirror subscribes again, the writer's catch-up (the text so far) replaces a
//   reader's copy instead of extending it.
// - A block is kept from its first delta to its completed event (or its
//   turn's end, for text), and at most `keepBytes` of text: past that the
//   count goes on, and `block` has nothing to answer with.
// - `subagent.progress` is not a block's text and never comes here
//   (api-bridge.ts sends it as `subagent-progress`).

import { blockKey, COMPLETES, ENDS_TURN, type Keyed } from '../api/hub.js';
import type { HostDelta, HostToGateway, JournalDelta, JournalEvent } from '../protocol.js';

export const MERGE_MS = 40;
/** A block's text kept for `block` (the block so far). */
export const KEEP_BYTES = 2 ** 20;

export interface DeltaLinkDeps {
  /** Send on the gateway socket; false when it is not open. */
  send(m: HostToGateway): boolean;
  /** The gateway socket's unwritten bytes. */
  buffered(): number;
  holdBytes: number;
  /** The epoch the session's events go up under; undefined: not mirrored (nothing is sent). */
  epoch(sessionId: string): number | undefined;
  mergeMs?: number;
  keepBytes?: number;
  now?: () => number;
}

interface Block {
  /** The block's first delta: its type, turn and ids. */
  first: JournalDelta;
  /** Its text so far; undefined once past `keepBytes`. */
  text: string | undefined;
  length: number;
  /** What the next frame carries of it. */
  pending?: { offset: number; text: string };
}

interface Watched {
  until: number;
  blocks: Map<string, Block>;
  timer?: NodeJS.Timeout;
}

const textOf = (d: JournalDelta): string | undefined => {
  const t = (d.data as { text?: unknown } | null)?.text;
  return typeof t === 'string' ? t : undefined;
};

export function deltaLink(d: DeltaLinkDeps) {
  const mergeMs = d.mergeMs ?? MERGE_MS;
  const keepBytes = d.keepBytes ?? KEEP_BYTES;
  const now = d.now ?? Date.now;
  const sessions = new Map<string, Watched>();

  const of = (sessionId: string): Watched => {
    let s = sessions.get(sessionId);
    if (!s) sessions.set(sessionId, (s = { until: 0, blocks: new Map() }));
    return s;
  };

  const frame = (b: Block, offset: number, text: string): HostDelta => ({
    ...b.first,
    data: { ...(b.first.data as object), text },
    offset,
    ...(offset === 0 ? { whole: true as const } : {}),
  });

  function flush(sessionId: string) {
    const s = sessions.get(sessionId);
    if (!s) return;
    clearTimeout(s.timer);
    s.timer = undefined;
    const deltas: HostDelta[] = [];
    for (const b of s.blocks.values()) {
      if (!b.pending) continue;
      deltas.push(frame(b, b.pending.offset, b.pending.text));
      b.pending = undefined;
    }
    const epoch = d.epoch(sessionId);
    if (!deltas.length || epoch === undefined || now() >= s.until || d.buffered() > d.holdBytes) return; // dropped
    d.send({ t: 'delta', sessionId, epoch, deltas });
  }

  return {
    /** Someone watches the session until `until`. */
    watch(sessionId: string, until: number) {
      of(sessionId).until = until;
    },

    /** A delta the mirror heard from the session's writer. */
    delta(sessionId: string, delta: JournalDelta) {
      const key = blockKey(delta.type, (delta.data ?? {}) as Keyed);
      const text = textOf(delta);
      if (!key || text === undefined) return;
      const s = of(sessionId);
      let b = s.blocks.get(key);
      if (!b) s.blocks.set(key, (b = { first: delta, text: '', length: 0 }));
      const offset = b.length;
      b.length += text.length;
      if (b.text !== undefined) b.text = b.text.length + text.length > keepBytes ? undefined : b.text + text;
      if (now() >= s.until) return void (b.pending = undefined);
      if (b.pending) b.pending.text += text;
      else b.pending = { offset, text };
      if (!s.timer) {
        s.timer = setTimeout(() => flush(sessionId), mergeMs);
        s.timer.unref?.();
      }
    },

    /** An event of the session: a completed block (and a turn's text blocks, at its end) is forgotten, its unsent deltas with it. */
    event(sessionId: string, e: JournalEvent) {
      const s = sessions.get(sessionId);
      if (!s?.blocks.size) return;
      if (COMPLETES.has(e.type)) {
        const k = blockKey(e.type, (e.data ?? {}) as Keyed);
        if (k) s.blocks.delete(k);
      } else if (ENDS_TURN.has(e.type) && e.turnId) {
        for (const [k, b] of s.blocks) if (b.first.turnId === e.turnId && (k.startsWith('m:') || k.startsWith('r:'))) s.blocks.delete(k);
      }
    },

    /** `block`: the block so far, at once, to every watcher. Nothing for a block that is closed, unknown or too long to keep. */
    block(sessionId: string, blockId: string) {
      const s = sessions.get(sessionId);
      const b = s && (s.blocks.get(`m:${blockId}`) ?? s.blocks.get(`r:${blockId}`) ?? s.blocks.get(`t:${blockId}`));
      const epoch = d.epoch(sessionId);
      if (!s || !b || b.text === undefined || epoch === undefined || now() >= s.until) return;
      b.pending = undefined;
      if (d.buffered() > d.holdBytes) return;
      d.send({ t: 'delta', sessionId, epoch, deltas: [frame(b, 0, b.text)] });
    },

    /** The mirror subscribes to the session's writer again: its catch-up deltas say each open block's text so far. */
    reset(sessionId: string) {
      const s = sessions.get(sessionId);
      if (!s) return;
      clearTimeout(s.timer);
      s.timer = undefined;
      s.blocks.clear();
    },

    /** The session has no writer any more. */
    forget(sessionId: string) {
      clearTimeout(sessions.get(sessionId)?.timer);
      sessions.delete(sessionId);
    },

    stop() {
      for (const s of sessions.values()) clearTimeout(s.timer);
      sessions.clear();
    },
  };
}

export type DeltaLink = ReturnType<typeof deltaLink>;
