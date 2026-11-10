// Connections granted to the computer from Slack (work
// 080, step 3). A session asks with request_connection; the gateway posts a
// button in its thread. Whoever clicks it sees, in a private modal, only
// their own connections for that service (through their `!link` to the
// dashboard), and grants one to this thread or to all their threads. The
// grant is checked again on submit: nobody grants a connection they do not
// own, so the button carries no authority and forwarding it gives nothing.
// Grants for everyone are an admin's, from the dashboard or the CLI.

import { base64UrlToBytes, bytesToBase64Url } from "./crypto.js";
import type { SlackResult } from "./slack.js";

export const CONNECTION_VIEW = "computer_connection";
// GitHub is not here: the computer uses the organization's GitHub App.
export const CONNECTION_SERVICES = ["linear", "gmail", "calendar", "drive", "sheets"] as const;
const PREFIX = "cn:";

export interface ConnectionRequest {
  service: string;
  reason: string;
}

/** One of the clicker's own connections that can be granted for the service. */
export interface GrantableConnection {
  id: string;
  label: string;
  displayName?: string;
}

export type GrantScope = "session" | "user";

interface Session {
  key: string;
  ownerId: string;
  channelId: string;
  threadTs: string;
}

export interface ConnectionDeps {
  slack: (method: string, body: Record<string, unknown>) => Promise<SlackResult>;
  session: (key: string) => Session | undefined;
  /** The dashboard user a Slack user linked with `!link`. */
  linkOfSlack: (slackUserId: string) => string | undefined;
  grantable: (dashboardUserId: string, service: string) => Promise<GrantableConnection[]>;
  /** Grants a connection the dashboard user owns; throws when they do not, or it cannot be granted. */
  grant: (input: { connectionId: string; ownerUserId: string; scope: GrantScope; subject: string; grantedBy: string }) => Promise<void>;
  wake: (session: Session, userId: string, text: string, ts: string) => Promise<void>;
  /** https://app.opencomputer.dev */
  origin: () => string;
}

/** What the button carries: the session and the service. */
interface ButtonData {
  k: string;
  s: string;
}

/** Where the modal was opened from. */
interface ModalData extends ButtonData {
  ch?: string;
  th?: string;
  rq?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const connectionButtonId = (d: ButtonData) => `${PREFIX}${bytesToBase64Url(encoder.encode(JSON.stringify(d)))}`;

export function decodeConnectionButtonId(actionId: string): ButtonData | null {
  if (!actionId.startsWith(PREFIX)) return null;
  try {
    const d = JSON.parse(decoder.decode(base64UrlToBytes(actionId.slice(PREFIX.length)))) as ButtonData;
    return typeof d?.k === "string" && isService(d.s) ? { k: d.k, s: d.s } : null;
  } catch {
    return null;
  }
}

const isService = (s: unknown): s is string => typeof s === "string" && (CONNECTION_SERVICES as readonly string[]).includes(s);

export function serviceName(service: string): string {
  return { linear: "Linear", gmail: "Gmail", calendar: "Google Calendar", drive: "Google Drive", sheets: "Google Sheets" }[service] ?? service;
}

type Block = Record<string, unknown>;
const text = (t: string) => ({ type: "mrkdwn", text: t });
const plain = (t: string) => ({ type: "plain_text", text: t.slice(0, 75) });

export function requestBlocks(d: ButtonData, reason: string): Block[] {
  const name = serviceName(d.s);
  return [
    { type: "section", text: text(`:link: *This session asks to use ${name}*\n${reason.slice(0, 500)}`) },
    { type: "actions", elements: [{ type: "button", text: plain(`Grant ${name}`), action_id: connectionButtonId(d), value: d.s, style: "primary" }] },
    { type: "context", elements: [text("Opens a private form listing your own connections. Nothing is granted until you choose.")] },
  ];
}

function infoModal(title: string, body: string, link?: { label: string; url: string }): Record<string, unknown> {
  return {
    type: "modal",
    title: plain(title.slice(0, 24)),
    close: plain("Close"),
    blocks: [
      { type: "section", text: text(body) },
      ...(link ? [{ type: "actions", elements: [{ type: "button", text: plain(link.label), url: link.url, style: "primary" }] }] : []),
    ],
  };
}

export function grantModal(meta: ModalData, connections: GrantableConnection[], otherOwner?: string): Record<string, unknown> {
  const name = serviceName(meta.s);
  const conns = connections.map((c) => ({
    value: c.id,
    text: plain(c.label),
    ...(c.displayName ? { description: plain(c.displayName) } : {}),
  }));
  const scopes = [
    { value: "session", text: "This thread", description: "Only this session" },
    { value: "user", text: "All my threads", description: otherOwner ? `Your sessions (not this one: it is <@${otherOwner}>'s)` : "Every session you start, until you revoke it" },
  ].map((o) => ({ value: o.value, text: plain(o.text), description: text(o.description) }));
  return {
    type: "modal",
    callback_id: CONNECTION_VIEW,
    private_metadata: JSON.stringify(meta),
    title: plain(`Grant ${name}`.slice(0, 24)),
    submit: plain("Grant"),
    close: plain("Cancel"),
    blocks: [
      { type: "input", block_id: "conn", label: plain("Connection"), element: { type: "radio_buttons", action_id: "v", options: conns, initial_option: conns[0] } },
      { type: "input", block_id: "scope", label: plain("For"), element: { type: "radio_buttons", action_id: "v", options: scopes, initial_option: scopes[0] } },
      { type: "context", elements: [text("The computer calls the service as you, for the sessions you choose. Revoke it any time.")] },
    ],
  };
}

interface SubmittedView {
  private_metadata?: string;
  state?: { values?: Record<string, Record<string, { selected_option?: { value?: string } | null }>> };
}

export interface OpenContext {
  userId: string;
  channelId?: string;
  threadTs?: string;
  messageTs?: string;
}

export class ComputerConnections {
  constructor(private readonly deps: ConnectionDeps) {}

