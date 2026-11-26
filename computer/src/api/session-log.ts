// One session's log as its writer holds it (work 084): the journal (the file
// and its lock), the ring of recent events, the fold (the Session, Turn and
// Ask objects) and the hub (subscribers), wired so every writer does the same
// four things in the same order. Both writers build on this: the runner's
// SessionApi (runner/api/api.ts) and the host's session-writer.
//
// Invariants: `append` writes the journal first, then the ring, then the
// fold, then fans out: nobody sees an event the file does not have, and the
// fold is current when a subscriber's onEvent runs. Opening restores the fold
// from the journal's checkpoint and replays the file past it (all of it when
// there is none) into the fold and the ring's tail. A checkpoint is written
// when the journal says one is due, after a turn ends (on the next tick, so
// the fold and the offset are taken at the same moment, off the turn's last
// Slack call and mid-turn streaming), after an open and at release. After `release` nothing appends.

import type { ApiActor, ApiError, JournalDelta, JournalEvent } from '../protocol.js';
import { capabilities } from './capabilities.js';
import type { SessionCreated } from './created.js';
import { Fold, isEnding, SYSTEM_ACTOR, type SessionSeed } from './fold.js';
import { type HubSubscription, Hub, type Sink } from './hub.js';
import { Journal, type JournalOpen } from './journal.js';
import { Ring } from './ring.js';
import type { Turn } from './schema-objects.js';
import type { DetachReason } from './writer.js';

/** `created`: recorded as `session.created` when the journal (and the DO's log) is empty. */
export type SessionLogOpen = JournalOpen & { seed: SessionSeed; ringBytes?: number; created?: SessionCreated };

export class SessionLog {
  readonly ring: Ring;
  readonly fold: Fold;
  readonly hub: Hub;
  /** Resolvers waiting for lastSeq to pass a value (long-polls, minSeq). */
  private waiters = new Set<() => void>();
  private checkpointQueued = false;

  private constructor(
    readonly journal: Journal,
    fold: Fold,
    ring: Ring,
  ) {
    this.ring = ring;
    this.fold = fold;
    this.hub = new Hub(journal, this.ring, () => this.fold.session());
  }

  /** Open (and lock) the journal at `file`, and fold everything in it. */
  static async open(file: string, o: SessionLogOpen): Promise<SessionLog> {
    let fold = new Fold(o.seed);
    const ring = new Ring(o.ringBytes);
    const restore = (state: unknown) => {
      const f = Fold.restore(o.seed, state);
      if (f) fold = f;
      return !!f;
    };
    const apply = (e: JournalEvent, bytes: number) => {
      fold.apply(e);
      ring.push(e, bytes);
    };
    const journal = await Journal.open(file, { ...o, fold: { restore, apply } });
    const log = new SessionLog(journal, fold, ring);
    log.syncFold();
    if (o.created && journal.lastSeq === 0) log.append('session.created', o.created, { actor: SYSTEM_ACTOR });
    log.checkpointSoon();
    return log;
  }

  /** Write the journal's checkpoint now (a fold of every event on file). */
  checkpoint(): void {
    this.journal.checkpoint(this.fold.snapshot());
  }

  private checkpointSoon() {
    if (this.checkpointQueued || !this.journal.checkpointDue) return;
    this.checkpointQueued = true;
    setImmediate(() => {
      this.checkpointQueued = false;
      if (this.journal.checkpointDue) this.checkpoint();
    });
  }

  get sessionId(): string {
    return this.journal.sessionId;
  }

  get lastSeq(): number {
    return this.journal.lastSeq;
  }

  private syncFold() {
    this.fold.setLog({ lastSeq: this.journal.lastSeq, logEpoch: this.journal.epoch, epochStartSeq: this.journal.epochStartSeq });
  }

  /** Record one event: journal, ring, fold, then subscribers. */
  append(type: string, data: unknown, meta: { turnId?: string | null; actor?: ApiActor | null } = {}): JournalEvent {
    const before = this.journal.size;
    const e = this.journal.append(type, data, meta);
    this.ring.push(e, this.journal.size - before);
    this.fold.apply(e);
    this.syncFold();
    this.hub.published(e);
    for (const w of [...this.waiters]) w();
    if (isEnding(type)) this.checkpointSoon();
    return e;
  }

  /** A transient delta for attached subscribers (never journaled). */
  delta(d: Omit<JournalDelta, 'sessionId'>): void {
    if (d.type === 'subagent.progress') this.fold.progress(d.data as Parameters<Fold['progress']>[0]);
    this.hub.delta({ ...d, sessionId: this.sessionId });
  }

  /** Attach: the hub's subscription, its `attached` the full AttachResult less timing (review r1 contract 7). */
  subscribe(o: Sink): HubSubscription | { error: ApiError } {
    const s = this.hub.subscribe(o);
    if ('error' in s) return s;
    const j = this.journal;
    const attached = {
      ...s.attached,
      logEpoch: j.epoch,
      epochStartSeq: j.epochStartSeq || 1,
      capabilities: capabilities(),
      earlierTurns: o.tailTurns ? this.earlierTurns(o.tailTurns) : null,
    };
    return Object.assign(s, { attached });
  }

  /** With `tailTurns`: the turns before the last `n`, newest first, at most 50. */
  earlierTurns(n: number): Turn[] {
    const index = this.journal.turns();
    const cut = Math.max(0, index.length - n);
    return index
      .slice(Math.max(0, cut - 50), cut)
      .reverse()
      .map((t) => this.fold.turn(t.turnId))
      .filter((t): t is Turn => !!t);
  }

  /** Resolves when `ready()` holds after an append, or false after `ms`. */
  waitFor(ready: () => boolean, ms: number): Promise<boolean> {
    if (ready()) return Promise.resolve(true);
    if (ms <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (v: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(v);
      };
      const check = () => ready() && done(true);
      const timer = setTimeout(() => done(ready()), ms);
      this.waiters.add(check);
    });
  }

  /** Detach every subscriber and drop the journal's lock. */
  async release(reason: DetachReason = 'moved'): Promise<void> {
    this.hub.detachAll(reason);
    for (const w of [...this.waiters]) w();
    if (this.journal.checkpointDue) this.checkpoint();
    await this.journal.release();
  }
}
