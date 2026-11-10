// perf-check's resume scenario (084 perf fix 5): how long a claim waits for
// the session's journal when the session already has a long history. A
// runner's claim links the API writer (runner/main.ts `link` → attachApi:
// the journal's lock, its load, the API socket) before it answers, so this is
// on the path to the first reply.
//
// The history is the perf run's own turns (what the tap journaled, redacted),
// appended again under new turn ids until the journal holds `bytes`, then
// released the way an exiting runner releases it. Each claim is a fresh
// Session attached to it and closed again; the result is their p50, beside the
// same on a journal of a few turns.

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionLog } from '../api/session-log.js';
import { mintId } from '../session-ids.js';
import type { JournalEvent } from '../protocol.js';
import { attachApi } from '../runner/api/attach.js';
import { fakeSession } from '../runner/api/testing.js';

const OWNER = { slackUserId: 'U1', userId: 'usr_ann', name: 'Ann' } as never;
const SEED = (sessionId: string) => ({ sessionId, owner: { id: 'usr_ann', name: 'Ann', email: null } });

/** A journal at `file` holding `turns` (events of whole turns), repeated until it is at least `bytes` long. */
async function grow(file: string, sessionId: string, turns: JournalEvent[], bytes: number) {
  const log = await SessionLog.open(file, { sessionId, epoch: 1, lastSeq: 0, seed: SEED(sessionId) });
  const ids = new Map<string, string>();
  do {
    ids.clear();
    for (const e of turns) {
      const turnId = e.turnId && (ids.get(e.turnId) ?? ids.set(e.turnId, mintId('tn')).get(e.turnId)!);
      log.append(e.type as never, e.data as never, { turnId: turnId ?? null, actor: e.actor });
    }
  } while (log.journal.size < bytes);
  await log.release();
  return log.lastSeq;
}

/** Milliseconds from a claim's start to its API writer serving, `n` times. */
async function claims(dir: string, file: string, sessionId: string, lastSeq: number, n: number, redact: (s: string) => string) {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = fakeSession([], { fresh: true });
    const spec = { sessionId, journal: file, epoch: 1, lastSeq, socket: path.join(dir, `claim${i}.sock`), token: 'tok' };
    const t0 = performance.now();
    const a = await attachApi(spec, t.sess, { owner: OWNER, redact, suspend: () => {} });
    ms.push(performance.now() - t0);
    await a.close();
    t.sess.kill?.();
  }
  return ms.sort((x, y) => x - y)[Math.floor(n / 2)];
}

export interface ResumeResult {
  /** The long journal's bytes, and a claim's p50 on it and on a journal of only `turns`. */
  bytes: number;
  claimMs: number;
  smallClaimMs: number;
}

export async function resumeClaim(turns: JournalEvent[], o: { bytes: number; claims: number; redact: (s: string) => string }): Promise<ResumeResult> {
  const dir = mkdtempSync(path.join(tmpdir(), 'perf-resume-'));
  // The lock's holder is unreferenced (journal-lock.ts): with nothing else alive, a release's wait for it would end the process.
  const alive = setInterval(() => {}, 60_000);
  try {
    const [small, big] = [mintId('cs'), mintId('cs')];
    const file = (sessionId: string) => path.join(dir, `${sessionId}.jsonl`);
    const smallSeq = await grow(file(small), small, turns, 0);
    const bigSeq = await grow(file(big), big, turns, o.bytes);
    return {
      bytes: statSync(file(big)).size,
      smallClaimMs: await claims(dir, file(small), small, smallSeq, o.claims, o.redact),
      claimMs: await claims(dir, file(big), big, bigSeq, o.claims, o.redact),
    };
  } finally {
    clearInterval(alive);
    rmSync(dir, { recursive: true, force: true });
  }
}
