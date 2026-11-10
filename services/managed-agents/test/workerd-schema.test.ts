import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * A session object created under an earlier release carries that release's
 * platform schema. When the object restarts under newer code, the tables the
 * new code expects must exist before the first request; otherwise every turn
 * and interrupt on an existing session fails with "no such table".
 */

interface Host {
  ensurePlatformSchema(): void;
}

const sessions = (env as unknown as { OPENCODE_SESSIONS: DurableObjectNamespace }).OPENCODE_SESSIONS;

function sql(instance: Host) {
  return (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
}

function tables(instance: Host): string[] {
  return sql(instance)
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'workerd_%'")
    .toArray()
    .map((row) => row.name);
}

function activation(instance: Host): number {
  return Number(
    sql(instance).exec<{ activation: number }>("SELECT activation FROM workerd_activation WHERE slot = 1").toArray()[0]
      ?.activation ?? 0,
  );
}

describe("platform schema on restart", () => {
  it("adds tables introduced after the session's object was created", async () => {
    const stub = sessions.getByName("schema-restart");
    // A session hosted under an earlier release: the platform schema of that
    // release, without the tables added since.
    await runInDurableObject(stub, (raw) => {
      const instance = raw as unknown as Host;
      instance.ensurePlatformSchema();
      sql(instance).exec(
        "INSERT INTO workerd_deployment (slot, deployment_json) VALUES (1, ?)",
        JSON.stringify({ id: "dep_old" }),
      );
      sql(instance).exec("DROP TABLE workerd_turn_lease");
      sql(instance).exec("DROP TABLE workerd_seen_messages");
      expect(tables(instance)).not.toContain("workerd_turn_lease");
      expect(activation(instance)).toBe(1);
    });
    await evictDurableObject(stub);

    // The next activation runs the current code's constructor over the old storage.
    await runInDurableObject(stub, (raw) => {
      const instance = raw as unknown as Host;
      expect(tables(instance)).toContain("workerd_turn_lease");
      expect(tables(instance)).toContain("workerd_seen_messages");
      expect(activation(instance)).toBe(2);
      sql(instance)
        .exec("INSERT INTO workerd_turn_lease (opencode_session_id, turn_id, claimed_at) VALUES (?, ?, ?)", "oc", "t1", 1)
        .toArray();
    });
  });

  it("leaves a fresh object to /session", async () => {
    const stub = sessions.getByName("schema-fresh");
    await runInDurableObject(stub, (raw) => {
      expect(tables(raw as unknown as Host)).toEqual([]);
    });
  });
});
