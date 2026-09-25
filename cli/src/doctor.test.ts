import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { CompilerError } from "./compiler-error.js";
import { doctorProject } from "./doctor.js";
import { CLIError } from "./errors.js";
import { buildAgentArtifact, initializeAgentProject } from "./project.js";

test("doctor reports deterministic local authoring errors in under one second", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-doctor-"));
  try {
    const initialized = await initializeAgentProject(root);
    await mkdir(resolve(initialized.agentRoot, "connections"), { recursive: true });
    await writeFile(
      resolve(initialized.agentRoot, "connections", "github.ts"),
      `import { defineConnection, defineTool, useSecret } from "@opencomputer/agent";
const origin = "https://api.github.com";
export const github = defineConnection({
  id: "github",
  origin,
  headers: { Authorization: useSecret("GITHUB_TOKEN") },
});
export const misplaced = defineTool({ name: "misplaced", execute: async () => ({ ok: true }) });
`,
    );

    const result = await doctorProject(root);
    assert.equal(result.ok, false);
    assert.ok(result.durationMs < 1_000, `doctor took ${result.durationMs}ms`);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code).sort(),
      [
        "connection_origin_not_literal",
        "development_secret_missing",
        "secret_not_declared",
        "tool_location_invalid",
      ],
    );
    assert.ok(result.diagnostics.every((diagnostic) => diagnostic.hint));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor accepts the initialized project without contacting the API", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-doctor-"));
  try {
    const fetchMock = context.mock.method(globalThis, "fetch", async () => {
      throw new Error("doctor must not use the network");
    });
    await initializeAgentProject(root);
    const result = await doctorProject(root);
    assert.equal(result.ok, true);
    assert.equal(result.summary.errors, 0);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor accepts a managed GitHub provider without an HTTP origin", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-doctor-github-"));
  try {
    const initialized = await initializeAgentProject(root);
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { defineConnection, githubApp, useConnection } from "@opencomputer/agent";
const github = defineConnection({
  id: "github",
  provider: githubApp({ permissions: { contents: "write" } }),
});
export default function Agent() {
  useConnection(github);
  return "Use GitHub.";
}
`,
    );
    const result = await doctorProject(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor parses single-line declarations and ignores comments", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-doctor-"));
  try {
    const initialized = await initializeAgentProject(root);
    await mkdir(resolve(initialized.agentRoot, "connections"), {
      recursive: true,
    });
    await writeFile(
      resolve(initialized.agentRoot, "connections", "inline.ts"),
      `import { defineConnection } from "@opencomputer/agent";
// defineTool({ name: "comment-only" })
export default defineConnection({ id: "inline", origin: "https://api.example.com/path" });
`,
    );
    const result = await doctorProject(root);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ["connection_origin_not_literal"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor scans only source and reports what the checkout resolves to", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-doctor-"));
  try {
    const initialized = await initializeAgentProject(root);
    const tool = (name: string) =>
      `import { defineTool } from "@opencomputer/agent";
export const ${name} = defineTool({ name: "${name}", description: "Echo", async run({ input }) { return input; } });
`;
    await mkdir(resolve(initialized.agentRoot, "tools"), { recursive: true });
    await writeFile(resolve(initialized.agentRoot, "tools", "echo.ts"), tool("echo"));
    // Build output an earlier release wrote inside the source tree, a dependency, and a workspace:
    // none of them is source, so none of them may count as a second declaration.
    for (const directory of [
      resolve(initialized.agentRoot, ".opencomputer", "runtime", "tools"),
      resolve(initialized.agentRoot, "node_modules", "dep"),
      resolve(initialized.agentRoot, "workspace", "tools"),
    ]) {
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, "echo.ts"), tool("echo"));
    }

    let result = await doctorProject(root);
    assert.deepEqual(
      result.diagnostics.filter((diagnostic) =>
        ["tool_name_duplicate", "tool_location_invalid"].includes(diagnostic.code),
      ),
      [],
    );
    assert.deepEqual(result.resolution, {
      project: null,
      agents: [{ localId: "hello-world", agentId: null }],
    });

    await mkdir(resolve(root, ".opencomputer"), { recursive: true });
    await writeFile(
      resolve(root, ".opencomputer", "project.json"),
      JSON.stringify({
        version: 1,
        apiUrl: "https://app.opencomputer.dev",
        projectId: "prj_1",
        projectName: "Workbench",
        agentId: "workbench",
      }),
    );
    result = await doctorProject(root);
    assert.deepEqual(result.resolution, {
      project: { id: "prj_1", name: "Workbench", apiUrl: "https://app.opencomputer.dev" },
      agents: [{ localId: "hello-world", agentId: "workbench" }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// OCFR-18: `doctor --json` passed a project whose connection took its
// `pathPrefix` from a constant, and the next secret upload rejected it. Doctor
// now compiles every member the way deploy and secret upload do.

const CONNECTION_AGENT = (id: string, pathPrefix: string) =>
  `import { bearer, defineConnection, useConnection, useSecret } from "@opencomputer/agent";
const prefix = "/v1";
const api = defineConnection({
  id: "${id}-api",
  origin: "https://${id}.example.com",
  pathPrefix: ${pathPrefix},
  headers: { Authorization: bearer(useSecret("API_TOKEN")) },
});
export default function Agent() { useConnection(api); return "${id}"; }
`;

async function projectWithAgents(
  root: string,
  agents: Record<string, string>,
): Promise<void> {
  await initializeAgentProject(root);
  for (const [id, source] of Object.entries(agents)) {
    const agentRoot = resolve(root, "opencomputer", "agents", id);
    await mkdir(agentRoot, { recursive: true });
    await writeFile(resolve(agentRoot, "agent.ts"), source);
  }
  await writeFile(
    resolve(root, "opencomputer", "project.ts"),
    `export default { name: "app", agents: ${JSON.stringify(["hello-world", ...Object.keys(agents)])} };\n`,
  );
  await writeFile(resolve(root, "opencomputer", ".env.example"), "API_TOKEN=\n");
  await writeFile(resolve(root, "opencomputer", ".env.local"), "API_TOKEN=x\n");
}

test("acceptance 4, 5 and 8: doctor reports the compiler's requirements per agent, with source positions", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-doctor-"));
  try {
    await projectWithAgents(root, {
      billing: CONNECTION_AGENT("billing", "prefix"),
      support: CONNECTION_AGENT("support", '"/v2"'),
      search: CONNECTION_AGENT("search", "`/v${3}`"),
    });
    const result = await doctorProject(root);
    assert.equal(result.ok, false);
    const compiled = result.diagnostics.filter((diagnostic) => diagnostic.agent);
    assert.deepEqual(compiled, [
      {
        code: "literal_required",
        severity: "error",
        file: "opencomputer/agents/billing/agent.ts",
        line: 6,
        column: 15,
        agent: { localId: "billing", agentId: null },
        message: "connection billing-api pathPrefix must be a string literal",
        hint: compiled[0]!.hint,
      },
      {
        code: "literal_required",
        severity: "error",
        file: "opencomputer/agents/search/agent.ts",
        line: 6,
        column: 15,
        agent: { localId: "search", agentId: null },
        message: "connection search-api pathPrefix must be a string literal",
        hint: compiled[1]!.hint,
      },
    ]);
    assert.match(compiled[0]!.hint, /literal/);

    // The same requirement, worded the same, is what deploy and secret upload raise.
    await assert.rejects(
      buildAgentArtifact(resolve(root, "opencomputer", "agents", "billing")),
      (error: unknown) =>
        error instanceof CompilerError &&
        error.code === "literal_required" &&
        error.message === compiled[0]!.message &&
        error.position?.line === 6,
    );

    await writeFile(
      resolve(root, "opencomputer", "agents", "billing", "agent.ts"),
      CONNECTION_AGENT("billing", '"/v1"'),
    );
    await writeFile(
      resolve(root, "opencomputer", "agents", "search", "agent.ts"),
      CONNECTION_AGENT("search", '"/v3"'),
    );
    const fixed = await doctorProject(root);
    assert.equal(fixed.ok, true, JSON.stringify(fixed.diagnostics));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acceptance 6: agent-level doctor checks the selected member only", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-doctor-"));
  try {
    await projectWithAgents(root, {
      // Broken for both the source scan (origin with a path) and the compiler (pathPrefix).
      billing: CONNECTION_AGENT("billing", "prefix").replace(
        "https://billing.example.com",
        "https://billing.example.com/v1",
      ),
      support: CONNECTION_AGENT("support", '"/v2"'),
    });
    const whole = await doctorProject(root);
    assert.ok(
      whole.diagnostics.some((diagnostic) => diagnostic.code === "connection_origin_not_literal"),
    );

    const support = await doctorProject(root, { selector: { localAgent: "support" } });
    assert.equal(support.ok, true, JSON.stringify(support.diagnostics));
    assert.deepEqual(support.resolution.selected, { localId: "support", agentId: null });
    assert.equal(support.resolution.agents.length, 3);

    const billing = await doctorProject(root, { selector: { agent: "billing" } });
    assert.equal(billing.ok, false);
    assert.equal(billing.diagnostics.length, 2);
    assert.equal(billing.diagnostics[0]!.code, "connection_origin_not_literal");
    assert.equal(billing.diagnostics[1]!.agent?.localId, "billing");
    for (const diagnostic of billing.diagnostics) {
      assert.equal(diagnostic.file, "opencomputer/agents/billing/agent.ts");
    }

    await assert.rejects(
      doctorProject(root, { selector: { agent: "payments" } }),
      (error: unknown) =>
        error instanceof CLIError &&
        error.code === "local_agent_not_found" &&
        /hello-world, billing, support/.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
