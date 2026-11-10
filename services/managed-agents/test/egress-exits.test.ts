import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  egressExitPolicy,
  egressIpsResponse,
  egressPolicyResponse,
  forgetEgressExit,
  parseFixedIps,
  recordEgressExit,
  type EgressExitEnv,
} from "../src/edge/egress-exits.js";
import { EGRESS_EXITS, egressExitPools, exitIdentity, fixedIpsRegions } from "../src/egress-exit.js";
import { DEPLOYMENT_REGIONS } from "../src/protocol.js";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
const PLATFORM = ["managedagents.opencomputer.dev", "*.s3.us-east-1.amazonaws.com"];

function migratedDb(): { d1: D1Database; sql: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(MIGRATIONS, "0009_egress_exit_deployments.sql"), "utf8"));
  const d1 = {
    prepare: (sql: string) => ({
      bind: (...bindings: unknown[]) => {
        const statement = db.prepare(sql);
        return {
          run: () => ({ meta: { changes: Number(statement.run(...(bindings as never[])).changes) } }),
          all: () => ({ results: statement.all(...(bindings as never[])) }),
        };
      },
    }),
  } as unknown as D1Database;
  return { d1, sql: db };
}

function env(d1: D1Database, tokens = "new-token,old-token"): EgressExitEnv {
  return { SERVERLESS_AGENTS_DB: d1, EGRESS_FETCH_TOKENS: tokens, BLUE_AWS_REGION: "us-east-1" };
}

function policyRequest(token: string, region = "au", etag?: string): Request {
  return new Request(`https://managedagents.opencomputer.dev/internal/egress/policy?region=${region}`, {
    headers: { authorization: `Bearer ${token}`, ...(etag ? { "if-none-match": etag } : {}) },
  });
}

