// A session as the gateway describes it to the host, and as the host reports it back.

import type { CalvinPerson } from "./person.js";

export type CalvinMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface CalvinSessionSpec {
  /** Internal runner key: `team:channel:ts` for a Slack thread; work 084: the `cs_` id for a session with no thread. Never on the API. */
  key: string;
  /** Work 084: `api` for a session with no Slack binding. */
  kind: "thread" | "channel" | "api";
  /** Absent for `kind: "api"` (work 084: the runner renders nowhere); always set for Slack sessions. */
  channel?: string;
  /** Work 084: the public id, `cs_` + 16. */
  sessionId?: string;
  /** Work 084: where the session started, for the API (`slack | opc | dashboard | api`). */
  origin?: { type: string; client?: string };
  metadata?: Record<string, string>;
  threadTs?: string;
  owner: CalvinPerson;
  teamId?: string;
  title: string;
  mode: CalvinMode;
  model?: string;
  /** Work 084: the session's reasoning effort, as calvin persists it; absent = the default. */
  effort?: string;
  /** The session's speed, as calvin persists it; absent = the default (fast). */
  speed?: "fast" | "standard";
  /** The agent's conversation, as the runner last reported it: the runner resumes it, and starts a new one without. */
  sdkSessionId?: string;
  /** Not sent: the host chooses the runner's directory. */
  forkPath?: string;
  /**
   * Work 082: which agent runs the session's turns. Absent = claude. Set to
   * `codex` only with a `chatgpt` subscription route; a managed route never
   * carries it.
   */
  harness?: CalvinHarness;
  /** Protocol 6: a track's own session, or the one a person's start box opened. */
  role?: CalvinRoleSpec | null;
}

export type CalvinRoleSpec = { name: "track"; trackId: string } | { name: "start" };

/** Work 082: the agent a session runs. */
export type CalvinHarness = "claude" | "codex";

export type CalvinSessionStatus = "starting" | "idle" | "busy" | "stopped" | "error";

export interface CalvinSessionReport {
  key: string;
  /** Work 084: the `cs_` id, when the session has one. */
  sessionId?: string;
  status: CalvinSessionStatus;
  sdkSessionId?: string;
  forkPath?: string;
  runnerVersion?: string;
  model?: string;
  mode?: CalvinMode;
  /** The session's speed as the runner has it (a `!speed` change included); absent = unchanged. */
  speed?: "fast" | "standard";
  error?: string;
  /** Work 084: running subagents (absent = 0); the host never idle-exits a runner with any. */
  subagents?: number;
}

/** Who may attach to a session; `members: null` is every member of the organization. */
export interface CalvinSessionAccess {
  sessionId: string;
  owner: string;
  members: string[] | null;
  /** The organization's admins (`usr_…`), who may also open terminals in the session; attaching follows `members`. */
  admins?: string[];
}

export type CalvinApiSessionStatus = "starting" | "running" | "waiting" | "idle" | "suspended";
