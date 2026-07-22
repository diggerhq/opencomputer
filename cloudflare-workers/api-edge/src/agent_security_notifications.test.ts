import { describe, expect, it } from "vitest";
import {
  acknowledgeAgentSecurityNotification,
  listAgentSecurityNotifications,
  receiveAgentSecurityNotification,
  type AgentSecurityCaller,
  type AgentSecurityNotificationsEnv,
} from "./agent_security_notifications";

const SECRET = "security-notification-secret";
const NOW = 1_783_526_400;
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const OWNER: AgentSecurityCaller = { orgID: ORG_A, userID: "usr_owner" };
const ADMIN: AgentSecurityCaller = { orgID: ORG_A, userID: "usr_admin" };
const MEMBER: AgentSecurityCaller = { orgID: ORG_A, userID: "usr_member" };

interface Row {
  id: string;
  org_id: string;
  agent_id: string;
  hook_id: string;
  kind: "secret_exposure";
  occurred_at: number;
  received_at: number;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
}

class MemoryD1 {
  readonly events = new Map<string, Row>();
  readonly roles = new Map<string, string>([
    [`${ORG_A}:usr_owner`, "owner"],
    [`${ORG_A}:usr_admin`, "admin"],
    [`${ORG_A}:usr_member`, "member"],
    [`${ORG_B}:usr_other_owner`, "owner"],
  ]);
  prepares = 0;

  prepare(sql: string) {
    this.prepares += 1;
    const db = this;
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) {
        args = values;
        return this;
      },
      async run() {
        if (sql.includes("INSERT OR IGNORE INTO agent_security_notifications")) {
          const id = String(args[0]);
          if (db.events.has(id)) return { meta: { changes: 0 } };
          db.events.set(id, {
            id,
            org_id: String(args[1]),
            agent_id: String(args[2]),
            hook_id: String(args[3]),
            kind: args[4] as "secret_exposure",
            occurred_at: Number(args[5]),
            received_at: Number(args[6]),
            acknowledged_at: null,
            acknowledged_by: null,
          });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE agent_security_notifications")) {
          const [acknowledgedAt, acknowledgedBy, id, orgID] = args;
          const row = db.events.get(String(id));
          if (!row || row.org_id !== orgID || row.acknowledged_at !== null) {
            return { meta: { changes: 0 } };
          }
          row.acknowledged_at = Number(acknowledgedAt);
          row.acknowledged_by = String(acknowledgedBy);
          return { meta: { changes: 1 } };
        }
        throw new Error(`unexpected run SQL: ${sql}`);
      },
      async first<T>() {
        if (sql.includes("SELECT role FROM org_memberships")) {
          const role = db.roles.get(`${args[0]}:${args[1]}`);
          return (role ? { role } : null) as T | null;
        }
        if (sql.includes("FROM agent_security_notifications WHERE id=?1 AND org_id=?2")) {
          const row = db.events.get(String(args[0]));
          return (row && row.org_id === args[1] ? { id: row.id } : null) as T | null;
        }
        if (sql.includes("FROM agent_security_notifications WHERE id=?1")) {
          return (db.events.get(String(args[0])) ?? null) as T | null;
        }
        throw new Error(`unexpected first SQL: ${sql}`);
      },
      async all<T>() {
        if (!sql.includes("FROM agent_security_notifications")) {
          throw new Error(`unexpected all SQL: ${sql}`);
        }
        const orgID = String(args[0]);
        const unacknowledgedOnly = sql.includes("acknowledged_at IS NULL");
        const hasCursor = sql.includes("occurred_at <");
        const cursorOccurredAt = hasCursor ? Number(args[1]) : null;
        const cursorID = hasCursor ? String(args[2]) : null;
        const limit = Number(args.at(-1));
        const results = [...db.events.values()]
          .filter((row) => row.org_id === orgID)
          .filter((row) => !unacknowledgedOnly || row.acknowledged_at === null)
          .filter((row) => !hasCursor
            || row.occurred_at < cursorOccurredAt!
            || (row.occurred_at === cursorOccurredAt && row.id < cursorID!))
          .sort((left, right) => right.occurred_at - left.occurred_at || right.id.localeCompare(left.id))
          .slice(0, limit);
        return { results: results as T[] };
      },
    };
  }
}