describe("egress exits, control plane (work 073)", () => {
  it("knows a deployment by a hash of account and deployment", async () => {
    const id = await exitIdentity("acct_1", "agent:sha256:abc");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(await exitIdentity("acct_2", "agent:sha256:abc")).not.toBe(id);
  });

  it("serves a region's deployments, open or with the platform hosts added", async () => {
    const { d1 } = migratedDb();
    await recordEgressExit(env(d1), { accountId: "a", deploymentId: "open", region: "au" });
    await recordEgressExit(env(d1), {
      accountId: "a",
      deploymentId: "allow",
      region: "au",
      egress: { domains: ["example.com"], cidrs: ["1.1.1.1/32"] },
    });
    await recordEgressExit(env(d1), { accountId: "a", deploymentId: "elsewhere", region: "eu" });
    const policy = await egressExitPolicy(env(d1), "au", PLATFORM);
    expect(policy.deployments).toEqual({
      [await exitIdentity("a", "open")]: null,
      [await exitIdentity("a", "allow")]: {
        domains: ["*.s3.us-east-1.amazonaws.com", "example.com", "managedagents.opencomputer.dev"],
        cidrs: ["1.1.1.1/32"],
      },
    });
  });

  it("replaces a deployment on redeploy and drops it when forgotten", async () => {
    const { d1 } = migratedDb();
    await recordEgressExit(env(d1), { accountId: "a", deploymentId: "d", region: "au" });
    await recordEgressExit(env(d1), { accountId: "a", deploymentId: "d", region: "eu" });
    expect(Object.keys((await egressExitPolicy(env(d1), "au", PLATFORM)).deployments)).toEqual([]);
    expect(Object.keys((await egressExitPolicy(env(d1), "fra", PLATFORM)).deployments)).toHaveLength(1);
    await forgetEgressExit(env(d1), { accountId: "a", deploymentId: "d" });
    expect((await egressExitPolicy(env(d1), "fra", PLATFORM)).deployments).toEqual({});
  });

  it("refuses a region without exits", async () => {
    const { d1 } = migratedDb();
    await expect(
      recordEgressExit(env(d1), { accountId: "a", deploymentId: "d", region: "mars" }),
    ).rejects.toThrow(/No egress exits/);
  });

  it("fails closed on a stored allowlist that no longer parses", async () => {
    const { d1, sql } = migratedDb();
    await recordEgressExit(env(d1), {
      accountId: "a",
      deploymentId: "d",
      region: "au",
      egress: { domains: ["example.com"], cidrs: [] },
    });
    sql.exec(`UPDATE egress_exit_deployments SET egress = '{"domains": "nope"}'`);
    const policy = await egressExitPolicy(env(d1), "au", PLATFORM);
    expect(policy.deployments[await exitIdentity("a", "d")]).toEqual({ domains: [...PLATFORM].sort(), cidrs: [] });
  });

  it("answers exits with their token, current or previous, and 304 when unchanged", async () => {
    const { d1 } = migratedDb();
    await recordEgressExit(env(d1), { accountId: "a", deploymentId: "d", region: "au" });
    const first = await egressPolicyResponse(policyRequest("new-token"), env(d1));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ deployments: { [await exitIdentity("a", "d")]: null } });
    const etag = first.headers.get("etag")!;
    expect((await egressPolicyResponse(policyRequest("old-token", "au", etag), env(d1))).status).toBe(304);
    await recordEgressExit(env(d1), { accountId: "a", deploymentId: "e", region: "au" });
    expect((await egressPolicyResponse(policyRequest("new-token", "au", etag), env(d1))).status).toBe(200);
  });

  it("refuses wrong tokens, unknown regions and an unconfigured edge", async () => {
    const { d1 } = migratedDb();
    expect((await egressPolicyResponse(policyRequest("wrong"), env(d1))).status).toBe(401);
    expect((await egressPolicyResponse(policyRequest(""), env(d1))).status).toBe(401);
    expect((await egressPolicyResponse(policyRequest("new-token", "mars"), env(d1))).status).toBe(400);
    expect((await egressPolicyResponse(policyRequest("new-token"), env(d1, ""))).status).toBe(503);
  });

  it("takes a deploy's fixed IPs region only when it has exits", () => {
    expect(parseFixedIps(undefined)).toBeUndefined();
    expect(parseFixedIps("au")).toBe("au");
    expect(parseFixedIps("eu-west")).toBe("eu-west");
    expect(parseFixedIps("lax")).toBe("lax");
    for (const bad of ["mars", "", "AU", "syd", "cdg", true, ["au"]]) expect(parseFixedIps(bad), String(bad)).toBeNull();
  });

  it("stores the pool a region leaves through, which its exits poll", async () => {
    const { d1 } = migratedDb();
    await recordEgressExit(env(d1), { accountId: "a", deploymentId: "d", region: "ap-melbourne" });
    expect(Object.keys((await egressExitPolicy(env(d1), "au", PLATFORM)).deployments)).toHaveLength(1);
  });

  it("gives every deployment region exits, and every pool a fixed IPs name", () => {
    for (const region of DEPLOYMENT_REGIONS) expect(parseFixedIps(region), region).toBe(region);
    for (const region of fixedIpsRegions()) expect(parseFixedIps(region), region).toBe(region);
    expect(egressExitPools()).toEqual([...new Set(EGRESS_EXITS.map((exit) => exit.region))].sort());
  });

  it("lists the fixed IPs per region publicly", async () => {
    const body = (await egressIpsResponse().json()) as { regions: Record<string, { ipv4: string[] }> };
    expect(Object.keys(body.regions)).toEqual(fixedIpsRegions());
    expect(body.regions.au!.ipv4).toEqual(
      EGRESS_EXITS.filter((exit) => exit.region === "au").map((exit) => exit.egress_ipv4),
    );
    expect(body.regions["ap-melbourne"]).toEqual(body.regions.au);
    expect(Object.keys(body.regions)).toHaveLength(DEPLOYMENT_REGIONS.length + 3);
  });
});
