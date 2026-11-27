// The gateway side of Calvin's host protocol (calvin src/protocol.ts, branch
// feat/computer-per-org; dash-cal's calvin-protocol.ts was the first
// gateway-side port). One JSON object per WebSocket frame; unknown `t`
// values are ignored by both sides, so either may be newer. Only the shapes
// this gateway sends or reads are declared here.

// Protocol 6 (tracks and threads, spec 36.3) is the one number both sides speak: a host that says
// less in `hello` is closed with 4426 and updates itself. Sessions are started with `start`
// (carrying `role`) and written to with `api` frames (carrying what the runner needs: `secrets`,
// `model`); `watch` and `block` go to the host, `delta` comes from it; model traffic goes through
// the host's model proxy by profile.

import type { CalvinApiActor, CalvinApiError, CalvinDelta, CalvinJournalEvent, CalvinJournalReport } from "./api-shapes.js";
import type { CalvinGitHubToken, CalvinHostCredentials } from "./credentials.js";
import type { ModelProfile, ModelProvider, ModelRequest, ModelObserved, ModelResponse, ModelRoute, ModelUsage } from "./model.js";
import type { CalvinPerson } from "./person.js";
import type { CalvinPreviewConfig, CalvinPreviewRequest, CalvinPreviewResult } from "./previews.js";
import type { SecretRequest, SessionSecret } from "./secrets.js";
import type { CalvinApiSessionStatus, CalvinHarness, CalvinRoleSpec, CalvinSessionAccess, CalvinSessionReport, CalvinSessionSpec } from "./session.js";
import type { WorkspaceDefinition } from "./workspace.js";

export const CALVIN_PROTOCOL_VERSION = 6;
/** The close code of a host below CALVIN_PROTOCOL_VERSION: it runs its self-update at once. */
export const UPGRADE_REQUIRED = 4426;

export type CalvinGatewayToHost =
  | {
      t: "welcome";
      protocol: number;
      credentials: CalvinHostCredentials;
      people: CalvinPerson[];
      definition?: WorkspaceDefinition;
      /** Work 054: a signed credential for the telemetry collector, renewed on every hello. Absent: keep the current one. */
      telemetryCredential?: string;
      /** The collector base URL, with the credential; for hosts whose host.env has none. */
      telemetryUrl?: string;
      /** Work 074: this computer's previews. Absent: its tunnel is not provisioned yet; keep cloudflared stopped. */
      preview?: CalvinPreviewConfig;
      /** Work 084: the relay's edge key. Absent: the wire is off on this computer. */
      wire?: CalvinWireConfig;
      /** The route of a session whose own delivery carries none, by harness. */
      models?: Partial<Record<CalvinHarness, ModelRoute>>;
    }
  /** Work 074: the previews config changed (tunnel provisioned, a port registered or released). Sent before the `previewed` it causes. */
  | { t: "previews"; preview: CalvinPreviewConfig }
  | { t: "people"; people: CalvinPerson[] }
  /** `models` replaces the whole map of the `welcome`. */
  | { t: "credentials"; credentials: CalvinHostCredentials; models?: Partial<Record<CalvinHarness, ModelRoute>> }
  | { t: "secrets"; sessionKey: string; secrets: SessionSecret[] }
  /** Work 077: a live session's model route changed. The host ignores sessions it does not run. */
  | { t: "model"; sessionKey: string; model: ModelRoute }
  /**
   * Work 077: check a Claude setup token through the host's model proxy; answered by `probed`.
   * Work 082 adds `provider` and `accountId` (absent: anthropic); blue does not probe chatgpt yet.
   */
  | { t: "probe"; id: string; token: string; provider?: ModelProvider; accountId?: string }
  | { t: "token"; id: string; result?: CalvinGitHubToken; error?: string }
  /** Work 074: answers `preview` and `unpreview`; `error` is a sentence for the model. */
  | { t: "previewed"; id: string; result?: CalvinPreviewResult; error?: string }
  | { t: "secret-asked"; id: string; error?: string }
  /** Work 080: answers `connection-request` once the button is posted. */
  | { t: "connection-asked"; id: string; error?: string }
  /**
   * Warm pool (work 052): a pool computer was claimed by an organization.
   * The host persists the new identity (organization id, host token, the
   * organization's gateway URL) and reconnects with it; its next `hello`
   * arrives at the organization's object.
   */
  | { t: "assign"; organizationId: string; hostToken: string; gatewayUrl: string }
  | CalvinGatewayToHostV4
  | CalvinGatewayToHostV5;