  /** A session's request_connection: a button in its thread, for whoever is there. */
  async request(sessionKey: string, req: ConnectionRequest): Promise<void> {
    const session = this.deps.session(sessionKey);
    if (!session) throw new Error(`unknown session ${sessionKey}`);
    if (!isService(req.service)) throw new Error(`unknown service ${String(req.service)}: use one of ${CONNECTION_SERVICES.join(", ")}`);
    const reason = typeof req.reason === "string" ? req.reason : "";
    const r = await this.deps.slack("chat.postMessage", {
      channel: session.channelId,
      thread_ts: session.threadTs,
      text: `This session asks to use ${serviceName(req.service)}: ${reason}`,
      blocks: requestBlocks({ k: session.key, s: req.service }, reason),
    });
    if (!r.ok) throw new Error(`Slack post failed: ${r.error ?? "unknown_error"}`);
  }

  /** A click on "Grant …": the clicker's own connections, or how to get one (the trigger expires in 3 s). */
  async open(actionId: string, triggerId: string, ctx: OpenContext): Promise<void> {
    const d = decodeConnectionButtonId(actionId);
    if (!d) return;
    const session = this.deps.session(d.k);
    const name = serviceName(d.s);
    const user = this.deps.linkOfSlack(ctx.userId);
    let view: Record<string, unknown>;
    if (!session) {
      view = infoModal("Session ended", "That session has ended; nothing to grant.");
    } else if (!user) {
      view = infoModal(
        "Link your account",
        `To grant your ${name}, link your Slack user to your OpenComputer account first: open the Computer page, copy the \`!link\` command shown there and send it here. Then click *Grant ${name}* again.`,
        { label: "Open the Computer page", url: `${this.deps.origin()}/computer` },
      );
    } else {
      const connections = await this.deps.grantable(user, d.s);
      const meta: ModalData = {
        ...d,
        ...(ctx.channelId ? { ch: ctx.channelId } : {}),
        th: session.threadTs,
        ...(ctx.messageTs ? { rq: ctx.messageTs } : {}),
      };
      view = connections.length
        ? grantModal(meta, connections, session.ownerId !== ctx.userId ? session.ownerId : undefined)
        : infoModal(
            `Connect ${name}`,
            `You have no ${name} connection yet. Connect one on the dashboard, then click *Grant ${name}* again.`,
            { label: `Connect ${name}`, url: `${this.deps.origin()}/managed-agents/connections` },
          );
    }
    const r = await this.deps.slack("views.open", { trigger_id: triggerId, view });
    if (!r.ok) console.error("connection_modal_failed", { error: r.error });
  }

  /** The grant modal was submitted: check and store; `after` updates the thread and wakes the session. */
  async submit(view: SubmittedView, userId: string): Promise<{ errors?: Record<string, string>; after?: () => Promise<void> }> {
    let meta: ModalData;
    try {
      meta = JSON.parse(view.private_metadata ?? "") as ModalData;
    } catch {
      return { errors: { conn: "This form is out of date; click the button again." } };
    }
    if (typeof meta?.k !== "string" || !isService(meta.s)) return { errors: { conn: "This form is out of date; click the button again." } };
    const values = view.state?.values ?? {};
    const connectionId = values.conn?.v?.selected_option?.value ?? "";
    const scope = values.scope?.v?.selected_option?.value;
    if (!connectionId) return { errors: { conn: "Choose a connection." } };
    if (scope !== "session" && scope !== "user") return { errors: { scope: "Choose who it is for." } };
    const session = this.deps.session(meta.k);
    if (!session) return { errors: { conn: "This session has ended." } };
    const user = this.deps.linkOfSlack(userId);
    if (!user) return { errors: { conn: "Link your Slack user to OpenComputer first (`!link`)." } };
    // The owner check: grantable lists only this person's own connections.
    const connection = (await this.deps.grantable(user, meta.s)).find((c) => c.id === connectionId);
    if (!connection) return { errors: { conn: "That connection is not yours, or can no longer be granted." } };
    try {
      await this.deps.grant({ connectionId, ownerUserId: user, scope, subject: scope === "session" ? session.key : userId, grantedBy: userId });
    } catch (error) {
      return { errors: { conn: error instanceof Error ? error.message : "Could not grant it." } };
    }
    console.log("computer_connection_granted", { service: meta.s, scope, by: userId, session: session.key });
    return {
      after: async () => {
        const name = serviceName(meta.s);
        const where = scope === "session" ? "this thread" : "their threads";
        const note = `:link: <@${userId}> granted ${name} (\`${connection.label}\`) to ${where}.`;
        if (meta.rq && meta.ch) await this.deps.slack("chat.update", { channel: meta.ch, ts: meta.rq, text: note, blocks: [] });
        else await this.deps.slack("chat.postMessage", { channel: session.channelId, thread_ts: session.threadTs, text: note });
        // The session asked and is waiting: tell it, when the grant reaches it.
        const applies = scope === "session" || session.ownerId === userId;
        if (meta.rq && applies) {
          await this.deps.wake(session, userId, `${name} is granted to this session (connection "${connection.label}"). Continue.`, meta.rq);
        }
      },
    };
  }
}
