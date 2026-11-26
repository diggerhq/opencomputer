import { env, runInDurableObject } from "cloudflare:test";

import type { Access, Principal } from "../src/auth/principal.js";
import type { EventPush, SessionLogRpcAdded, SummaryPub } from "../src/actor/contracts.js";
import type { Actor, ApiEvent } from "../src/api-objects/objects.js";
import type { SessionLogDurableObject } from "../src/computer/session-log.js";
import type { SessionLogRpc } from "../src/computer/session-log-contract.js";

/** A log with fakes for the actors it calls (Org, Computer, Live), for the tracks-and-threads tests. */

type Namespace = DurableObjectNamespace<SessionLogDurableObject>;
const testEnv = env as unknown as { SESSION_LOG: Namespace };

export const ORG = "org_test";
export const MACHINE = "mc_0000000000000001";
export const OWNER_ID = "usr_owner00000001";
export const MATE_ID = "usr_mate000000001";

export const member = (subject = OWNER_ID, over: Partial<Principal> = {}): Principal => ({
  org: ORG,
  subject,
  kind: "member",
  via: "app",
  scopes: [],
  audiences: ["org", `member:${subject}`],
  admin: false,
  credential: { id: "cred_1", expiresAt: null },
  ...over,
});
export const agent = (session: string, over: Partial<Principal> = {}): Principal => ({
  org: ORG,
  subject: session,
  kind: "agent",
  via: "agent",
  scopes: [],
  audiences: [],
  session,
  admin: false,
  credential: { id: "cred_a", expiresAt: null },
  ...over,
});
export const platform: Principal = { org: ORG, subject: "platform", kind: "platform", via: "agent", scopes: [], audiences: [], admin: false, credential: { id: "platform", expiresAt: null } };

export const accessOf = (over: Partial<Access> = {}): Access => ({ owner: OWNER_ID, audience: "org", writers: "members", readers: [], machine: MACHINE, revision: 1, ...over });

export interface Fakes {
  /** What `Org.access` answers; null: Org has no such session. */
  access: Access | null;
  accessReads: number;
  /** Everything Org was sent. */
  summaries: SummaryPub[];
  /** The revision `Org.acceptSummary` answers; default: the one sent. A function may throw. */
  orgAnswers: ((pub: SummaryPub, log: SessionLogDurableObject) => number | Promise<number>) | null;
  /** Every drain call's machine. */
  drains: string[];
  /** What `Computer.drain` does; default: takes it and delivers nothing (the machine is waking). */
  drain: (log: SessionLogDurableObject) => Promise<void> | void;
  /** Every publish. */
  published: { topic: string; value: EventPush | { head: string } }[];
  publishFails: boolean;
}

let sessions = 0;
export async function openLog(over: Partial<Fakes> = {}) {
  const sessionId = `cs_tt${String(++sessions).padStart(14, "0")}`;
  const object = testEnv.SESSION_LOG.getByName(sessionId);
  const stub = object as unknown as SessionLogRpc & SessionLogRpcAdded;
  const identity = { sessionId, organizationId: ORG };
  const fakes: Fakes = {
    access: accessOf(),
    accessReads: 0,
    summaries: [],
    orgAnswers: null,
    drains: [],
    drain: () => undefined,
    published: [],
    publishFails: false,
    ...over,
  };
  const inside = <T>(fn: (instance: SessionLogDurableObject, state: DurableObjectState) => T | Promise<T>) => runInDurableObject(object as never, fn as never) as Promise<T>;
  await inside((instance) => {
    instance.peers = {
      org: () => ({
        access: async () => {
          fakes.accessReads++;
          return fakes.access;
        },
        acceptSummary: async (pub) => {
          // A real stub never answers in the caller's own tick.
          await Promise.resolve();
          const revision = fakes.orgAnswers ? await fakes.orgAnswers(pub, instance) : pub.revision;
          fakes.summaries.push(pub);
          return { accepted: revision === pub.revision, revision };
        },
      }),
      computer: (machine) => ({
        drain: async () => {
          await Promise.resolve();
          fakes.drains.push(machine);
          return fakes.drain(instance);
        },
      }),
      live: () => ({
        publish: async (topic, value) => {
          if (fakes.publishFails) throw new Error("live is down");
          fakes.published.push({ topic, value: value as EventPush | { head: string } });
          return { head: "to" in value ? value.to : "head" in value ? value.head : "" };
        },
      }),
    };
  });
  let ms = Date.parse("2026-10-26T09:00:00.000Z");
  let ids = 0;
  const ev = (seq: number, type: string, turnId: string | null, data: unknown, actor: Actor | null = null): ApiEvent => ({
    id: `ev_tt${String(++ids).padStart(14, "0")}`,
    seq,
    createdAt: new Date((ms += 10)).toISOString(),
    sessionId,
    turnId,
    type,
    actor,
    data,
  });
  /** Send what is owed and due at `now` (default: far enough ahead that every retry is due). */
  const flush = (now = Date.now() + 120_000) => inside((instance) => instance.flush(now));
  return { sessionId, object, stub, identity, fakes, ev, flush, inside };
}