function env(db = new MemoryD1()): AgentSecurityNotificationsEnv {
  return {
    OPENCOMPUTER_DB: db as unknown as D1Database,
    OC_SECURITY_NOTIFICATION_SECRET: SECRET,
  };
}

function event(overrides: Partial<Record<keyof Row, unknown>> = {}) {
  return {
    id: "hse_aaaaaaaaaaaaaaaaaaaaaaaa",
    org_id: ORG_A,
    agent_id: "agt_bbbbbbbbbbbbbbbbbbbbbbbb",
    hook_id: "hk_cccccccccccccccccccccccc",
    kind: "secret_exposure",
    occurred_at: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

async function hmacHex(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function signedRequest(
  body: string,
  options: { timestamp?: string; signature?: string; contentType?: string } = {},
) {
  const timestamp = options.timestamp ?? String(NOW);
  const signature = options.signature ?? `v1=${await hmacHex(`${timestamp}.${body}`)}`;
  return new Request("https://app.opencomputer.dev/internal/agent-security-notifications", {
    method: "POST",
    headers: {
      "content-type": options.contentType ?? "application/json",
      "x-oc-security-timestamp": timestamp,
      "x-oc-security-signature": signature,
    },
    body,
  });
}

async function receive(
  db: MemoryD1,
  payload: unknown = event(),
  options: Parameters<typeof signedRequest>[1] = {},
) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return receiveAgentSecurityNotification(await signedRequest(body, options), env(db), NOW);
}

function seed(db: MemoryD1, row: Partial<Row> & Pick<Row, "id">) {
  db.events.set(row.id, {
    id: row.id,
    org_id: row.org_id ?? ORG_A,
    agent_id: row.agent_id ?? "agt_bbbbbbbbbbbbbbbbbbbbbbbb",
    hook_id: row.hook_id ?? "hk_cccccccccccccccccccccccc",
    kind: "secret_exposure",
    occurred_at: row.occurred_at ?? NOW,
    received_at: row.received_at ?? NOW,
    acknowledged_at: row.acknowledged_at ?? null,
    acknowledged_by: row.acknowledged_by ?? null,
  });
}

describe("Agent Hook security notification receiver", () => {
  it("commits a verified event, accepts an exact replay, and rejects an id conflict", async () => {
    const db = new MemoryD1();
    expect((await receive(db)).status).toBe(204);
    expect(db.events.size).toBe(1);
    expect((await receive(db)).status).toBe(204);
    expect(db.events.size).toBe(1);

    const conflict = await receive(db, event({ hook_id: "hk_dddddddddddddddddddddddd" }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: {
        type: "conflict",
        message: "Security notification id conflicts with an existing event",
      },
    });
    expect(db.events.get("hse_aaaaaaaaaaaaaaaaaaaaaaaa")?.hook_id)
      .toBe("hk_cccccccccccccccccccccccc");
  });

  it("authenticates the raw body before parsing or touching D1", async () => {
    const db = new MemoryD1();
    const response = await receive(db, "not-json", { signature: `v1=${"0".repeat(64)}` });
    expect(response.status).toBe(401);
    expect(db.prepares).toBe(0);
  });

  it("fails closed for stale, malformed, oversized, and unconfigured requests", async () => {
    const db = new MemoryD1();
    expect((await receive(db, event(), { timestamp: String(NOW - 301) })).status).toBe(401);
    expect((await receive(db, { ...event(), arbitrary: true })).status).toBe(400);
    expect((await receive(db, "x".repeat(4 * 1024 + 1))).status).toBe(413);
    expect((await receive(db, event(), { contentType: "text/plain" })).status).toBe(415);

    const body = JSON.stringify(event());
    const unconfigured = await receiveAgentSecurityNotification(
      await signedRequest(body),
      { OPENCOMPUTER_DB: db as unknown as D1Database },
      NOW,
    );
    expect(unconfigured.status).toBe(503);
    expect(db.events.size).toBe(0);
  });
});

describe("Agent Hook security notification dashboard API", () => {
  it("is owner/admin-only, org-scoped, paginated, and cursor-bound to the filter", async () => {
    const db = new MemoryD1();
    seed(db, { id: "hse_000000000000000000000003", occurred_at: NOW + 3 });
    seed(db, { id: "hse_000000000000000000000002", occurred_at: NOW + 2 });
    seed(db, {
      id: "hse_000000000000000000000001",
      occurred_at: NOW + 1,
      acknowledged_at: NOW + 10,
      acknowledged_by: "usr_owner",
    });
    seed(db, { id: "hse_ffffffffffffffffffffffff", org_id: ORG_B, occurred_at: NOW + 4 });

    const member = await listAgentSecurityNotifications(
      new Request("https://app.test/api/dashboard/agent-security-notifications"),
      env(db),
      MEMBER,
    );
    expect(member.status).toBe(403);

    const first = await listAgentSecurityNotifications(
      new Request("https://app.test/api/dashboard/agent-security-notifications?limit=1"),
      env(db),
      OWNER,
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { data: Array<{ id: string }>; next_cursor: string };
    expect(firstBody.data.map((item) => item.id)).toEqual(["hse_000000000000000000000003"]);
    expect(firstBody.next_cursor).toEqual(expect.any(String));

    const second = await listAgentSecurityNotifications(
      new Request(`https://app.test/api/dashboard/agent-security-notifications?limit=1&cursor=${firstBody.next_cursor}`),
      env(db),
      ADMIN,
    );
    const secondBody = await second.json() as { data: Array<{ id: string }>; next_cursor: string | null };
    expect(secondBody.data.map((item) => item.id)).toEqual(["hse_000000000000000000000002"]);
    expect(secondBody.next_cursor).toBeNull();

    const mismatchedFilter = await listAgentSecurityNotifications(
      new Request(`https://app.test/api/dashboard/agent-security-notifications?include_acknowledged=true&cursor=${firstBody.next_cursor}`),
      env(db),
      OWNER,
    );
    expect(mismatchedFilter.status).toBe(400);

    const all = await listAgentSecurityNotifications(
      new Request("https://app.test/api/dashboard/agent-security-notifications?include_acknowledged=true"),
      env(db),
      OWNER,
    );
    const allBody = await all.json() as { data: Array<{ id: string }> };
    expect(allBody.data.map((item) => item.id)).toEqual([
      "hse_000000000000000000000003",
      "hse_000000000000000000000002",
      "hse_000000000000000000000001",
    ]);
  });

  it("acknowledges once and keeps missing and cross-org ids indistinguishable", async () => {
    const db = new MemoryD1();
    const id = "hse_000000000000000000000001";
    seed(db, { id });

    expect((await acknowledgeAgentSecurityNotification(env(db), MEMBER, id, NOW + 1)).status)
      .toBe(403);
    expect((await acknowledgeAgentSecurityNotification(env(db), OWNER, id, NOW + 2)).status)
      .toBe(204);
    expect(db.events.get(id)).toMatchObject({
      acknowledged_at: NOW + 2,
      acknowledged_by: OWNER.userID,
    });
    expect((await acknowledgeAgentSecurityNotification(env(db), ADMIN, id, NOW + 3)).status)
      .toBe(204);
    expect(db.events.get(id)?.acknowledged_at).toBe(NOW + 2);

    const otherOrgCaller = { orgID: ORG_B, userID: "usr_other_owner" };
    expect((await acknowledgeAgentSecurityNotification(env(db), otherOrgCaller, id, NOW + 4)).status)
      .toBe(404);
    expect((await acknowledgeAgentSecurityNotification(
      env(db),
      OWNER,
      "hse_999999999999999999999999",
      NOW + 4,
    )).status).toBe(404);
  });
});
