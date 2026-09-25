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
    environmentMode: "legacy",
    agents: [{ id: "agent-cloud", name: "Hello World" }],
    environments: [
      { name: "development", updatedAt: "2026-08-09T00:00:00.000Z" },
      { name: "production", updatedAt: "2026-08-09T00:00:00.000Z" },
    ],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

test("link persists the selected project and later commands reuse its binding", async () => {
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
      { project: "existing-project", persist: true },
    );
    assert.equal(selected.projectId, "prj_existing");
    assert.equal(selected.agentId, "agent-cloud");
    assert.equal(selected.environmentMode, "legacy");
    assert.equal((await readManifest(initialized.agentRoot)).id, "hello-world");
    const projectSource = await readFile(
      resolve(root, "opencomputer", "project.ts"),
      "utf8",
    );
    assert.doesNotMatch(projectSource, /prj_existing|agent-cloud/);
    assert.match(projectSource, /name:/);
    const { environmentMode: _mode, ...saved } = selected;
    assert.deepEqual(
      JSON.parse(await readFile(resolve(root, ".opencomputer", "project.json"), "utf8")),
      saved,
    );

    const reused = await ensureProjectBinding(
      client,
      config,
      initialized.agentRoot,
      {},
    );
    assert.deepEqual(reused, selected);
    assert.equal(creates, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-interactive commands direct an unlinked app to link", async () => {
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
        {},
      ),
      /opencomputer link/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit project creation reuses the existing slug on retry", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-binding-"));
  try {
    const initialized = await initializeAgentProject(root);
    let creates = 0;
    const binding = await ensureProjectBinding(
      {
        async projects() {
          return [project()];
        },
        async createProject() {
          creates += 1;
          return project();
        },
      },
      { apiUrl: "https://app.opencomputer.dev" },
      initialized.agentRoot,
      { createProjectName: "Existing Project" },
    );
    assert.equal(binding.projectId, "prj_existing");
    assert.equal(creates, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cloud agent ids and the resolution a command prints", async () => {
  const { cloudAgentId, describeResolution } = await import("./binding.js");
  const binding = {
    version: 1 as const,
    apiUrl: "https://app.opencomputer.dev",
    projectId: "prj_1",
    projectName: "Workbench",
    agentId: "workbench",
  };
  assert.equal(cloudAgentId(binding, "worker", 0), "workbench");
  assert.equal(cloudAgentId(binding, "reviewer", 1), "workbench--reviewer");
  assert.equal(
    describeResolution({ binding, localIds: ["worker", "reviewer"], alias: "development" }),
    "Project: Workbench (prj_1) at https://app.opencomputer.dev, alias development\n" +
      "Agent:   worker -> workbench\n" +
      "Agent:   reviewer -> workbench--reviewer\n",
  );
  assert.match(describeResolution({ binding: null, localIds: ["worker"] }), /not linked/);
});

test("--project resolves a project for one command without rewriting the saved binding", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-binding-"));
  try {
    const initialized = await initializeAgentProject(root);
    const other: ManagedProject = {
      ...project(),
      id: "prj_other",
      slug: "other-project",
      name: "Other project",
      environmentMode: "single",
      agents: [{ id: "other-agent", name: "Other" }],
    };
    const client = {
      async projects() {
        return [project(), other];
      },
      async createProject() {
        throw new Error("unexpected create");
      },
    };
    const config = { apiUrl: "https://app.opencomputer.dev" };
    const bindingPath = resolve(root, ".opencomputer", "project.json");

    const overridden = await ensureProjectBinding(client, config, initialized.agentRoot, {
      project: "prj_other",
    });
    assert.equal(overridden.projectId, "prj_other");
    assert.equal(overridden.environmentMode, "single");
    await assert.rejects(readFile(bindingPath, "utf8"), /ENOENT/);

    const linked = await ensureProjectBinding(client, config, initialized.agentRoot, {
      project: "existing-project",
      persist: true,
    });
    assert.equal(linked.projectId, "prj_existing");
    const saved = await readFile(bindingPath, "utf8");

    const again = await ensureProjectBinding(client, config, initialized.agentRoot, {
      project: "other-project",
    });
    assert.equal(again.projectId, "prj_other");
    assert.equal(await readFile(bindingPath, "utf8"), saved);
    assert.equal(
      (await ensureProjectBinding(client, config, initialized.agentRoot)).projectId,
      "prj_existing",
    );
    assert.doesNotMatch(saved, /environmentMode|apiKey|deployment/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--project and --create-project cannot be combined", async () => {
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
        { project: "prj_existing", createProjectName: "New" },
      ),
      /cannot be combined/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
