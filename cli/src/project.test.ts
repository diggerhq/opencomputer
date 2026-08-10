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
  findAgentRoot,
  initializeAgentProject as initializeStarterProject,
  initializeTemplateAgentProject as initializeAgentProject,
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

const prReviewTemplate: ManagedAgentTemplate = {
  id: "pr-review-readiness",
  name: "PR review readiness",
  description: "Decide whether a connected PR is ready for human review.",
  category: "Coding",
  integrations: ["GitHub"],
  suggestedPrompts: ["Review this pull request."],
};

test("init creates a multi-agent-ready project and React hello world app", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-project-"));
  const root = resolve(parent, "hello-app");
  try {
    await mkdir(root);
    await writeFile(resolve(root, "NOTES.md"), "# Existing notes\n");
    const initialized = await initializeStarterProject(root);
    assert.equal(initialized.root, root);
    assert.equal(initialized.manifest.name, "Hello World");
    assert.equal(initialized.manifest.id, "hello-world");
    assert.equal(
      initialized.agentRoot,
      resolve(root, "opencomputer", "agents", "hello-world"),
    );
    assert.equal(await findAgentRoot(root), initialized.agentRoot);
    assert.match(
      await readFile(resolve(root, "opencomputer", "project.ts"), "utf8"),
      /name: "hello-app"[\s\S]*agents: \["hello-world"\]/,
    );
    assert.doesNotMatch(
      await readFile(resolve(root, "opencomputer", "project.ts"), "utf8"),
      /id:/,
    );
    assert.match(
      await readFile(resolve(root, "src", "use-agent.ts"), "utf8"),
      /const AGENT = __OPENCOMPUTER_AGENT__[\s\S]*export function useAgent/,
    );
    const packageJSON = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.equal(packageJSON.scripts.dev, "opencomputer dev");
    assert.equal(packageJSON.scripts["dev:web"], "vite");
    assert.equal(packageJSON.dependencies["@opencomputer/agent"], "^0.2.0");
    assert.equal(packageJSON.devDependencies["@opencomputer/cli"], "^0.4.3");
    assert.ok(packageJSON.devDependencies["@types/node"]);
    assert.match(
      await readFile(resolve(root, "vite.config.ts"), "utf8"),
      /command === "serve"/,
    );
    assert.match(
      await readFile(resolve(root, "README.md"), "utf8"),
      /Sync agent code to Development \(Cloud\)/,
    );
    assert.equal(
      await readFile(resolve(root, "NOTES.md"), "utf8"),
      "# Existing notes\n",
    );
    await assert.rejects(stat(resolve(root, "opencomputer", "package.json")));
    const agentRoot = resolve(root, "opencomputer", "agents", "hello-world");
    assert.match(
      await readFile(resolve(agentRoot, "agent.ts"), "utf8"),
      /useInput[\s\S]*useModel\("anthropic\/claude-sonnet-4\.6"\)/,
    );
    for (const removed of [
      "opencomputer.toml",
      "opencomputer.config.ts",
      "opencomputer.ts",
      "opencode.json",
      "README.md",
      "tools",
      "connections",
      "skills",
      "channels",
      "workspace",
      "evals",
    ]) {
      await assert.rejects(stat(resolve(agentRoot, removed)));
    }
    assert.deepEqual(initialized.files, [
      "opencomputer/project.ts",
      "opencomputer/agents/hello-world/agent.ts",
      "package.json",
      "vite.config.ts",
      "tsconfig.json",
      "index.html",
      "README.md",
      ".gitignore",
      "src/App.tsx",
      "src/main.tsx",
      "src/styles.css",
      "src/use-agent.ts",
    ]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a template creates a flat agent repository with stable identity", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-agent-"));
  const original = resolve(parent, "my-inbox-agent");
  const renamed = resolve(parent, "renamed-agent-folder");
  try {
    const initialized = await initializeAgentProject(emailTemplate, original);
    assert.equal((await stat(resolve(original, "agent.ts"))).isFile(), true);
    assert.equal(
      (await stat(resolve(original, "opencomputer.ts"))).isFile(),
      true,
    );
    await assert.rejects(stat(resolve(original, "instructions.md")));
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
    assert.match(gmailTool, /maximum: 25, default: 10/);
    assert.match(gmailTool, /from "@opencomputer\/agent"/);
    assert.match(gmailTool, /format=metadata/);
    assert.match(gmailTool, /export const read_full/);
    assert.equal(
      (
        await stat(resolve(original, "skills", "triage-inbox", "SKILL.md"))
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
    assert.match(
      runtimeInstructions,
      /Use the question tool[\s\S]*resumes when the user replies/,
    );
    assert.doesNotMatch(runtimeInstructions, /Email triage/);
    assert.match(
      await readFile(resolve(runtime, "agent.js"), "utf8"),
      /Email triage/,
    );
    const reactiveManifest = JSON.parse(
      await readFile(
        resolve(runtime, ".opencomputer", "reactive.json"),
        "utf8",
      ),
    ) as {
      version: number;
      entry: string;
      tools: string[];
      toolModules: string[];
      connections: string[];
      mcpServers: string[];
    };
    assert.equal(reactiveManifest.version, 2);
    assert.equal(reactiveManifest.entry, "../agent.js");
    assert.ok(reactiveManifest.tools.includes("gmail_search"));
    assert.ok(reactiveManifest.toolModules.includes("../tools/gmail.js"));
    assert.deepEqual(reactiveManifest.mcpServers, []);
    assert.equal(
      (await stat(resolve(runtime, "tools", "gmail.js"))).isFile(),
      true,
    );
    const connectionTool = await readFile(
      resolve(runtime, "tools", "opencomputer-connections.js"),
      "utf8",
    );
    assert.match(connectionTool, /export const request = tool/);
    assert.match(connectionTool, /opencomputer\/fetch/);
    assert.match(connectionTool, /newAccount/);
    assert.match(
      connectionTool,
      /enum: \["gmail", "calendar", "drive", "sheets", "github"\]/,
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
    const runtimeOpenCode = JSON.parse(
      await readFile(resolve(runtime, "opencode.json"), "utf8"),
    ) as {
      tools: { question: boolean };
      permission: { question: string; calendar_create_time_off?: string };
    };
    assert.equal(runtimeOpenCode.tools.question, true);
    assert.equal(runtimeOpenCode.permission.question, "allow");
    const reactiveAgent = await readFile(resolve(runtime, "agent.js"), "utf8");
    assert.match(reactiveAgent, /start with the `gmail_search` tool/);
    assert.match(reactiveAgent, /summary count exactly matches/);
    assert.equal((await stat(resolve(runtime, "README.md"))).isFile(), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the code-first compiler records hook resources without config files", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-hooks-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeStarterProject(root);
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import {
  connection,
  defineMcpServer,
  useConnection,
  useInput,
  useMcpServer,
  useModel,
  useSubagent,
  useTool,
} from "@opencomputer/agent";

const github = connection("github");
const docs = defineMcpServer({
  id: "docs",
  url: "https://mcp.example.com",
  connection: github,
});

export default function Agent() {
  const input = useInput();
  useModel("anthropic/claude-sonnet-4.6");
  useTool("search-docs");
  useSubagent("researcher");
  useConnection(github);
  if (input.text?.includes("docs")) useMcpServer(docs);
  return "Help with the request.";
}
`,
    );

    const runtime = await prepareAgent(initialized.agentRoot);
    const manifest = JSON.parse(
      await readFile(
        resolve(runtime, ".opencomputer", "reactive.json"),
        "utf8",
      ),
    ) as {
      version: number;
      tools: string[];
      toolModules: string[];
      subagents: string[];
      connections: string[];
      mcpServers: string[];
    };
    assert.deepEqual(manifest, {
      version: 2,
      entry: "../agent.js",
      tools: [
        "opencomputer_connections_list",
        "opencomputer_connections_request",
        "search-docs",
      ],
      toolModules: ["../tools/opencomputer-connections.js"],
      subagents: ["researcher"],
      connections: ["github"],
      mcpServers: ["docs"],
    });
    await assert.rejects(
      stat(resolve(initialized.agentRoot, "opencomputer.toml")),
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler packages OpenComputer tools for native OpenCode 2 registration", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-v2-tools-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeStarterProject(root);
    await mkdir(resolve(initialized.agentRoot, "tools"), { recursive: true });
    await writeFile(
      resolve(initialized.agentRoot, "tools", "hacker-news.ts"),
      `import { tool } from "@opencomputer/agent";

export const hackerNews = tool<{ limit?: number }>({
  id: "hacker_news",
  description: "Fetch current Hacker News stories",
  input: {
    type: "object",
    properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
    additionalProperties: false,
  },
  async execute({ limit = 5 }) {
    return JSON.stringify({ limit });
  },
});
`,
    );
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { useTool } from "@opencomputer/agent";
import { hackerNews } from "./tools/hacker-news.js";

export default function Agent() {
  useTool(hackerNews);
  return "Use the live Hacker News tool.";
}
`,
    );

    const runtime = await prepareAgent(initialized.agentRoot);
    const manifest = JSON.parse(
      await readFile(resolve(runtime, ".opencomputer", "reactive.json"), "utf8"),
    ) as { tools: string[]; toolModules: string[] };
    assert.ok(manifest.tools.includes("hacker_news"));
    assert.ok(manifest.toolModules.includes("../tools/hacker-news.js"));
    assert.match(
      await readFile(resolve(runtime, "tools", "hacker-news.js"), "utf8"),
      /from "\.\.\/opencomputer-agent\.js"/,
    );
    assert.match(
      await readFile(resolve(runtime, "agent.js"), "utf8"),
      /useTool\(hackerNews\)/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler preserves an explicit question denial", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-runtime-"));
  const root = resolve(parent, "no-questions");
  try {
    await initializeAgentProject(emailTemplate, root);
    const sourceConfig = JSON.parse(
      await readFile(resolve(root, "opencode.json"), "utf8"),
    ) as {
      tools: Record<string, unknown>;
      permission: Record<string, unknown>;
    };
    sourceConfig.tools.question = false;
    sourceConfig.permission.question = "deny";
    await writeFile(
      resolve(root, "opencode.json"),
      `${JSON.stringify(sourceConfig, null, 2)}\n`,
    );

    const runtime = await prepareAgent(root);
    const runtimeConfig = JSON.parse(
      await readFile(resolve(runtime, "opencode.json"), "utf8"),
    ) as {
      tools: { question: boolean };
      permission: { question: string };
    };
    assert.equal(runtimeConfig.tools.question, false);
    assert.equal(runtimeConfig.permission.question, "deny");
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
    assert.equal(
      await readFile(resolve(root, "README.md"), "utf8"),
      "# My agent\n",
    );
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
    assert.match(
      calendarTool,
      /const calendarId = args\.calendarId \|\| "primary"/,
    );
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
      (await stat(resolve(root, "skills", "manage-pto", "SKILL.md"))).isFile(),
      true,
    );
    assert.match(
      await readFile(resolve(root, "opencode.json"), "utf8"),
      /calendar_create_time_off/,
    );
    const opencode = JSON.parse(
      await readFile(resolve(root, "opencode.json"), "utf8"),
    ) as {
      permission: { bash: string; question: string };
      tools: { question: boolean };
    };
    assert.equal(opencode.permission.bash, "deny");
    assert.equal(opencode.permission.question, "allow");
    assert.equal(
      (opencode.permission as { calendar_create_time_off?: string })
        .calendar_create_time_off,
      "allow",
    );
    assert.equal(opencode.tools.question, true);
    assert.match(
      await readFile(resolve(root, "agent.ts"), "utf8"),
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

test("the PR readiness template creates brokered read-only GitHub tools", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "pr-review-readiness-"));
  try {
    const initialized = await initializeAgentProject(prReviewTemplate, root);
    assert.ok(initialized.files.includes("tools/github.ts"));
    const githubTool = await readFile(
      resolve(root, "tools", "github.ts"),
      "utf8",
    );
    assert.match(githubTool, /export const pr_context = tool/);
    assert.match(githubTool, /export const checkout = tool/);
    assert.match(githubTool, /issues\/.*\/comments/);
    assert.match(githubTool, /pulls\/.*\/reviews/);
    assert.match(githubTool, /pulls\/.*\/files/);
    assert.match(githubTool, /application\/vnd\.github\.v3\.diff/);
    assert.match(githubTool, /OPENCOMPUTER_CONNECTIONS_URL/);
    assert.match(githubTool, /\/github\/fetch/);
    assert.match(githubTool, /method: "GET"/);
    assert.match(githubTool, /\/contents\//);
    assert.match(githubTool, /MAX_CHECKOUT_FILES = 100/);
    assert.match(githubTool, /resolve\(process\.cwd\(\)\)/);
    assert.doesNotMatch(githubTool, /destination: tool\.schema\.string/);
    assert.doesNotMatch(githubTool, /\/tarball\//);
    assert.match(githubTool, /remoteConfigured: false/);
    assert.doesNotMatch(githubTool, /api\.github\.com/);
    assert.doesNotMatch(githubTool, /git push/i);
    const transpiledGithubTool = ts.transpileModule(githubTool, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      reportDiagnostics: true,
    });
    assert.equal(
      transpiledGithubTool.diagnostics?.length ?? 0,
      0,
      transpiledGithubTool.diagnostics
        ?.map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        )
        .join("\n"),
    );

    const instructions = await readFile(resolve(root, "agent.ts"), "utf8");
    assert.match(instructions, /READY_FOR_HUMAN_REVIEW/);
    assert.match(instructions, /NOT_READY/);
    assert.match(instructions, /NEEDS_INFORMATION/);
    assert.match(
      instructions,
      /credentials remain in the OpenComputer control plane/,
    );
    assert.match(instructions, /Never push/);
    assert.match(instructions, /current OpenComputer session/);

    const built = await buildAgentArtifact(root);
    assert.deepEqual(built.connections, ["github"]);
    assert.deepEqual(built.channels, []);
    assert.match(built.body.toString("utf8"), /tools\/github\.js/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
