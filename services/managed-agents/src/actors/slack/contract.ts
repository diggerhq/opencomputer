// The Slack actor's contract (tracks and threads, spec 36.6): its RPC methods and their values.
// Types only; nothing here runs.

import type { Principal } from "../../auth/principal.js";
import type { Reply } from "../../durable/rpc-reply.js";
import type { CalvinPerson } from "../../host-protocol/protocol.js";
import type { SlackResult } from "../../slack-api/web-api.js";
import type { SlackModalReply } from "../computer/contract.js";
import type { SlackEcho } from "../org/contract.js";

// ------------------------------------------------------------------ Slack (36.6)

export interface SlackGrant {
  teamId: string;
  teamName: string;
  botUserId: string;
  botToken: string;
  installerUserId: string;
}

/**
 * What Computer owes Slack about billing (Slack.billing): a refused session's paywall, by plan and
 * halt reason; the warning before the stop (`since`: when its run of warnings began; `sessionId`:
 * the thread to tell when the installer cannot be); the organization admitted again.
 */
export type BillingNotice =
  | { kind: "paywall"; sessionId: string; onPro: boolean; haltReason: string | null }
  | { kind: "warning"; reason: string; since: number | null; sessionId?: string }
  | { kind: "admitted" };

/** `shown`: posted now; `known`: already told, or nobody to tell; `missed`: Slack did not take it, so it may be owed again. */
export type BillingNoticeResult = "shown" | "known" | "missed";

export interface SlackRpc {
  /** Deduplicated, queued; the edge acknowledges Slack after it. */
  accept(e: { kind: "event" | "interaction"; id: string; body: unknown }): Promise<void>;
  /** An interaction, answered while Slack waits: a modal's or its button's goes to Computer; any other is `accept`ed. */
  interact(id: string, interaction: unknown): Promise<SlackModalReply>;
  install(p: Principal, grant: SlackGrant): Promise<void>;
  unlink(p: Principal): Promise<void>;
  // Computer only: it reaches Slack through these and holds no token of its own.
  /** A Web API call made with the bot token; `{ ok: false, error: "not_linked" }` when there is none. */
  api(method: string, body: Record<string, unknown>): Promise<SlackResult>;
  /** A Slack person's principal, or null when Slack does not report them a member of the workspace. Throws when Slack could not be asked. */
  principal(slackUser: string): Promise<Principal | null>;
  /** A Slack person's display name, or their id when Slack does not say. */
  userName(slackUser: string): Promise<string>;
  /** `installer`: who installed the app and the member they are, for Computer's model access (its rekey on install and unlink). */
  forHost(): Promise<{
    people: CalvinPerson[];
    slack: { botToken: string; botUserId: string; teamId: string; teamName?: string; installer?: { slackUser: string; member: string | null } } | null;
  }>;
  /** Computer only, owed: a billing notice, told once (billing-notices.ts). */
  billing(n: BillingNotice): Promise<BillingNoticeResult>;
  /** Org only. Idempotent on `sessionId`. */
  announce(child: { sessionId: string; parent: string; brief: string }): Promise<{ threadKey: string }>;
  /** Org only, the echo of an occurrence (spec 40.6). */
  notify(e: SlackEcho): Promise<void>;
  /** post_thread. */
  post(p: Principal, threadKey: string, text: string): Promise<Reply<{ ts: string }>>;

  // The install's edges, moved from Computer with the install (the edge's Slack routes call them).
  /** A nonce for the install's OAuth state, bound to the person starting it; ten minutes. */
  startInstall(p: Principal, nonce: string): Promise<void>;
  /** Spends an install nonce, once: the subject that started it. */
  consumeInstall(nonce: string): Promise<{ ok: true; subject: string } | { ok: false; reason: "invalid_state" | "state_expired" }>;
  /** Unlinks when Slack says the bot token is dead (asked with the token itself). Whether it did. */
  unlinkRevoked(teamId: string): Promise<{ unlinked: boolean }>;
  /** Someone in this workspace tried to link it to another organization: they and the installer are told. */
  joinRequest(teamId: string, requesterUserId: string): Promise<{ installerNotified: boolean }>;
  // The team router: the Slack object named `slack-team:<teamId>` holds which organization a workspace links to.
  claimTeam(teamId: string, org: string): Promise<{ ok: true } | { ok: false; holder: string }>;
  teamOrg(): Promise<string | null>;
  releaseTeam(org: string): Promise<void>;
}
