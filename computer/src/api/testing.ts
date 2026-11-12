// Test helpers for the session log (work 084): a SessionLog in a temp dir, and
// event checks against the API schema. Imported by *.test.ts only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Schema } from 'effect';
import type { ApiActor, JournalEvent } from '../protocol.js';
import { mintId } from '../session-ids.js';
import { ensureSessionJournalDir, journalPath } from './journal.js';
import { EVENT_DATA, Event } from './schema-events.js';
import { SessionLog, type SessionLogOpen } from './session-log.js';

export const ANN: ApiActor = { id: 'usr_ann', name: 'Ann', via: 'api', client: 'test/1' };
export const ANN_CTX = { actor: ANN, member: 'usr_ann' };

/** A fresh data dir and session id; `cleanup` removes the dir. */
export function tempSession() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-'));
  const sessionId = mintId('cs');
  ensureSessionJournalDir(dir, sessionId);
  return { dir, sessionId, file: journalPath(dir, sessionId), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function openLog(file: string, sessionId: string, o: Partial<SessionLogOpen> = {}): Promise<SessionLog> {
  return SessionLog.open(file, {
    sessionId,
    epoch: 1,
    lastSeq: 0,
    seed: { sessionId, owner: { id: 'usr_ann', name: 'Ann', email: null } },
    ...o,
  });
}

/** Throws unless `e` is a valid Event and, for a known type, its data is exactly EVENT_DATA's shape. */
export function assertEvent(e: JournalEvent): void {
  Schema.decodeUnknownSync(Event)(e);
  const known = (EVENT_DATA as Record<string, Schema.Top>)[e.type];
  if (known) Schema.decodeUnknownSync(known as unknown as Schema.Codec<unknown, unknown>)(e.data, { onExcessProperty: 'error' });
}

/** A turn's worth of events: received, started, a text block, completed. */
export function turn(log: SessionLog, input = 'hi', text = 'ok'): string {
  const t = mintId('tn');
  log.append('message.received', { input, ifBusy: 'queue', delivery: 'started', interruptedTurnIds: [], declinedAskIds: [] }, { turnId: t, actor: ANN });
  log.append('turn.started', { model: null, effort: null, mode: null, trigger: 'message', subagentId: null }, { turnId: t, actor: ANN });
  log.append('message.completed', { blockId: `b-${t}`, parentCallId: null, text }, { turnId: t, actor: ANN });
  log.append('turn.completed', { text, durationMs: 1, silent: false }, { turnId: t, actor: ANN });
  return t;
}

/** A running Subagent object for `subagent.started`. */
export function subagentOf(sessionId: string, turnId: string, over: Record<string, unknown> = {}) {
  return {
    id: mintId('sa'), sessionId, turnId, callId: `c-${turnId}`, name: 'look around', agentType: 'Explore', background: true, status: 'running', activity: null,
    toolCalls: 0, tokens: 0, createdAt: new Date().toISOString(), endedAt: null, durationMs: null, result: null, resultTruncated: false, error: null, stoppedBy: null,
    ...over,
  };
}

/** An open question Ask object for `ask.opened`. */
export function askOf(sessionId: string, turnId: string, over: Record<string, unknown> = {}) {
  return {
    id: mintId('ak'), sessionId, turnId, kind: 'question', status: 'open', createdAt: new Date().toISOString(), closedAt: null, closedBy: null, answer: null,
    approval: null, question: { questions: [] }, secret: null, ...over,
  };
}
