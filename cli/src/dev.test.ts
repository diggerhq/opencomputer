import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  hasReactSpa,
  projectDashboardURL,
  publishDevelopment,
  publishProjectDevelopment,
  syncDevelopmentSecrets,
} from "./dev.js";
import { initializeAgentProject } from "./project.js";

test("development derives the cloud dashboard project URL", () => {
  assert.equal(
    projectDashboardURL("https://mo-oc-dev.com/", "prj_hello/world"),
    "https://mo-oc-dev.com/projects/prj_hello%2Fworld",
  );
});

test("development detects whether the starter includes a React SPA", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-dev-shape-"));
  try {
    const withSpa = await initializeAgentProject(resolve(parent, "with-spa"));
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

test("development syncs declared .env.local secrets to inferred origins", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-dev-secrets-"));
  try {
    const initialized = await initializeAgentProject(
      resolve(parent, "app"),
      undefined,
      { spa: false },
    );
    await mkdir(resolve(initialized.agentRoot, "tools"), { recursive: true });
    await writeFile(
      resolve(initialized.agentRoot, "tools", "github.ts"),
      `import { bearer, defineConnection, defineTool, useSecret } from "@opencomputer/agent";

const github = defineConnection({
  id: "github-api",
  origin: "https://api.github.com",
  headers: { Authorization: bearer(useSecret("GITHUB_TOKEN")) },
});

export const repository = defineTool({
  name: "github_repository",
  description: "Read a GitHub repository",
  async run() { return await (await github.fetch("/repos/opencomputer/example")).json(); },
});
`,
    );
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { useTool } from "@opencomputer/agent";
import { repository } from "./tools/github.js";
export default function Agent() { useTool(repository); return "Use GitHub."; }
`,
    );
    const binding = {
      version: 1 as const,
      apiUrl: "https://app.opencomputer.dev",
      projectId: "prj_test",
      projectName: "Test",
      agentId: "test-agent",
    };
    const results = await publishProjectDevelopment(
      {
        async registerDeployment(value) {
          return {
            id: `${value.agentId}:${value.source.digest}`,
            agentId: value.agentId,
            alias: value.alias,
            createdAt: new Date(0).toISOString(),
          };
        },
      },
      initialized.root,
      binding,
    );
    await writeFile(
      resolve(initialized.root, "opencomputer", ".env.local"),
      "GITHUB_TOKEN=first-secret\n",
    );
    const uploads: Array<{
      name: string;
      value: string;
      allowedOrigins: string[];
    }> = [];
    let confirmations = 0;
    const client = {
      async putSecret(input: {
        projectId: string;
        name: string;
        value: string;
        environment: "development" | "production";
        agentId?: string;
        allowedOrigins: string[];
      }) {
        uploads.push(input);
        return {
          name: input.name,
          projectId: input.projectId,
          environment: input.environment,
          allowedOrigins: input.allowedOrigins,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        };
      },
    };
    const confirm = async () => {
      confirmations += 1;
      return true;
    };
    assert.deepEqual(
      await syncDevelopmentSecrets(
        client,
        { apiUrl: binding.apiUrl },
        initialized.root,
        binding,
        results,
        { confirm },
      ),
      ["GITHUB_TOKEN"],
    );
    assert.deepEqual(uploads, [
      {
        projectId: "prj_test",
        name: "GITHUB_TOKEN",
        value: "first-secret",
        environment: "development",
        allowedOrigins: ["https://api.github.com"],
      },
    ]);
    await syncDevelopmentSecrets(
      client,
      { apiUrl: binding.apiUrl },
      initialized.root,
      binding,
      results,
      { confirm },
    );
    assert.equal(uploads.length, 1);
    await writeFile(
      resolve(initialized.root, "opencomputer", ".env.local"),
      "GITHUB_TOKEN=changed-secret\n",
    );
    await syncDevelopmentSecrets(
      client,
      { apiUrl: binding.apiUrl },
      initialized.root,
      binding,
      results,
      { confirm },
    );
    assert.equal(confirmations, 1);
    assert.equal(uploads.length, 2);
    assert.equal(uploads[1]?.value, "changed-secret");
    const state = await readFile(
      resolve(initialized.root, ".opencomputer", "dev-secrets.json"),
      "utf8",
    );
    assert.doesNotMatch(state, /first-secret|changed-secret/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
