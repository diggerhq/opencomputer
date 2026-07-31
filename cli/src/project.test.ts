import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import type { ManagedAgentTemplate } from "./api.js";
import {
  buildAgentArtifact,
  initializeAgentProject,
  prepareAgent,
} from "./project.js";

const emailTemplate: ManagedAgentTemplate = {
  id: "email-triage",
  name: "Email triage",
  description: "Triage email and prepare replies for approval.",
  category: "Comms",
  integrations: ["Gmail", "OpenComputer"],
  suggestedPrompts: ["Triage today's inbox."],
};

test("a template creates a flat agent repository with stable identity", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-agent-"));
  const original = resolve(parent, "my-inbox-agent");
  const renamed = resolve(parent, "renamed-agent-folder");
  try {
    await initializeAgentProject(emailTemplate, original);
    assert.equal(
      (await stat(resolve(original, "instructions.md"))).isFile(),
      true,
    );
    assert.equal((await stat(resolve(original, "tools"))).isDirectory(), true);
    await assert.rejects(stat(resolve(original, "agent")));
    assert.equal(
      (await stat(resolve(original, "opencode.json"))).isFile(),
      true,
    );
    const gmailTool = await readFile(
      resolve(original, "tools", "gmail.ts"),
      "utf8",
    );
    assert.match(gmailTool, /max\(25\)\.default\(10\)/);
    assert.match(gmailTool, /format=metadata/);
    assert.match(gmailTool, /export const read_full/);
    assert.equal(
      (
        await stat(
          resolve(original, "skills", "triage-inbox", "SKILL.md"),
        )
      ).isFile(),
      true,
    );
    assert.match(
      await readFile(resolve(original, "opencomputer.toml"), "utf8"),
      /id = "my-inbox-agent"/,
    );

    await rename(original, renamed);
    assert.equal((await buildAgentArtifact(renamed)).agentId, "my-inbox-agent");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler maps flat source into an OpenCode runtime", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-runtime-"));
  const root = resolve(parent, "email-triage");
  try {
    await initializeAgentProject(emailTemplate, root);
    const runtime = await prepareAgent(root);
    assert.match(
      await readFile(resolve(runtime, "AGENTS.md"), "utf8"),
      /Email triage/,
    );
    assert.equal(
      (await stat(resolve(runtime, ".opencode", "tools", "gmail.ts"))).isFile(),
      true,
    );
    assert.equal(
      (await stat(resolve(runtime, "opencode.json"))).isFile(),
      true,
    );
    assert.match(
      await readFile(resolve(runtime, "AGENTS.md"), "utf8"),
      /start with the `gmail_search` tool/,
    );
    assert.match(
      await readFile(resolve(runtime, "AGENTS.md"), "utf8"),
      /summary count exactly matches/,
    );
    assert.equal(
      (await stat(resolve(runtime, "README.md"))).isFile(),
      true,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a template initializes at the root of a fresh Git repository", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gmail-summarizer-"));
  try {
    await mkdir(resolve(root, ".git"));
    await writeFile(resolve(root, "README.md"), "# My agent\n");
    await writeFile(resolve(root, ".gitignore"), ".DS_Store\n");

    const initialized = await initializeAgentProject(emailTemplate, root);
    assert.equal(initialized.root, root);
    assert.equal(initialized.manifest.id.startsWith("gmail-summarizer-"), true);
    assert.equal(await readFile(resolve(root, "README.md"), "utf8"), "# My agent\n");
    const gitignore = await readFile(resolve(root, ".gitignore"), "utf8");
    assert.match(gitignore, /\.DS_Store/);
    assert.match(gitignore, /\.opencomputer\//);
    await assert.rejects(
      initializeAgentProject(emailTemplate, root),
      /Target already contains agent files/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