export type CalvinHostToGateway =
  /** `features`: what this host can do; `model-proxy` (work 077) means subscription routes may go to it. */
  /** `journals` (work 084): every session journal on the host's disk, so the gateway sends `epoch` for the ones it is ahead on. */
  /** `profiles` (work 097): the model proxy's, while the host is connected to it; a change re-sends the hello. */
  | {
      t: "hello";
      protocol: number;
      hostId: string;
      version: string;
      sessions: CalvinSessionReport[];
      features?: string[];
      journals?: CalvinJournalReport[];
      profiles?: ModelProfile[];
    }
  | { t: "session"; report: CalvinSessionReport }
  | { t: "workspace"; status: unknown }
  /** `/data`'s size and free space, every 5 minutes (work 071): the disk grows near capacity (disk-growth.ts). */
  | { t: "disk"; totalBytes: number; freeBytes: number }
  /**
   * `kind` "opencomputer" asks for a one-hour OpenComputer key, "automation-repo"
   * for a one-hour push credential to the organization's automations
   * repository (work 067); GitHub otherwise.
   */
  | {
      t: "token";
      id: string;
      sessionKey?: string;
      repos?: string[];
      kind?: "github" | "opencomputer" | "automation-repo";
    }
  /** Work 074: register a port's public URL (`preview` tool), or release a name (`unpreview`). */
  | { t: "preview"; id: string; from: string; req: CalvinPreviewRequest }
  | { t: "unpreview"; id: string; from: string; req: { name: string } }
  | { t: "secret-request"; id: string; from: string; req: SecretRequest }
  /** Work 080: request_connection, a "Grant …" button in the session's thread. */
  | { t: "connection-request"; id: string; from: string; req: { service: string; reason: string } }
  /** The model provider refused session `sessionKey`'s turn for credits (a 402). */
  | { t: "out-of-credits"; sessionKey: string }
  /** Work 077: the model proxy's answers and reports, relayed by the host. */
  | { t: "probed"; id: string; result?: { status: number; usage?: ModelUsage }; error?: string }
  /** Protocol 4: `subscription` or `managed`, with `fingerprint`. Protocol 5: `profile`, with `profile` and `key`. `refuse` in both. */
  | { t: "model-bound"; sessionKey: string; mode: "subscription" | "managed" | "profile" | "refuse"; fingerprint?: string; profile?: string; key?: string }
  | {
      t: "model-health";
      sessionKey: string;
      fingerprint: string;
      /** Work 082: whose upstream answered (absent: anthropic). For chatgpt, `unauthorized` asks blue for a refresh. */
      provider?: ModelProvider;
      status: "ok" | "limited" | "unauthorized" | "error";
      /** Epoch ms. */
      limitedUntil?: number;
      errorClass?: string;
      usage?: ModelUsage;
    }
  | { t: "model-denied"; sessionKey: string; model: string; fallbackTo: string }
  | CalvinHostToGatewayV4
  | CalvinHostToGatewayV5;

export interface CalvinWireConfig {
  /** base64url, 32 bytes: verifies X-Wire-Auth. Today the previews key. */
  key: string;
}

/** One attachment of a turn's message (work 126): the metadata Org reserved; the bytes are at `GET …/attachments/{id}/content`. */
export interface CalvinApiAttachment {
  id: string;
  name: string;
  mimetype: string;
  bytes: number;
}

export type CalvinGatewayToHostV4 =
  /** Claim and fork for `session` with no input; answered by `started`. */
  | {
      t: "start";
      id: string;
      session: CalvinSessionSpec;
      role?: CalvinRoleSpec | null;
      epoch: number;
      lastSeq: number;
      credentials?: CalvinHostCredentials;
      secrets?: SessionSecret[];
      model?: ModelRoute;
    }
  /** An HTTP route's operation, named by its WebSocket method; answered by `api-result` (15 s here). */
  | {
      t: "api";
      id: string;
      sessionId: string;
      method: string;
      params: unknown;
      /** A turn's attachments (work 126): what the message carries, beside `params` (the runner takes an unknown param as an error). */
      attachments?: CalvinApiAttachment[];
      actor: CalvinApiActor;
      member: string;
      idempotencyKey?: string;
      requestId?: string;
      session?: CalvinSessionSpec;
      epoch?: number;
      lastSeq?: number;
      credentials?: CalvinHostCredentials;
      secrets?: SessionSecret[];
      model?: ModelRoute;
    }
  /** Protocol 6: someone watches the session until `until` (ms): its deltas come up as `delta` frames until then. */
  | { t: "watch"; sessionId: string; until: number }
  /** Protocol 6: "send this block so far". */
  | { t: "block"; sessionId: string; blockId: string }
  /** The SessionLog stored every event of `epoch` up to `seq`. */
  | { t: "journal-ack"; sessionId: string; epoch: number; seq: number }
  /**
   * The only frame that moves a session's epoch on a host (recovery-fix.md): the log is at `epoch`,
   * begun at `startSeq`; `tail` is every stored event `startSeq..lastSeq`, verbatim (≤ 1000). Sent
   * after a recovery, after `hello` for each listed journal the log is ahead of, and on a
   * `stale_epoch` batch (≤ once per session per 5 s). Before any other frame carrying that epoch.
   */
  | { t: "epoch"; sessionId: string; epoch: number; startSeq: number; lastSeq: number; tail: CalvinJournalEvent[] }
  | { t: "access"; access: CalvinSessionAccess }
  | { t: "revoked"; keyId: string };

export type CalvinHostToGatewayV4 =
  | { t: "started"; id: string; sessionId: string; status: CalvinApiSessionStatus; error?: CalvinApiError }
  | { t: "api-result"; id: string; result?: unknown; error?: CalvinApiError }
  /** The mirror: the next events of `sessionId` under `epoch`, in seq order, at least once. */
  | { t: "journal"; sessionId: string; epoch: number; events: CalvinJournalEvent[] }
  /**
   * Blue's proposal (subagents.md; requests-calvin.md): the latest `subagent.progress` values of a
   * session's running subagents, folded by the host, at most once a second per session. Never
   * journaled; the SessionLog merges them into reads. A host that never sends it leaves reads at
   * the started/ended values.
   */
  | { t: "subagent-progress"; sessionId: string; epoch: number; progress: Array<{ subagentId: string; activity: string | null; toolCalls: number; tokens: number }> }
  /**
   * A send the host's writer queued for a session the host has no spec of (none came since it booted):
   * answered with `start`, as for a session created without a message. Ignored for an unknown session.
   */
  | { t: "wake"; sessionId: string }
  /** Protocol 6: a watched session's deltas, in order. Never acknowledged, never stored. */
  | { t: "delta"; sessionId: string; epoch: number; deltas: CalvinDelta[] };

export type CalvinGatewayToHostV5 = { t: "model-request" } & ModelRequest;

export type CalvinHostToGatewayV5 = ({ t: "model-observed" } & ModelObserved) | ({ t: "model-response" } & ModelResponse);
