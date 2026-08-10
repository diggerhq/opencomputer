import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import type { ManagedProject } from "./api.js";
import { ensureProjectBinding } from "./binding.js";
import { initializeAgentProject, readManifest } from "./project.js";

function project(): ManagedProject {
  return {
    id: "prj_existing",
    slug: "existing-project",
    name: "Existing project",
    agents: [{ id: "agent-cloud", name: "Hello World" }],
    environments: [
      { name: "development", updatedAt: "2026-08-09T00:00:00.000Z" },
      { name: "production", updatedAt: "2026-08-09T00:00:00.000Z" },
    ],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

test("first dev can select an existing project and later reuses its binding", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-binding-"));
  try {
    const initialized = await initializeAgentProject(root);
    let creates = 0;
    const client = {
      async projects() {
        return [project()];
      },
      async createProject() {
        creates += 1;
        return project();
      },
    };
    const config = { apiUrl: "https://app.opencomputer.dev", apiKey: "test" };
    const selected = await ensureProjectBinding(
      client,
      config,
      initialized.agentRoot,
      { project: "existing-project", interactive: false },
    );
    assert.equal(selected.projectId, "prj_existing");
    assert.equal(selected.agentId, "agent-cloud");
    assert.equal((await readManifest(initialized.agentRoot)).id, "hello-world");
    const projectSource = await readFile(
      resolve(root, "opencomputer", "project.ts"),
      "utf8",
    );
    assert.doesNotMatch(projectSource, /prj_existing|agent-cloud/);
    assert.match(projectSource, /name:/);
    assert.deepEqual(
      JSON.parse(await readFile(resolve(root, ".opencomputer", "project.json"), "utf8")),
      selected,
    );

    const reused = await ensureProjectBinding(
      client,
      config,
      initialized.agentRoot,
      { interactive: false },
    );
    assert.deepEqual(reused, selected);
    assert.equal(creates, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-interactive dev requires an explicit project choice", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-binding-"));
  try {
    const initialized = await initializeAgentProject(root);
    await assert.rejects(
      ensureProjectBinding(
        {
          async projects() {
            return [project()];
          },
          async createProject() {
            return project();
          },
        },
        { apiUrl: "https://app.opencomputer.dev" },
        initialized.agentRoot,
        { interactive: false },
      ),
      /--project <id\|slug>/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
