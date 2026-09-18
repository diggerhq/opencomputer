import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { doctorProject } from "./doctor.js";
import { initializeAgentProject } from "./project.js";

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
