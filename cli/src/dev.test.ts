import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  developmentWatchReadyMessage,
  hasReactSpa,
  projectDashboardURL,
  publishDevelopment,
  publishProjectDevelopment,
} from "./dev.js";
import { initializeAgentProject } from "./project.js";

test("development watch explains the live deployment loop", () => {
  const output = developmentWatchReadyMessage({
    projectName: "Support agents",
    projectId: "prj_support",
    dashboardUrl: "https://mo-oc-dev.com/projects/prj_support",
    agents: ["support@development"],
    deployments: ["support:abc123"],
    watchedDirectory: "/workspace/opencomputer",
  });
  assert.match(output, /✓ Deployment ready/);
  assert.match(output, /Watching \/workspace\/opencomputer for changes\./);
  assert.match(output, /Changes deploy automatically\. Press Ctrl\+C to stop\./);
  assert.doesNotMatch(output, /web app|Vite/i);
});

test("development derives the cloud dashboard project URL", () => {
  assert.equal(
    projectDashboardURL("https://mo-oc-dev.com/", "prj_hello/world"),
    "https://mo-oc-dev.com/projects/prj_hello%2Fworld",
  );
});

test("development detects whether the starter includes a React SPA", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-dev-shape-"));
  try {
    const withSpa = await initializeAgentProject(
      resolve(parent, "with-spa"),
      undefined,
      { spa: true },
    );
    const agentOnly = await initializeAgentProject(
      resolve(parent, "agent-only"),
      undefined,
      { spa: false },
    );
    assert.equal(await hasReactSpa(withSpa.root), true);
    assert.equal(await hasReactSpa(agentOnly.root), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("development publish builds an immutable artifact under the development alias", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-dev-"));
  try {
    const initialized = await initializeAgentProject(resolve(parent, "app"), {
      id: "prj_test",
      name: "Test project",
      agentId: "hello-agent",
    });
    let input:
      | Parameters<
          Parameters<typeof publishDevelopment>[0]["registerDeployment"]
        >[0]
      | undefined;
    const client = {
      async registerDeployment(value: NonNullable<typeof input>) {
        input = value;
        return {
          id: `${value.agentId}:${value.source.digest}`,
          agentId: value.agentId,
          alias: value.alias,
          createdAt: new Date(0).toISOString(),
        };
      },
    };
    const result = await publishDevelopment(
      client,
      initialized.agentRoot,
      "hello-agent",
    );
    assert.equal(input?.agentId, "hello-agent");
    assert.equal(input?.alias, "development");
    assert.equal(input?.source.digest, result.built.digest);
    assert.deepEqual(input?.models, [
      { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
    ]);
    assert.match(result.deployment.id, /^hello-agent:[a-f0-9]{64}$/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("development publish synchronizes every configured project agent", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-dev-multi-"));
  try {
    const initialized = await initializeAgentProject(resolve(parent, "app"));
    const echoRoot = resolve(
      initialized.root,
      "opencomputer",
      "agents",
      "echo",
    );
    await mkdir(echoRoot, { recursive: true });
    await writeFile(
      resolve(echoRoot, "agent.ts"),
      'export default function Agent() { return "Echo"; }\n',
    );
    await writeFile(
      resolve(initialized.root, "opencomputer", "project.ts"),
      'export default { name: "app", agents: ["hello-world", "echo"] };\n',
    );
    const published: Array<{ agentId: string; name: string }> = [];
    const client = {
      async registerDeployment(
        value: Parameters<
          Parameters<typeof publishDevelopment>[0]["registerDeployment"]
        >[0],
      ) {
        published.push({ agentId: value.agentId, name: value.name });
        return {
          id: `${value.agentId}:${value.source.digest}`,
          agentId: value.agentId,
          alias: value.alias,
          createdAt: new Date(0).toISOString(),
        };
      },
    };
    await publishProjectDevelopment(client, initialized.root, {
      version: 1,
      apiUrl: "https://app.opencomputer.dev",
      projectId: "prj_test",
      projectName: "Test",
      agentId: "test-agent",
    });
    assert.deepEqual(published, [
      { agentId: "test-agent", name: "Hello World" },
      { agentId: "test-agent--echo", name: "Echo" },
    ]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("project publish includes ordered default database migrations in deployment identity", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-dev-database-"));
  try {
    const initialized = await initializeAgentProject(resolve(parent, "app"));
    const migrations = resolve(
      initialized.root,
      "opencomputer",
      "database",
      "migrations",
    );
    await mkdir(migrations, { recursive: true });
    await writeFile(resolve(migrations, "002_notes.sql"), "ALTER TABLE notes ADD COLUMN body TEXT;\n");
    await writeFile(resolve(migrations, "001_initial.sql"), "CREATE TABLE notes (id TEXT PRIMARY KEY);\n");
    const published: Array<
      NonNullable<
        Parameters<
          Parameters<typeof publishDevelopment>[0]["registerDeployment"]
        >[0]["projectDeployment"]
      >
    > = [];
    const client = {
      async registerDeployment(
        value: Parameters<
          Parameters<typeof publishDevelopment>[0]["registerDeployment"]
        >[0],
      ) {
        if (value.projectDeployment) published.push(value.projectDeployment);
        return {
          id: `${value.agentId}:${value.source.digest}`,
          agentId: value.agentId,
          alias: value.alias,
          createdAt: new Date(0).toISOString(),
        };
      },
    };
    const binding = {
      version: 1 as const,
      apiUrl: "https://app.opencomputer.dev",
      projectId: "prj_test",
      projectName: "Test",
      agentId: "test-agent",
    };
    await publishProjectDevelopment(client, initialized.root, binding);
    assert.deepEqual(
      published[0]?.resources.database?.migrations.map((migration) => migration.name),
      ["001_initial.sql", "002_notes.sql"],
    );
    assert.match(
      published[0]?.resources.database?.migrations[0]?.checksum ?? "",
      /^[a-f0-9]{64}$/,
    );

    const firstDigest = published[0]?.digest;
    published.length = 0;
    await writeFile(resolve(migrations, "002_notes.sql"), "ALTER TABLE notes ADD COLUMN text TEXT;\n");
    await publishProjectDevelopment(client, initialized.root, binding);
    assert.notEqual(published[0]?.digest, firstDigest);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("project publish rejects invalid default database migration files", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-dev-database-invalid-"));
  try {
    const initialized = await initializeAgentProject(resolve(parent, "app"));
    const migrations = resolve(initialized.root, "opencomputer", "database", "migrations");
    await mkdir(migrations, { recursive: true });
    await writeFile(resolve(migrations, "notes.sql"), "CREATE TABLE notes (id TEXT);\n");
    await assert.rejects(
      publishProjectDevelopment(
        { registerDeployment: async () => { throw new Error("must not register"); } },
        initialized.root,
        {
          version: 1,
          apiUrl: "https://app.opencomputer.dev",
          projectId: "prj_test",
          projectName: "Test",
          agentId: "test-agent",
        },
      ),
      /must be a migration file named like 001_initial\.sql/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

const WORKSHOP_MEMORY = (maxBytes: string) => `import { defineMemory, documentMemory } from "@opencomputer/agent";

export const requirements = defineMemory({
  id: "requirements",
  description: "Verified requirements for a workshop.",
  provider: documentMemory({ maxBytes: ${maxBytes} }),
});
`;

const WORKSHOP_AGENT = `import { useMemory } from "@opencomputer/agent";
import { requirements } from "./memory";

export default function Agent() {
  return "Requirements: " + useMemory(requirements).text;
}
`;

test("development publish registers memory declarations with the deployment", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-dev-memory-"));
  try {
    const initialized = await initializeAgentProject(resolve(parent, "app"), {
      id: "prj_test",
      name: "Test project",
      agentId: "hello-agent",
    });
    await writeFile(resolve(initialized.agentRoot, "memory.ts"), WORKSHOP_MEMORY("8_192"));
    await writeFile(resolve(initialized.agentRoot, "agent.ts"), WORKSHOP_AGENT);
    let input:
      | Parameters<
          Parameters<typeof publishDevelopment>[0]["registerDeployment"]
        >[0]
      | undefined;
    const client = {
      async registerDeployment(value: NonNullable<typeof input>) {
        input = value;
        return {
          id: `${value.agentId}:${value.source.digest}`,
          agentId: value.agentId,
          alias: value.alias,
          createdAt: new Date(0).toISOString(),
        };
      },
    };
    await publishDevelopment(client, initialized.agentRoot, "hello-agent");
    assert.deepEqual(input?.memory, [
      {
        id: "requirements",
        description: "Verified requirements for a workshop.",
        provider: { kind: "document", maxBytes: 8192 },
      },
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(input)).memory, input?.memory);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("project publish requires agents to agree on a shared memory resource", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-dev-memory-project-"));
  try {
    const initialized = await initializeAgentProject(resolve(parent, "app"));
    await writeFile(resolve(initialized.agentRoot, "memory.ts"), WORKSHOP_MEMORY("8_192"));
    await writeFile(resolve(initialized.agentRoot, "agent.ts"), WORKSHOP_AGENT);
    const echoRoot = resolve(initialized.root, "opencomputer", "agents", "echo");
    await mkdir(echoRoot, { recursive: true });
    await writeFile(resolve(echoRoot, "memory.ts"), WORKSHOP_MEMORY("8_192"));
    await writeFile(resolve(echoRoot, "agent.ts"), WORKSHOP_AGENT);
    await writeFile(
      resolve(initialized.root, "opencomputer", "project.ts"),
      'export default { name: "app", agents: ["hello-world", "echo"] };\n',
    );
    const published: string[][] = [];
    const client = {
      async registerDeployment(
        value: Parameters<
          Parameters<typeof publishDevelopment>[0]["registerDeployment"]
        >[0],
      ) {
        published.push(value.memory.map((declaration) => declaration.id));
        return {
          id: `${value.agentId}:${value.source.digest}`,
          agentId: value.agentId,
          alias: value.alias,
          createdAt: new Date(0).toISOString(),
        };
      },
    };
    const binding = {
      version: 1 as const,
      apiUrl: "https://app.opencomputer.dev",
      projectId: "prj_test",
      projectName: "Test",
      agentId: "test-agent",
    };
    await publishProjectDevelopment(client, initialized.root, binding);
    assert.deepEqual(published, [["requirements"], ["requirements"]]);

    await writeFile(resolve(echoRoot, "memory.ts"), WORKSHOP_MEMORY("4_096"));
    published.length = 0;
    await assert.rejects(
      publishProjectDevelopment(client, initialized.root, binding),
      /Memory "requirements" is declared with different configuration in agent hello-world and agent echo/,
    );
    assert.deepEqual(published, []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
