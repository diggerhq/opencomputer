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
import ts from "typescript";

import type { ManagedAgentTemplate } from "./api.js";
import {
  buildAgentArtifact,
  initializeAgentProject,
  prepareAgent,
  readManifest,
} from "./project.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRETTY_NAME_PATTERN = /^[A-Z][a-z]+ [A-Z][a-z]+$/;

const emailTemplate: ManagedAgentTemplate = {
  id: "email-triage",
  name: "Email triage",
  description: "Triage email and prepare replies for approval.",
  category: "Comms",
  integrations: ["Gmail", "OpenComputer"],
  suggestedPrompts: ["Triage today's inbox."],
};

const ptoTemplate: ManagedAgentTemplate = {
  id: "pto-calendar",
  name: "PTO calendar",
  description: "Prepare PTO events and check calendar conflicts.",
  category: "Admin",
  integrations: ["Google Calendar", "Slack"],
  suggestedPrompts: ["Prepare PTO and check conflicts."],
};

test("a template creates a flat agent repository with stable identity", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-agent-"));
  const original = resolve(parent, "my-inbox-agent");
  const renamed = resolve(parent, "renamed-agent-folder");
  try {
    const initialized = await initializeAgentProject(emailTemplate, original);
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
    assert.match(initialized.manifest.id, UUID_PATTERN);
    assert.match(initialized.manifest.name, PRETTY_NAME_PATTERN);
    assert.match(
      await readFile(resolve(original, "opencomputer.toml"), "utf8"),
      new RegExp(`id = "${initialized.manifest.id}"`),
    );

    await rename(original, renamed);
    assert.deepEqual(await readManifest(renamed), initialized.manifest);
    assert.equal(
      (await buildAgentArtifact(renamed)).agentId,
      initialized.manifest.id,
    );
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
    const runtimeInstructions = await readFile(
      resolve(runtime, "AGENTS.md"),
      "utf8",
    );
    assert.match(runtimeInstructions, /You are an OpenComputer agent/);
    assert.match(runtimeInstructions, /Never direct users to OpenCode/);
    assert.match(runtimeInstructions, /Email triage/);
    assert.equal(
      (await stat(resolve(runtime, ".opencode", "tools", "gmail.ts"))).isFile(),
      true,
    );
    const connectionTool = await readFile(
      resolve(runtime, ".opencode", "tools", "opencomputer-connections.ts"),
      "utf8",
    );
    assert.match(connectionTool, /export const request = tool/);
    assert.match(connectionTool, /opencomputer\/fetch/);
    assert.match(connectionTool, /newAccount/);
    assert.match(
      connectionTool,
      /schema\.enum\(\["gmail", "calendar", "drive", "sheets"\]\)/,
    );
    assert.equal(connectionTool.includes('base.replace(/\\\/$/, "")'), true);
    const transpiledConnectionTool = ts.transpileModule(connectionTool, {
      compilerOptions: { module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    });
    assert.equal(
      transpiledConnectionTool.diagnostics?.length ?? 0,
      0,
      transpiledConnectionTool.diagnostics
        ?.map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        )
        .join("\n"),
    );
    assert.equal(
      (await stat(resolve(runtime, "opencode.json"))).isFile(),
      true,
    );
    assert.match(runtimeInstructions, /start with the `gmail_search` tool/);
    assert.match(runtimeInstructions, /summary count exactly matches/);
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
    assert.match(initialized.manifest.id, UUID_PATTERN);
    assert.match(initialized.manifest.name, PRETTY_NAME_PATTERN);
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

test("the PTO template creates Calendar tools without checked-in channel state", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "pto-calendar-"));
  try {
    const initialized = await initializeAgentProject(ptoTemplate, root);
    assert.match(initialized.manifest.id, UUID_PATTERN);
    const calendarTool = await readFile(
      resolve(root, "tools", "calendar.ts"),
      "utf8",
    );
    assert.match(calendarTool, /export const list = tool/);
    assert.match(calendarTool, /export const events = tool/);
    assert.match(calendarTool, /export const freebusy = tool/);
    assert.match(calendarTool, /export const create_time_off = tool/);
    assert.doesNotMatch(calendarTool, /calendar\/v3/);
    assert.match(calendarTool, /const calendarId = args\.calendarId \|\| "primary"/);
    assert.match(calendarTool, /: \["primary"\]/);
    assert.match(calendarTool, /end: \{ date: nextDate\(endDate\) \}/);
    assert.match(calendarTool, /result\.detail/);
    assert.match(calendarTool, /upstream\.error\?\.message/);
    const transpiledCalendarTool = ts.transpileModule(calendarTool, {
      compilerOptions: { module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    });
    assert.equal(
      transpiledCalendarTool.diagnostics?.length ?? 0,
      0,
      transpiledCalendarTool.diagnostics
        ?.map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        )
        .join("\n"),
    );
    const connection = JSON.parse(
      await readFile(resolve(root, "connections", "google.json"), "utf8"),
    ) as { services: string[]; scopes: string[] };
    assert.deepEqual(connection.services, ["calendar"]);
    assert.ok(
      connection.scopes.includes("https://www.googleapis.com/auth/calendar"),
    );
    assert.equal(
      (
        await stat(resolve(root, "skills", "manage-pto", "SKILL.md"))
      ).isFile(),
      true,
    );
    assert.match(
      await readFile(resolve(root, "opencode.json"), "utf8"),
      /calendar_create_time_off/,
    );
    const opencode = JSON.parse(
      await readFile(resolve(root, "opencode.json"), "utf8"),
    ) as { permission: { bash: string } };
    assert.equal(opencode.permission.bash, "deny");
    assert.match(
      await readFile(resolve(root, "agent.ts"), "utf8"),
      /shell: "deny"/,
    );
    assert.match(
      await readFile(resolve(root, "instructions.md"), "utf8"),
      /Never[\s\S]*curl[\s\S]*managed connection/,
    );
    assert.match(
      await readFile(resolve(root, "skills", "manage-pto", "SKILL.md"), "utf8"),
      /Never use bash[\s\S]*direct Google API requests/,
    );
    await assert.rejects(stat(resolve(root, "channels", "slack.ts")));
    await assert.rejects(stat(resolve(root, "slack", "manifest.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an incomplete PTO project cannot be packaged without Calendar tools", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "pto-calendar-incomplete-"));
  try {
    await initializeAgentProject(ptoTemplate, root);
    await rm(resolve(root, "tools", "calendar.ts"));
    await assert.rejects(
      buildAgentArtifact(root),
      /opencomputer tools add calendar/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
