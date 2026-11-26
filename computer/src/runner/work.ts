// What a tool that reaches the cloud works with (work 118, section 41): the
// API client, the session it speaks for, and the few shapes every such tool
// shares: an id minted here, a mutation with the tool call's id as its
// Idempotency-Key, a refusal said in a sentence.
//
// Invariants: `session()` is read when a tool runs, never when the list is
// built (a spare's tools exist before its session); a tool never throws, it
// answers a failed result.

import { randomUUID } from 'node:crypto';
import { CloudError, type CloudApi } from './cloud.js';
import type { RoleSpec } from '../protocol.js';
import { CROCKFORD } from '../session-ids.js';
import type { ToolCall, ToolResult } from './tool.js';

export interface WorkSession {
  /** The session's public id (`cs_`). */
  id: string;
  role?: RoleSpec | null;
  /** The Slack thread it was started in, as `team:channel:ts`; absent for a session with no Slack surface. */
  slackThread?: string;
}

export interface Work {
  api: CloudApi;
  session(): WorkSession;
}

export const SID = /^cs_[0-9a-hjkmnp-tv-z]{16}$/;
export const TID = /^trk_[0-9a-hjkmnp-tv-z]{16}$/;

/** A cloud id: the prefix and 16 Crockford base32 characters. */
export function workId(prefix: 'trk' | 'cs' | 'res' | 'prp'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${Array.from(bytes, (b) => CROCKFORD[b % 32]).join('')}`;
}

export const said = (text: string, isError = false): ToolResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });

/** The Idempotency-Key of a tool call's write: the call's id, with `part` when one call writes twice. */
export const keyOf = (call: ToolCall | undefined, part = ''): string => `${call?.id ?? randomUUID()}${part && `:${part}`}`;

/** Why the API refused, for the model. */
export function refusal(e: unknown): string {
  if (e instanceof CloudError) return e.reason && e.reason !== e.code ? `${e.message} (${e.code}: ${e.reason})` : `${e.message} (${e.code})`;
  return e instanceof Error ? e.message : String(e);
}

/** Runs a tool's body; a refusal or a failure is a failed result that says why. */
export async function answer(what: string, run: () => Promise<string>): Promise<ToolResult> {
  try {
    return said(await run());
  } catch (e) {
    return said(`${what}: ${refusal(e)}`, true);
  }
}

/** A role this tool is not for: the cloud refuses it too, this only says it sooner. */
export function notFor(w: Work, tool: string, roles: { track?: false; thread?: false }): string | undefined {
  const track = w.session().role?.name === 'track';
  if (track && roles.track === false) return `${tool} is not for a track's own session`;
  if (!track && roles.thread === false) return `${tool} is for a track's own session`;
  return undefined;
}
