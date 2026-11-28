// The shape of a Session (session.ts): what it persists about its
// conversation, and the observers a hosting process gives it.

import type { CheckoutResult, EffortLevel, PermissionMode, SecretRequest, Speed } from '../protocol.js';
import type { SessionTap } from './api/tap.js';
import type { HarnessEvent } from './harness/types.js';
import type { PreviewHooks } from './preview.js';
import type { PromptGuard } from './prompt-guard.js';
import type { SessionSecrets } from './session-secrets.js';
import type { TurnEvents } from './turn-events.js';
import type { Work } from './work.js';

export interface SessionInfo {
  key: string;
  kind: 'thread' | 'channel'; // a session created over the API (work 084) is a 'thread' with no channel
  channel?: string;
  threadTs?: string;
  userId?: string;
  teamId?: string;
  cwd: string;
  title: string;
  /** A person set the title (the API's sessions.update): the computer's naming (work 093) leaves it alone. */
  renamed?: boolean;
  mode: PermissionMode;
  model?: string;
  effort?: EffortLevel; // `!effort` (model-switch.ts); DEFAULT_EFFORT without
  speed?: Speed; // `!speed` (model-switch.ts); fast without
  sdkSessionId?: string;
}

/** Observers for a process that hosts the session (the runner reports these to its host). */
export interface SessionHooks {
  /** The turn started (true) or finished rendering (false). */
  busy?(busy: boolean): void;
  /** Model output for the current turn arrived (first stream event or assistant message). */
  output?(): void;
  /** The public API as this session's agent (work 118, section 41); offers the tools that reach the cloud when set. */
  work?: Work;
  previews?: PreviewHooks; // public URLs for the session's servers (work 074); offers preview and unpreview
  /** The session's secrets (work 046): usable by commands, redacted from everything posted. */
  secrets?: SessionSecrets;
  /** Withholds copies of Calvin's own prompt from streamed text (Slack calls are guarded at the client). */
  guard?: PromptGuard;
  /** Ask the person for a secret through the gateway; offers the request_secret tool when set. */
  requestSecret?(req: SecretRequest): Promise<void>;
  /** Check out workspace repositories through the host (work 056); offers the checkout_repo tool when set. */
  checkout?(repos: string[]): Promise<CheckoutResult[]>;
  /** `!restart`: exit once the turn is over, so the next message starts on the deployed code and resumes. */
  restart?(): void;
  event?(e: HarnessEvent): void; // every harness record, as the runner watches for refusals (out of credits, a denied model)
  turns?: TurnEvents; // telemetry (work 054): reports turns as facts, never steers them
  api?: SessionTap; // the session's API journal (work 084, api/tap.ts): hears turns, never steers them
}
