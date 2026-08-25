import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  buildAgentArtifact,
  findAgentRoot,
  initializeAgentProject,
  prepareAgent,
  readProjectResources,
} from "./project.js";

test("init creates a multi-agent-ready hello-world agent by default", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-project-"));
  const root = resolve(parent, "hello-app");
  try {
    await mkdir(root);
    await writeFile(resolve(root, "NOTES.md"), "# Existing notes\n");
    const initialized = await initializeAgentProject(root);
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
    await assert.rejects(stat(resolve(root, "src")));
    await assert.rejects(stat(resolve(root, "vite.config.ts")));
    const packageJSON = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.equal(packageJSON.scripts.dev, undefined);
    assert.equal(packageJSON.scripts["dev:web"], undefined);
    assert.equal(packageJSON.scripts.deploy, "opencomputer deploy");
    assert.equal(packageJSON.dependencies["@opencomputer/agent"], "^0.5.0");
    assert.equal(packageJSON.dependencies["@opencomputer/react"], undefined);
    assert.equal(packageJSON.devDependencies["@opencomputer/cli"], "^0.6.1");
    assert.equal(packageJSON.devDependencies["@types/node"], undefined);
    assert.match(
      await readFile(resolve(root, "README.md"), "utf8"),
      /Deploy agent changes to Development \(Cloud\)[\s\S]*npm run deploy -- --watch[\s\S]*opencomputer\/\.env\.local/,
    );
    assert.match(
      await readFile(resolve(root, "opencomputer", ".env.example"), "utf8"),
      /useSecret\(\)/,
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
      "workspace",
      "evals",
    ]) {
      await assert.rejects(stat(resolve(agentRoot, removed)));
    }
    assert.deepEqual(initialized.files, [
      "opencomputer/project.ts",
      "opencomputer/.env.example",
      "opencomputer/agents/hello-world/agent.ts",
      "package.json",
      "README.md",
      ".gitignore",
    ]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler normalizes project channels, registrations, and outboxes", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-channels-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root, undefined, {
      spa: false,
    });
    const opencomputer = resolve(root, "opencomputer");
    await mkdir(resolve(opencomputer, "channels"), { recursive: true });
    await mkdir(resolve(opencomputer, "outboxes"), { recursive: true });
    await mkdir(resolve(initialized.agentRoot, "channels"), { recursive: true });
    await mkdir(resolve(initialized.agentRoot, "outboxes"), { recursive: true });
    await writeFile(
      resolve(opencomputer, "channels", "team-slack.ts"),
      `import { defineChannel } from "@opencomputer/agent";
export default defineChannel({
  id: "team-slack",
  type: "slack",
  scopes: { bot: ["chat:write", "channels:read", "app_mentions:read"] },
  events: ["app_mention"],
  destinations: {
    "pull-request-reviews": { type: "conversation", visibility: "public" },
  },
  routing: { whenAmbiguous: "ask" },
});
`,
    );
    await writeFile(
      resolve(opencomputer, "outboxes", "review-requests.ts"),
      `import { defineOutbox } from "@opencomputer/agent";
import teamSlack from "../channels/team-slack.js";
export default defineOutbox({
  id: "review-requests",
  delivery: { channel: teamSlack, destination: "pull-request-reviews" },
});
`,
    );
    await writeFile(
      resolve(initialized.agentRoot, "channels", "team-slack.ts"),
      `import { registerChannel } from "@opencomputer/agent";
import teamSlack from "../../../channels/team-slack.js";
export default registerChannel(teamSlack, { on: ["mention"] });
`,
    );
    await writeFile(
      resolve(initialized.agentRoot, "outboxes", "review-requests.ts"),
      `import { registerOutbox } from "@opencomputer/agent";
import reviewRequests from "../../../outboxes/review-requests.js";
export default registerOutbox(reviewRequests);
`,
    );

    const built = await readProjectResources(root);
    assert.match(built.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(built.manifest, {
      version: 1,
      channels: [
        {
          id: "team-slack",
          type: "slack",
          scopes: {
            bot: ["app_mentions:read", "channels:read", "chat:write"],
          },
          events: ["app_mention"],
          destinations: {
            "pull-request-reviews": {
              type: "conversation",
              visibility: "public",
            },
          },
          routing: { whenAmbiguous: "ask" },
        },
      ],
      channelRegistrations: [
        {
          agentId: "hello-world",
          channelId: "team-slack",
          triggers: ["mention"],
        },
      ],
      outboxes: [
        {
          id: "review-requests",
          channelId: "team-slack",
          destination: "pull-request-reviews",
        },
      ],
      outboxRegistrations: [
        { agentId: "hello-world", outboxId: "review-requests" },
      ],
      schedules: [],
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler normalizes code-defined agent schedules", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-schedules-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root, undefined, { spa: false });
    await mkdir(resolve(initialized.agentRoot, "schedules"), { recursive: true });
    await writeFile(
      resolve(initialized.agentRoot, "schedules", "weekday-hygiene.ts"),
      `import { defineSchedule } from "@opencomputer/agent";
export default defineSchedule({
  id: "weekday-hygiene",
  cron: "0 9 * * 1-5",
  timezone: "America/Los_Angeles",
  enabled: ["development", "production"],
  overlap: "skip",
  dispatch: {
    text: "Run feature flag hygiene.",
    payload: { repository: "acme/widgets", dryRun: false, labels: ["cleanup"] },
  },
});
`,
    );
    const built = await readProjectResources(root);
    assert.deepEqual(built.manifest.schedules, [
      {
        id: "weekday-hygiene",
        agentId: "hello-world",
        cron: "0 9 * * 1-5",
        timezone: "America/Los_Angeles",
        enabled: ["development", "production"],
        overlap: "skip",
        dispatch: {
          text: "Run feature flag hygiene.",
          payload: {
            repository: "acme/widgets",
            dryRun: false,
            labels: ["cleanup"],
          },
        },
      },
    ]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("init can explicitly include a separately-run React app", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-with-spa-"));
  const root = resolve(parent, "hello-app");
  try {
    const initialized = await initializeAgentProject(root, undefined, {
      spa: true,
    });
    await stat(
      resolve(root, "opencomputer", "agents", "hello-world", "agent.ts"),
    );
    await stat(resolve(root, "src", "App.tsx"));
    await stat(resolve(root, "vite.config.ts"));
    const packageJSON = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.deepEqual(packageJSON.scripts, {
      "dev:web": "vite",
      build: "tsc -b && vite build",
      session: "opencomputer session",
      deploy: "opencomputer deploy",
    });
    assert.equal(packageJSON.dependencies["@opencomputer/react"], "^0.1.0");
    assert.equal(packageJSON.dependencies.react, "^19.2.0");
    assert.equal(packageJSON.devDependencies.vite, "^8.0.0");
    assert.equal(packageJSON.devDependencies["@opencomputer/cli"], "^0.6.1");
    const viteConfig = await readFile(resolve(root, "vite.config.ts"), "utf8");
    assert.match(viteConfig, /npm run deploy -- --watch/);
    assert.deepEqual(initialized.files, [
      "opencomputer/project.ts",
      "opencomputer/.env.example",
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
    ]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the code-first compiler records hook resources without config files", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-hooks-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import {
  defineMcpServer,
  useInput,
  useMcpServer,
  useModel,
  useSubagent,
  useTool,
} from "@opencomputer/agent";

const docs = defineMcpServer({
  id: "docs",
  url: "https://mcp.example.com",
});

export default function Agent() {
  const input = useInput();
  useModel("anthropic/claude-sonnet-4.6");
  useTool("search-docs");
  useSubagent("researcher");
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
      httpConnections: unknown[];
      mcpServers: string[];
      mcpServerDefinitions: Array<{
        id: string;
        url: string;
        connection?: string;
      }>;
      models: Array<{ provider: string; model: string }>;
    };
    assert.deepEqual(manifest, {
      version: 2,
      entry: "../agent.js",
      tools: ["search-docs"],
      toolModules: [],
      subagents: ["researcher"],
      connections: [],
      httpConnections: [],
      mcpServers: ["docs"],
      mcpServerDefinitions: [
        { id: "docs", url: "https://mcp.example.com/" },
      ],
      models: [
        {
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4.6",
        },
      ],
    });
    assert.equal(
      (
        JSON.parse(
          await readFile(resolve(runtime, "opencode.json"), "utf8"),
        ) as { model: string }
      ).model,
      "openrouter/anthropic/claude-sonnet-4.6",
    );
    await assert.rejects(
      stat(resolve(initialized.agentRoot, "opencomputer.toml")),
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler preserves an explicit OpenAI model selection for Codex routing", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-openai-model-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { useModel } from "@opencomputer/agent";

export default function Agent() {
  useModel({ provider: "openai", model: "gpt-5" });
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
    ) as { models: Array<{ provider: string; model: string }> };
    assert.deepEqual(manifest.models, [{ provider: "openai", model: "gpt-5" }]);
    assert.equal(
      (
        JSON.parse(
          await readFile(resolve(runtime, "opencode.json"), "utf8"),
        ) as { model: string }
      ).model,
      "openai/gpt-5",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler records secret-backed HTTP connections without secret values", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-egress-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await mkdir(resolve(initialized.agentRoot, "tools"), { recursive: true });
    await writeFile(
      resolve(initialized.agentRoot, "tools", "github.ts"),
      `import { bearer, defineConnection, defineTool, useSecret } from "@opencomputer/agent";

export const github = defineConnection({
  id: "github-api",
  origin: "https://api.github.com",
  methods: ["GET"],
  pathPrefix: "/repos/",
  redirectOrigins: [
    {
      origin: "https://codeload.github.com",
      pathPrefix: "/opencomputer/example/",
    },
  ],
  headers: { Authorization: bearer(useSecret("GITHUB_TOKEN")) },
});

export const repository = defineTool({
  name: "github_repository",
  description: "Read a GitHub repository",
  async run() {
    const response = await github.fetch("/repos/opencomputer/example");
    return await response.json();
  },
});
`,
    );
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { useTool } from "@opencomputer/agent";
import { repository } from "./tools/github.js";

export default function Agent() {
  useTool(repository);
  return "Use GitHub when needed.";
}
`,
    );

    const built = await buildAgentArtifact(initialized.agentRoot);
    await assert.doesNotReject(
      import(
        `${pathToFileURL(resolve(initialized.agentRoot, ".opencomputer", "runtime", "opencomputer-agent.js")).href}?test=${crypto.randomUUID()}`
      ),
    );
    assert.deepEqual(built.httpConnections, [
      {
        id: "github-api",
        origin: "https://api.github.com",
        methods: ["GET"],
        pathPrefix: "/repos/",
        redirectOrigins: [
          {
            origin: "https://codeload.github.com",
            pathPrefix: "/opencomputer/example/",
          },
        ],
        headers: {
          Authorization: {
            kind: "secret",
            name: "GITHUB_TOKEN",
            prefix: "Bearer ",
          },
        },
      },
    ]);
    assert.ok(built.connections.includes("github-api"));
    assert.doesNotMatch(built.body.toString("utf8"), /actual-secret-value/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler records managed MCP server definitions", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-mcp-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { bearer, defineConnection, defineMcpServer, useMcpServer, useSecret } from "@opencomputer/agent";

const unleash = defineConnection({
  id: "unleash-api",
  origin: "https://example.getunleash.io",
  pathPrefix: "/api/admin/mcp",
  headers: { Authorization: bearer(useSecret("UNLEASH_TOKEN")) },
});
const server = defineMcpServer({
  id: "unleash",
  url: "https://example.getunleash.io/api/admin/mcp",
  connection: unleash,
});
export default function Agent() {
  useMcpServer(server);
  return "Use Unleash.";
}
`,
    );
    const runtime = await prepareAgent(initialized.agentRoot);
    const manifest = JSON.parse(
      await readFile(resolve(runtime, ".opencomputer", "reactive.json"), "utf8"),
    ) as { mcpServerDefinitions: unknown[] };
    assert.deepEqual(manifest.mcpServerDefinitions, [
      {
        id: "unleash",
        url: "https://example.getunleash.io/api/admin/mcp",
        connection: "unleash-api",
      },
    ]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("packaged tools can publish to a registered outbox by id", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-outbox-publish-"));
  const root = resolve(parent, "app");
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.OPENCOMPUTER_OUTBOX_URL;
  const originalToken = process.env.OPENCOMPUTER_OUTBOX_TOKEN;
  try {
    const initialized = await initializeAgentProject(root);
    await mkdir(resolve(initialized.agentRoot, "tools"), { recursive: true });
    await writeFile(
      resolve(initialized.agentRoot, "tools", "notify.ts"),
      `import { defineTool, publishOutbox } from "@opencomputer/agent";
export const notify = defineTool({
  name: "notify_reviewer",
  description: "Notify a pull request reviewer",
  async run() {
    return publishOutbox("review-requests", {
      type: "pull-request.ready",
      idempotencyKey: "example/repo#42",
      content: { title: "Review requested", url: "https://example.com/pull/42" },
    });
  },
});
`,
    );
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { useTool } from "@opencomputer/agent";
import { notify } from "./tools/notify.js";
export default function Agent() { useTool(notify); return "Notify reviewers."; }
`,
    );

    const runtimeRoot = await prepareAgent(initialized.agentRoot);
    const manifest = JSON.parse(
      await readFile(resolve(runtimeRoot, ".opencomputer", "reactive.json"), "utf8"),
    ) as { tools: string[] };
    assert.ok(manifest.tools.includes("notify_reviewer"));
    process.env.OPENCOMPUTER_OUTBOX_URL = "http://outbox.test/outboxes";
    process.env.OPENCOMPUTER_OUTBOX_TOKEN = "runtime-token";
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      request = { url: String(url), init };
      return Response.json({ id: "item-1", status: "pending", duplicate: false }, { status: 202 });
    }) as typeof fetch;
    const runtime = await import(
      `${pathToFileURL(resolve(runtimeRoot, "opencomputer-agent.js")).href}?test=${crypto.randomUUID()}`
    ) as { publishOutbox(id: string, input: unknown): Promise<unknown> };
    await runtime.publishOutbox("review-requests", {
      type: "pull-request.ready",
      idempotencyKey: "example/repo#42",
      content: { title: "Review requested" },
    });
    assert.equal(request?.url, "http://outbox.test/outboxes/review-requests/items");
    assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer runtime-token");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.OPENCOMPUTER_OUTBOX_URL;
    else process.env.OPENCOMPUTER_OUTBOX_URL = originalUrl;
    if (originalToken === undefined) delete process.env.OPENCOMPUTER_OUTBOX_TOKEN;
    else process.env.OPENCOMPUTER_OUTBOX_TOKEN = originalToken;
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler rejects hard-coded sensitive connection headers", async () => {
  const parent = await mkdtemp(
    resolve(tmpdir(), "opencomputer-egress-secret-"),
  );
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { defineConnection } from "@opencomputer/agent";

defineConnection({
  id: "unsafe-api",
  origin: "https://api.example.com",
  headers: { Authorization: "Bearer hard-coded" },
});

export default function Agent() {
  return "Hello";
}
`,
    );

    await assert.rejects(
      prepareAgent(initialized.agentRoot),
      /Authorization must use useSecret\(\)/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler packages code-defined tools for native OpenCode 2 registration", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-v2-tools-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await mkdir(resolve(initialized.agentRoot, "tools"), { recursive: true });
    await writeFile(
      resolve(initialized.agentRoot, "tools", "hacker-news.ts"),
      `import { defineTool } from "@opencomputer/agent";

export const hackerNews = defineTool({
  name: "hacker_news",
  description: "Fetch current Hacker News stories",
  input: {
    type: "object",
    properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
    additionalProperties: false,
  },
  async run({ input }) {
    return { limit: typeof input.limit === "number" ? input.limit : 5 };
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
      await readFile(
        resolve(runtime, ".opencomputer", "reactive.json"),
        "utf8",
      ),
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

test("the compiler packages agent source modules outside the tools directory", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-source-modules-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await writeFile(
      resolve(initialized.agentRoot, "config.ts"),
      `import { defineConnection } from "@opencomputer/agent";

export const github = defineConnection({
  id: "fixture-github",
  origin: "https://api.github.com",
  methods: ["GET"],
  pathPrefix: "/repos/opencomputer/example/",
});
export const repository = "opencomputer/example";
`,
    );
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { repository } from "./config.js";

export default function Agent() {
  return \`Review missing tests in \${repository}.\`;
}
`,
    );

    const built = await buildAgentArtifact(initialized.agentRoot);
    const artifact = JSON.parse(built.body.toString("utf8")) as {
      files: Array<{ path: string }>;
    };
    assert.ok(artifact.files.some((file) => file.path === "config.js"));
    assert.ok(built.connections.includes("fixture-github"));
    assert.match(
      await readFile(
        resolve(initialized.agentRoot, ".opencomputer", "runtime", "config.js"),
        "utf8",
      ),
      /opencomputer\/example/,
    );
    const packaged = await import(
      `${pathToFileURL(resolve(initialized.agentRoot, ".opencomputer", "runtime", "agent.js")).href}?test=${crypto.randomUUID()}`
    ) as { default(): string };
    assert.equal(
      packaged.default(),
      "Review missing tests in opencomputer/example.",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
