import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";

const userID = "11111111-1111-4111-8111-111111111111";
const personalOrgID = "22222222-2222-4222-8222-222222222222";
const invitingOrgID = "33333333-3333-4333-8333-333333333333";
const workosOrgID = "org_workos_digger";
const inviteID = "44444444-4444-4444-8444-444444444444";

interface CapturedStatement {
  sql: string;
  args: unknown[];
}

interface MembershipRow {
  id: string;
  name: string;
  plan: string;
  is_personal: number;
  workos_org_id: string | null;
  membership_created_at: number;
  org_created_at: number;
}

const personalMembership: MembershipRow = {
  id: personalOrgID,
  name: "utpal@digger.dev's workspace",
  plan: "free",
  is_personal: 1,
  workos_org_id: null,
  membership_created_at: 1,
  org_created_at: 1,
};

const invitedMembership: MembershipRow = {
  id: invitingOrgID,
  name: "Digger",
  plan: "pro",
  is_personal: 0,
  workos_org_id: workosOrgID,
  membership_created_at: 2,
  org_created_at: 2,
};

class FakeStatement {
  private args: unknown[] = [];

  constructor(
    private readonly db: FakeDB,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM users WHERE workos_user_id")) {
      return (this.db.user ?? null) as T | null;
    }
    if (this.sql.includes("FROM orgs WHERE workos_org_id")) {
      return this.args[0] === workosOrgID ? ({ id: invitingOrgID } as T) : null;
    }
    if (this.sql.includes("FROM invitations")) {
      return this.db.pendingInvite ? ({ id: inviteID, role: "admin" } as T) : null;
    }
    if (this.sql.includes("o.workos_org_id = ?2")) {
      return (this.db.memberships.find((m) => m.workos_org_id === this.args[1]) ?? null) as T | null;
    }
    if (this.sql.includes("JOIN org_memberships") && this.sql.includes("LIMIT 1")) {
      return (this.db.memberships[0] ?? null) as T | null;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("JOIN org_memberships")) {
      return { results: this.db.memberships as T[] };
    }
    return { results: [] };
  }

  async run(): Promise<Record<string, never>> {
    this.db.executed.push({ sql: this.sql, args: this.args });
    if (this.sql.includes("INSERT INTO org_memberships") && this.args[0] === invitingOrgID) {
      this.db.memberships.push(invitedMembership);
    }
    if (this.sql.includes("UPDATE invitations")) {
      this.db.pendingInvite = false;
    }
    return {};
  }
}

class FakeDB {
  executed: CapturedStatement[] = [];
  memberships: MembershipRow[];
  pendingInvite = true;
  user: { id: string; email: string; name: string } | null = {
    id: userID,
    email: "utpal@digger.dev",
    name: "Utpal",
  };

  constructor(memberships: MembershipRow[]) {
    this.memberships = [...memberships];
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
}

function testEnv(db: FakeDB): Env {
  return {
    OPENCOMPUTER_DB: db,
    SESSION_JWT_SECRET: "test-session-secret",
    WORKOS_API_KEY: "sk_test",
    WORKOS_CLIENT_ID: "client_test",
    WORKER_ENV: "test",
  } as unknown as Env;
}

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function stubWorkOSExchange(): void {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    user: { id: "workos-user", email: "Utpal@Digger.dev", first_name: "Utpal" },
    organization_id: workosOrgID,
  })));
}

function sessionOrgID(resp: Response): string {
  const cookie = resp.headers.get("set-cookie") ?? "";
  const jwt = /oc_session=([^;]+)/.exec(cookie)?.[1] ?? "";
  const payload = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  return payload.org_id ?? payload.orgId ?? payload.sub ?? "";
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorkOS invitation acceptance", () => {
  it("mirrors the WorkOS membership into D1 and lands the invitee in the inviting org", async () => {
    const db = new FakeDB([personalMembership]);
    stubWorkOSExchange();

    const resp = await worker.fetch(
      new Request("https://app.opencomputer.dev/auth/callback?code=abc"),
      testEnv(db),
      ctx,
    );

    expect(resp.status).toBe(302);
    const insert = db.executed.find((e) => e.sql.includes("INSERT INTO org_memberships"));
    expect(insert?.args.slice(0, 3)).toEqual([invitingOrgID, userID, "admin"]);
    const accept = db.executed.find((e) => e.sql.includes("UPDATE invitations"));
    expect(accept?.args[1]).toBe(inviteID);
    expect(sessionOrgID(resp)).toBe(invitingOrgID);
  });

  it("does not create a personal org for an invitee whose only membership is the invite", async () => {
    const db = new FakeDB([]);
    stubWorkOSExchange();

    const resp = await worker.fetch(
      new Request("https://app.opencomputer.dev/auth/callback?code=abc"),
      testEnv(db),
      ctx,
    );

    expect(resp.status).toBe(302);
    expect(db.executed.some((e) => e.sql.includes("INSERT INTO orgs"))).toBe(false);
    expect(sessionOrgID(resp)).toBe(invitingOrgID);
  });

  it("leaves a login without an organization untouched", async () => {
    const db = new FakeDB([personalMembership]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      user: { id: "workos-user", email: "utpal@digger.dev", first_name: "Utpal" },
    })));

    const resp = await worker.fetch(
      new Request("https://app.opencomputer.dev/auth/callback?code=abc"),
      testEnv(db),
      ctx,
    );

    expect(resp.status).toBe(302);
    expect(db.executed.some((e) => e.sql.includes("INSERT INTO org_memberships"))).toBe(false);
    expect(sessionOrgID(resp)).toBe(personalOrgID);
  });
});
