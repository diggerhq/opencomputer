// Computer's contract, the part tracks and threads added (spec 36.3): its RPC methods and their values.
// Types only; nothing here runs.

import type { SessionSettings } from "../../api-objects/objects.js";
import type { Access, Principal } from "../../auth/principal.js";
import type { RoleSpec, SessionRow } from "../org/contract.js";
import type { AssertedApiKey } from "../../edge/auth.js";

// ------------------------------------------------------------------ Computer (36.3)

export type StartSpec = { session: SessionRow; settings: SessionSettings; role: RoleSpec | null; harness?: string; trace?: string };
/**
 * What the Slack actor carries over from Computer at cutover (spec 43.1): the install's settings (the bot token
 * sealed, as stored), the people the machine knows and their links to members. Nothing of a thread or a session.
 */
export interface SlackCarry {
  settings: Record<string, string>;
  people: { slack_user_id: string; dir: string; git_name: string; git_email: string; updated_at: number }[];
  links: { slackUser: string; member: string }[];
}

export interface AccessCarry {
  accessDefault: "open" | "owner" | null;
  apiAccessDefault: "owner" | "org" | null;
}

export interface ComputerRpcAdded {
  start(spec: StartSpec): Promise<void>;
  stop(sessionId: string): Promise<void>;
  /** SessionLog's owed `drain` only: the session's drain is owed here; resolves once delivered, or waiting for the host. */
  drain(sessionId: string): Promise<void>;
  watch(sessionId: string, until: number): Promise<void>;
  /** "Send this block so far." */
  block(sessionId: string, blockId: string): Promise<void>;
  /** Org only; relayed as the host's `access` frame. */
  setAccess(sessionId: string, access: Access, admins: string[]): Promise<void>;
  /**
   * The Slack actor only. `args`: the command's text after its name; for `grant`, the clicked button's action
   * id, with Slack's `triggerId`. `channelId` and `threadTs`: where the command was sent (absent: the
   * session's thread). `link`: `!link <code>`, whose code ModelAccess holds; `member` is the dashboard user
   * it linked the Slack person to.
   */
  command(
    p: Principal,
    c: { name: "secret" | "var" | "claude" | "codex" | "grant" | "link"; args: string; sessionId?: string; channelId?: string; threadTs?: string; triggerId?: string },
  ): Promise<{ reply: string; member?: string }>;
  /** Org: the knowledge repository; Slack: people or credentials. */
  changed(source: "org" | "slack"): Promise<void>;
  /** The Slack actor only, once: spec 43.1. */
  slackCarry(): Promise<SlackCarry>;
  /** Org only, once: the organization's default access as this Computer held it (settings `accessDefault`, `apiAccessDefault`); null where it held none. */
  accessCarry(): Promise<AccessCarry>;
  /**
   * The Slack actor only: an interaction whose state is Computer's (secret, variable, connection and
   * subscription modals and their buttons: a `view_submission`, `s:`, `cn:`, `v:`, `mc:connect`,
   * `md:disconnect`, `cx:connect`, `cx:disconnect`). `sessionId`: a `v:` button's session. The reply is
   * the modal's answer: `errors` keep it open, `view` replaces it.
   */
  interaction(p: Principal, c: { interaction: unknown; sessionId?: string }): Promise<SlackModalReply>;
  /** The Slack actor only: a person left the workspace, was deactivated or became a guest; their subscriptions go. */
  memberLeft(slackUserId: string): Promise<void>;
}

/** A Slack modal's answer, as the edge returns it to Slack. */
export interface SlackModalReply {
  errors?: Record<string, string>;
  view?: Record<string, unknown>;
}

// ------------------------------------------------------------------ the Computer's own routes (computerApi)

/**
 * A request to the Computer's own routes: who asks is the one principal (spec 34.3); the rest
 * are facts of the request (the person's name and email, the key a ticket names).
 */
export interface ApiRequest {
  principal: Principal;
  name: string | null;
  email: string | null;
  client: string | null;
  apiKey?: AssertedApiKey;
  requestId: string;
  userAgent?: string | null;
}

export type ApiOp =
  | { op: "me" }
  | { op: "ticket"; body: unknown };

export interface ApiErrorReply {
  code: string;
  message: string;
  retryable?: boolean;
  [field: string]: unknown;
}

export interface ApiReply {
  status: number;
  body?: unknown;
  error?: ApiErrorReply;
}

/** What the dashboard shows of a machine's state; Org's `MachineState`. */
export type PublicComputerState = "provisioning" | "ready" | "parked" | "waking" | "failed" | "deleting";
