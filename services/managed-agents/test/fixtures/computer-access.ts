import type { Drivers } from "../../src/computer/access.js";
import { AccessFlow, type AccessDispatch } from "../../src/computer/access-flow.js";
import { AccessStore } from "../../src/computer/access-store.js";
import { AccessUi } from "../../src/computer/access-ui.js";
import type { SlackMessageJob, SlackResult } from "../../src/computer/slack.js";
import { ThreadAccess } from "../../src/computer/threads.js";
import { sqlStorage } from "./computer-sql.js";

/** People in the fake workspace: ids as Slack's (`!access` reads `@U…` with at least 7 characters). */
export const OWNER = "UOWNER01";
export const A = "UAAAAAA1";
export const B = "UBBBBBB1";
export const GUEST = "UGUEST01";
export const STRANGER = "UEXTERN1";
/** A full member linked to a dashboard admin. */
export const ADMIN = "UADMIN01";
export const KEY = "T1:C1:100.1";
export const SESSION = { key: KEY, ownerId: OWNER, channelId: "C1", threadTs: "100.1" };

/** AccessFlow and AccessUi over node:sqlite, a fake Slack, the one lookup of people, and a recording queue and delivery. */
export function accessHarness(drivers: Drivers = "*") {
  const sql = sqlStorage();
  sql.exec(`
    CREATE TABLE sessions (runner_key TEXT PRIMARY KEY, owner_id TEXT, channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const store = new AccessStore(sql);
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const delivered: AccessDispatch[] = [];
  /** Messages `setDrivers` put back on the Slack queue. */
  const requeued: SlackMessageJob[] = [];
  const changes: Array<{ key: string; by: { id: string; admin: boolean }; from: string; to: string }> = [];
  const pending: Promise<unknown>[] = [];
  const h = {
    sql,
    store,
    calls,
    delivered,
    requeued,
    changes,
    failDelivery: false,
    /** Slack answers for a method, instead of `{ ok: true, ts }`. */
    answers: new Map<string, SlackResult>(),
    flow: undefined as unknown as AccessFlow,
    ui: undefined as unknown as AccessUi,
    addSession(key: string, owner: string, threadTs: string, d?: Drivers) {
      sql.exec("INSERT INTO sessions (runner_key, owner_id, channel_id, thread_ts) VALUES (?, ?, 'C1', ?)", key, owner, threadTs);
      if (d !== undefined) store.writeDrivers(key, d);
    },
    of(method: string) {
      return calls.filter((c) => c.method === method).map((c) => c.body);
    },
    ephemerals(user: string) {
      return calls.filter((c) => c.method === "chat.postEphemeral" && c.body.user === user).map((c) => c.body.text);
    },
    posts() {
      return calls.filter((c) => c.method === "chat.postMessage").map((c) => c.body.text);
    },
    async settle() {
      while (pending.length) await pending.shift();
    },
    job(userId: string, text: string, o: Partial<SlackMessageJob> = {}): SlackMessageJob {
      return { eventId: `E${text}`, teamId: "T1", channelId: "C1", threadTs: "100.1", messageTs: `${200 + calls.length}.1`, userId, text, mentioned: false, receivedAt: 0, ...o };
    },
  };
  let ts = 300;
  const slack = async (method: string, body: Record<string, unknown>): Promise<SlackResult> => {
    calls.push({ method, body });
    const answer = h.answers.get(method);
    if (answer) return answer;
    if (method === "users.info") {
      const user = String(body.user);
      if (user === STRANGER) return { ok: true, user: { team_id: "T_OTHER" } };
      return { ok: true, user: { team_id: "T1", is_restricted: user === GUEST } };
    }
    return { ok: true, ts: `${ts++}.1` };
  };
  // The Durable Object's one lookup of a person (threads.ts).
  const people = new ThreadAccess(slack, "T1");
  h.flow = new AccessFlow({
    store,
    slack,
    member: (id) => people.member(id),
    session: (key) => {
      const row = [...sql.exec<{ owner: string | null; channelId: string; threadTs: string }>(
        "SELECT owner_id AS owner, channel_id AS channelId, thread_ts AS threadTs FROM sessions WHERE runner_key = ?",
        key,
      )][0];
      return row?.owner ? { key, ownerId: row.owner, channelId: row.channelId, threadTs: row.threadTs } : undefined;
    },
    linkOfSlack: (id) => (id === ADMIN ? "member-admin" : id === OWNER ? "member-owner" : undefined),
    isAdmin: (member) => member === "member-admin",
    name: async (id) => `name-${id}`,
    requeue: (job) => void requeued.push(job),
    changed: (key, by, from, to) => void changes.push({ key, by, from, to }),
    waitUntil: (p) => void pending.push(p),
  });
  h.ui = new AccessUi({ flow: h.flow, store, slack });
  h.addSession(KEY, OWNER, "100.1", drivers);
  return h;
}

export type AccessHarness = ReturnType<typeof accessHarness>;

/** A message through the gate and, when it passes, the delivery `process` makes. */
export async function send(h: AccessHarness, job: SlackMessageJob, text = job.text) {
  const gate = await h.flow.message(job, text, SESSION);
  if (!gate.deliver) return gate;
  const dispatch: AccessDispatch = { channelId: job.channelId, threadTs: job.threadTs, messageTs: job.messageTs, userId: job.userId, text: job.text, mentioned: job.mentioned, role: gate.role };
  const deliver = async (d: AccessDispatch) => {
    if (h.failDelivery) throw new Error("hub down");
    h.delivered.push(d);
  };
  if (gate.context) await h.flow.deliver(KEY, dispatch, deliver);
  else await deliver(dispatch);
  return gate;
}

/** The queue's turn: each requeued message through the gate, as `process` takes it. */
export async function drain(h: AccessHarness) {
  const gates = [];
  while (h.requeued.length) gates.push(await send(h, h.requeued.shift()!));
  return gates;
}
