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
