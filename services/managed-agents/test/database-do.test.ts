import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { databaseObjectName } from "../src/edge/database-contract.js";
import {
  providerDatabaseName,
  type ProjectDatabaseDurableObject,
} from "../src/edge/database-do.js";

describe("project database durable object", () => {
  it("fails closed before provider access when a migration checksum is invalid", async () => {
    const database = env.DATABASES.getByName(
      databaseObjectName("acct", "prj_checksum", "development"),
    );
    await runInDurableObject(database, async (instance: ProjectDatabaseDurableObject) => {
      await expect(
        instance.applyMigrations({
          accountId: "acct",
          projectId: "prj_checksum",
          environment: "development",
        }, [
          {
            name: "001_initial.sql",
            checksum: "0".repeat(64),
            sql: "CREATE TABLE items (id TEXT PRIMARY KEY);",
          },
        ]),
      ).rejects.toThrow(/checksum does not match/);
    });
  });

  it("routes development and production to different coordinator objects", () => {
    expect(databaseObjectName("acct", "prj_isolation", "development")).not.toBe(
      databaseObjectName("acct", "prj_isolation", "production"),
    );
  });

  it("uses readable, deterministic, environment-specific Turso names", async () => {
    const scope = {
      accountId: "acct_a1b2c987654321",
      projectId: "prj_e202877eb2fc4b3b911c524b2d47b2cc",
      environment: "development" as const,
    };
    const development = await providerDatabaseName(scope);
    const production = await providerDatabaseName({
      ...scope,
      environment: "production",
    });
    expect(development).toMatch(/^oc-a1b2c-e202877e-dev-[a-f0-9]{10}$/);
    expect(await providerDatabaseName(scope)).toBe(development);
    expect(production).toMatch(/^oc-a1b2c-e202877e-prod-[a-f0-9]{10}$/);
    expect(production).not.toBe(development);
  });

  it("serves query and execute through its MCP endpoint", async () => {
    const database = env.DATABASES.getByName(
      databaseObjectName("acct", "prj_mcp", "development"),
    );
    const response = await database.fetch("https://database.invalid/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        tools: [{ name: "query" }, { name: "execute" }],
      },
    });
  });

  it("rejects DDL and multiple statements from model-facing tools", async () => {
    const database = env.DATABASES.getByName(
      databaseObjectName("acct", "prj_guards", "development"),
    );
    await runInDurableObject(database, async (instance: ProjectDatabaseDurableObject) => {
      await expect(instance.execute("DROP TABLE notes", [])).rejects.toThrow(
        /INSERT, UPDATE, DELETE, or REPLACE/,
      );
      await expect(instance.query("SELECT 1; SELECT 2", [])).rejects.toThrow(
        /one SQL statement/,
      );
    });
  });
});
