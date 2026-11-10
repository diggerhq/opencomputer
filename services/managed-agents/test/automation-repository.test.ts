import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const codeStorage = vi.hoisted(() => ({
  ensureAutomationRepository: vi.fn(async () => {}),
  repositoryGitCredential: vi.fn(async (input: { repoId: string }) => ({
    remoteUrl: `https://acme.code.storage/${input.repoId}.git`,
    username: "t",
    password: "jwt",
    expiresAt: "2026-10-16T02:00:00.000Z",
  })),
}));
vi.mock("../src/templates/code-storage.js", async (actual) => ({
  ...(await actual<typeof import("../src/templates/code-storage.js")>()),
  ...codeStorage,
}));

import {
  automationRepository,
  automationRepositoryCredential,
  type AutomationRepositoryEnv,
} from "../src/edge/automation-repository.js";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

function migratedDb(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(MIGRATIONS, "0008_automation_repositories.sql"), "utf8"));
  return {
    prepare: (sql: string) => ({
      bind: (...bindings: unknown[]) => {
        const statement = db.prepare(sql);
        return {
          run: () => ({ meta: { changes: Number(statement.run(...(bindings as never[])).changes) } }),
          first: <T>() => (statement.get(...(bindings as never[])) as T) ?? null,
        };
      },
    }),
  } as unknown as D1Database;
}

function env(db: D1Database, configured = true): AutomationRepositoryEnv {
  return {
    SERVERLESS_AGENTS_DB: db,
    ...(configured ? { CODE_STORAGE_ORG: "acme", PIERRE_PRIVATE_KEY: "key" } : {}),
  } as unknown as AutomationRepositoryEnv;
}

describe("automation repositories", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates one repository per organization on first ask and hands out push credentials after", async () => {
    const db = migratedDb();
    await expect(automationRepository(env(db), "acct")).resolves.toBeNull();
    const first = await automationRepositoryCredential(env(db), { accountId: "acct", userId: "computer" });
    expect(first).toMatchObject({ remoteUrl: "https://acme.code.storage/automations-acct.git", username: "t" });
    await automationRepositoryCredential(env(db), { accountId: "acct", userId: "usr_1" });
    expect(codeStorage.ensureAutomationRepository).toHaveBeenCalledTimes(1);
    expect(codeStorage.repositoryGitCredential).toHaveBeenLastCalledWith(
      expect.objectContaining({ repoId: "automations-acct", write: true, ttlSeconds: 3600 }),
    );
    await expect(automationRepository(env(db), "acct")).resolves.toBe("automations-acct");
    await expect(automationRepository(env(db), "other")).resolves.toBeNull();
  });

  it("refuses when Code.Storage is not configured, without creating a repository", async () => {
    const db = migratedDb();
    await expect(
      automationRepositoryCredential(env(db, false), { accountId: "acct", userId: "computer" }),
    ).rejects.toThrow(/not configured/);
    expect(codeStorage.ensureAutomationRepository).not.toHaveBeenCalled();
  });
});
