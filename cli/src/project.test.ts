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
  agentApiRuntimeSource,
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
    assert.equal(packageJSON.dependencies["@opencomputer/agent"], "^0.6.0");
    assert.equal(packageJSON.dependencies["@opencomputer/react"], undefined);
    assert.equal(packageJSON.devDependencies["@opencomputer/cli"], "^0.7.0");
    assert.equal(packageJSON.devDependencies["@types/node"], undefined);
    assert.match(
      await readFile(resolve(root, "README.md"), "utf8"),
      /Deploy agent changes to Development \(Cloud\)[\s\S]*npm run deploy -- --watch[\s\S]*opencomputer\/\.env\.example[\s\S]*--value-stdin/,
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
      gatedTools: [],
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
          idle: { suspendAfterSeconds: 300 },
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
    assert.equal(packageJSON.dependencies["@opencomputer/react"], "^0.2.0");
    assert.equal(packageJSON.dependencies.react, "^19.2.0");
    assert.equal(packageJSON.devDependencies.vite, "^8.0.0");
    assert.equal(packageJSON.devDependencies["@opencomputer/cli"], "^0.7.0");
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
      githubConnections: unknown[];
      mcpServers: string[];
      mcpServerDefinitions: Array<{
        id: string;
        url: string;
        connection?: string;
      }>;
      memory: unknown[];
      models: Array<{ provider: string; model: string }>;
    };
    assert.deepEqual(manifest, {
      version: 2,
      entry: "../agent.js",
      tools: ["search-docs"],
      gatedTools: [],
      toolModules: [],
      subagents: ["researcher"],
      connections: [],
      httpConnections: [],
      githubConnections: [],
      mcpServers: ["docs"],
      mcpServerDefinitions: [
        { id: "docs", url: "https://mcp.example.com/" },
      ],
      memory: [],
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

test("the compiler enumerates literal model selections in a conditional", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-model-conditional-"));
  try {
    const initialized = await initializeAgentProject(resolve(parent, "app"));
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { useInput, useModel } from "@opencomputer/agent";
export default function Agent() {
  const input = useInput();
  useModel(input.text?.includes("hard")
    ? "anthropic/claude-sonnet-5"
    : "anthropic/claude-haiku-4.5");
  return "Help with the request.";
}
`,
    );

    const runtime = await prepareAgent(initialized.agentRoot);
    const manifest = JSON.parse(
      await readFile(resolve(runtime, ".opencomputer", "reactive.json"), "utf8"),
    ) as { models: Array<{ provider: string; model: string }> };
    assert.deepEqual(manifest.models, [
      { provider: "openrouter", model: "anthropic/claude-haiku-4.5" },
      { provider: "openrouter", model: "anthropic/claude-sonnet-5" },
    ]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler rejects a model selection it cannot register", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-model-dynamic-"));
  try {
    const initialized = await initializeAgentProject(resolve(parent, "app"));
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { useModel } from "@opencomputer/agent";
const model = "anthropic/claude-sonnet-5";
export default function Agent() {
  useModel(model);
  return "Help with the request.";
}
`,
    );
    await assert.rejects(
      prepareAgent(initialized.agentRoot),
      /useModel\(\) must use a literal model selection/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the managed-connection clients survive the generated runtime", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-service-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await mkdir(resolve(initialized.agentRoot, "tools"), { recursive: true });
    await writeFile(
      resolve(initialized.agentRoot, "tools", "mail.ts"),
      `import { callService, defineTool } from "@opencomputer/agent";

export const unread = defineTool({
  name: "unread",
  description: "Count unread mail",
  async run() {
    const response = await callService({
      service: "gmail",
      label: "work",
      path: "/gmail/v1/users/me/messages",
    });
    return { status: response.status };
  },
});
`,
    );
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { useTool } from "@opencomputer/agent";
import { unread } from "./tools/mail.js";

export default function Agent() {
  useTool(unread);
  return "Read mail when asked.";
}
`,
    );

    await buildAgentArtifact(initialized.agentRoot);

    // Importing the EMITTED shim is the point. The shim is produced by
    // interpolating a template literal, where a regex like /\/$/ collapses into
    // a line comment and silently swallows the rest of the call — which is
    // exactly how this shipped broken the first time. A syntax error here is
    // invisible to tsc and only shows up at build or import.
    const runtime = await import(
      `${pathToFileURL(resolve(initialized.agentRoot, ".opencomputer", "runtime", "opencomputer-agent.js")).href}?test=${crypto.randomUUID()}`
    );
    assert.equal(typeof runtime.callService, "function");

    // Without the platform's env there is no connection to call, and the
    // failure must say so rather than fetching something arbitrary.
    await assert.rejects(
      runtime.callService({ service: "gmail", path: "/gmail/v1/users/me/profile" }),
      /managed connections are unavailable/,
    );

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const realFetch = globalThis.fetch;
    globalThis.process.env.OPENCOMPUTER_CONNECTIONS_URL = "https://edge.test/conn/";
    globalThis.process.env.OPENCOMPUTER_CONNECTION_TOKEN = "rt-token";
    // What a managed connection actually answers: the service's status and
    // body inside an envelope, wrapped in a 200. A caller reading `ok` off the
    // outer response sees success on a request that failed, and a caller
    // reading .json() gets the envelope instead of the payload.
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          status: 403,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: { message: "Insufficient Permission" } }),
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;
    let unwrapped: Response | undefined;
    try {
      unwrapped = await runtime.callService({
        service: "google",
        label: "work",
        method: "post",
        path: "/gmail/v1/users/me/messages/send",
        body: "{}",
      });
    } finally {
      globalThis.fetch = realFetch;
      delete globalThis.process.env.OPENCOMPUTER_CONNECTIONS_URL;
      delete globalThis.process.env.OPENCOMPUTER_CONNECTION_TOKEN;
    }

    assert.equal(calls.length, 1);
    // A trailing slash on the base must not produce a doubled one — the fix for
    // the comment bug replaced a regex trim, so the behaviour needs pinning.
    assert.equal(calls[0]!.url, "https://edge.test/conn/google/fetch");
    const sent = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    // `google` is an alias the platform resolves to gmail; the SDK passes the
    // caller's word through and only decides the PROVIDER segment itself.
    assert.equal(sent.service, "google");
    assert.equal(sent.label, "work");
    assert.equal(sent.method, "POST");
    assert.equal(sent.path, "/gmail/v1/users/me/messages/send");

    // The envelope must be opened: the service said 403, so the caller must.
    assert.equal(unwrapped!.status, 403);
    assert.equal(unwrapped!.ok, false);
    assert.deepEqual(await unwrapped!.json(), {
      error: { message: "Insufficient Permission" },
    });

    // listServices routes to the reserved `opencomputer` provider segment and
    // must send NO method and NO path — that body shape is the only thing
    // distinguishing a platform action from managed egress on the same route.
    assert.equal(typeof runtime.listServices, "function");
    calls.length = 0;
    globalThis.process.env.OPENCOMPUTER_CONNECTIONS_URL = "https://edge.test/conn";
    globalThis.process.env.OPENCOMPUTER_CONNECTION_TOKEN = "rt-token";
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          connections: [
            { id: "1", provider: "google", label: "alice", displayName: "a@x.com", status: "connected" },
            { id: "2", provider: "google", label: "bob", status: "pending" },
            { id: "3", provider: "github", label: "default", status: "connected" },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;
    let listed;
    try {
      listed = await runtime.listServices({ provider: "google" });
    } finally {
      globalThis.fetch = realFetch;
      delete globalThis.process.env.OPENCOMPUTER_CONNECTIONS_URL;
      delete globalThis.process.env.OPENCOMPUTER_CONNECTION_TOKEN;
    }
    assert.equal(calls[0]!.url, "https://edge.test/conn/opencomputer/fetch");
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { action: "list" });
    // Pending accounts are unusable and the github row is a different grant;
    // a sweep that tried either would fail on a mailbox that does not exist.
    assert.deepEqual(
      listed.map((connection: { label: string }) => connection.label),
      ["alice"],
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a tool is gated by having preview and apply, not by the words appearing in it", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-gated-shape-"));
  try {
    const initialized = await initializeAgentProject(resolve(parent, "app"));
    await mkdir(resolve(initialized.agentRoot, "tools"), { recursive: true });
    // An ordinary tool whose SCHEMA happens to describe fields called preview
    // and apply. Gating used to be visible in the function's name; now it is
    // the shape of the object, and a textual match would read this as gated
    // and make the runtime refuse to render it.
    await writeFile(
      resolve(initialized.agentRoot, "tools", "drafts.ts"),
      `import { defineTool } from "@opencomputer/agent";

export const draft = defineTool({
  name: "draft",
  description: "Render a draft",
  input: {
    type: "object",
    properties: {
      preview: { type: "boolean", description: "Return a preview only" },
      apply: { type: "boolean", description: "Apply the template" },
    },
  },
  run({ input }) {
    return { preview: Boolean(input.preview) };
  },
});
`,
    );
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { useTool } from "@opencomputer/agent";
import { draft } from "./tools/drafts.js";

export default function Agent() {
  useTool(draft);
  return "Draft when asked.";
}
`,
    );

    const runtime = await prepareAgent(initialized.agentRoot);
    const manifest = JSON.parse(
      await readFile(resolve(runtime, ".opencomputer", "reactive.json"), "utf8"),
    ) as { tools: string[]; gatedTools: string[] };
    assert.deepEqual(manifest.tools, ["draft"]);
    assert.deepEqual(manifest.gatedTools, []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a tool cannot be half gated", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-half-gate-"));
  try {
    const initialized = await initializeAgentProject(resolve(parent, "app"));
    await mkdir(resolve(initialized.agentRoot, "tools"), { recursive: true });
    await writeFile(
      resolve(initialized.agentRoot, "tools", "billing.ts"),
      `import { defineTool } from "@opencomputer/agent";

// apply() with no preview(): a person would be asked to approve something
// they were never shown.
export const cancel = defineTool({
  name: "cancel",
  description: "Cancel a subscription",
  async apply() {
    return { cancelled: true };
  },
});
`,
    );
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { useTool } from "@opencomputer/agent";
import { cancel } from "./tools/billing.js";

export default function Agent() {
  useTool(cancel);
  return "Cancel when asked.";
}
`,
    );

    // The compiler still records it as gated — either half means it intends to
    // wait — so the module load is where the incomplete pair is caught.
    const runtime = await prepareAgent(initialized.agentRoot);
    const manifest = JSON.parse(
      await readFile(resolve(runtime, ".opencomputer", "reactive.json"), "utf8"),
    ) as { gatedTools: string[] };
    assert.deepEqual(manifest.gatedTools, ["cancel"]);
    await assert.rejects(
      import(
        `${pathToFileURL(resolve(runtime, "tools", "billing.js")).href}?test=${crypto.randomUUID()}`
      ),
      /A tool with apply\(\) also requires preview\(\)/,
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
      `import { useConnection, useTool } from "@opencomputer/agent";
import { repository } from "./tools/github.js";

export default function Agent() {
  useConnection({ id: "github-api" });
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

test("the compiler records managed GitHub permissions as a provider connection", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-github-app-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await mkdir(resolve(initialized.agentRoot, "connections"), {
      recursive: true,
    });
    await writeFile(
      resolve(initialized.agentRoot, "connections", "github.ts"),
      `import { defineConnection, githubApp } from "@opencomputer/agent";

export const github = defineConnection({
  id: "github",
  provider: githubApp({
    permissions: {
      pull_requests: "write",
      contents: "write",
      metadata: "read",
    },
  }),
});
`,
    );
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { useConnection } from "@opencomputer/agent";
import { github } from "./connections/github.js";

export default function Agent() {
  useConnection(github);
  return "Work with GitHub directly.";
}
`,
    );

    const built = await buildAgentArtifact(initialized.agentRoot);
    assert.deepEqual(built.connections, ["github"]);
    assert.deepEqual(built.httpConnections, []);
    assert.deepEqual(built.githubConnections, [
      {
        id: "github",
        provider: {
          kind: "github-app",
          permissions: {
            contents: "write",
            metadata: "read",
            pull_requests: "write",
          },
        },
      },
    ]);
    const manifest = JSON.parse(
      await readFile(
        resolve(initialized.agentRoot, ".opencomputer", "runtime", ".opencomputer", "reactive.json"),
        "utf8",
      ),
    ) as { githubConnections: unknown[] };
    assert.deepEqual(manifest.githubConnections, built.githubConnections);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler rejects dynamic or unsupported GitHub permissions", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-github-invalid-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await mkdir(resolve(initialized.agentRoot, "connections"), {
      recursive: true,
    });
    const connection = resolve(
      initialized.agentRoot,
      "connections",
      "github.ts",
    );
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import "./connections/github.js";
export default function Agent() { return "Use GitHub."; }
`,
    );
    await writeFile(
      connection,
      `import { defineConnection, githubApp } from "@opencomputer/agent";
const permissions = { contents: "write" } as const;
export default defineConnection({
  id: "github",
  provider: githubApp({ permissions }),
});
`,
    );
    await assert.rejects(
      buildAgentArtifact(initialized.agentRoot),
      /githubApp\(\) options must be static/,
    );

    await writeFile(
      connection,
      `import { defineConnection, githubApp } from "@opencomputer/agent";
export default defineConnection({
  id: "github",
  provider: githubApp({ permissions: { administration: "write" } }),
});
`,
    );
    await assert.rejects(
      buildAgentArtifact(initialized.agentRoot),
      /does not support the administration permission/,
    );
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
    const tools = await import(
      `${pathToFileURL(resolve(runtime, "tools", "hacker-news.js")).href}?test=${crypto.randomUUID()}`
    ) as { hackerNews: { id: string } };
    assert.equal(tools.hackerNews.id, "hacker_news");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a gated tool proposes instead of writing, and carries its apply", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-gated-tools-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await mkdir(resolve(initialized.agentRoot, "tools"), { recursive: true });
    await writeFile(
      resolve(initialized.agentRoot, "tools", "billing.ts"),
      `import { defineTool } from "@opencomputer/agent";

export const attach = defineTool({
  name: "attach",
  description: "Move a customer onto a plan",
  input: { type: "object", properties: { plan: { type: "string" } } },
  preview({ input }) {
    return { title: \`Move to \${String(input.plan)}\`, facts: [{ label: "Plan", value: String(input.plan) }] };
  },
  async apply({ input }) {
    return { applied: String(input.plan) };
  },
});
`,
    );
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { useTool } from "@opencomputer/agent";
import { attach } from "./tools/billing.js";

export default function Agent() {
  useTool(attach);
  return "Change the plan when asked.";
}
`,
    );

    const runtime = await prepareAgent(initialized.agentRoot);
    const manifest = JSON.parse(
      await readFile(
        resolve(runtime, ".opencomputer", "reactive.json"),
        "utf8",
      ),
    ) as { tools: string[]; gatedTools: string[]; toolModules: string[] };
    // The model sees it as an ordinary tool; the platform is told it is gated.
    assert.ok(manifest.tools.includes("attach"));
    assert.deepEqual(manifest.gatedTools, ["attach"]);
    assert.ok(manifest.toolModules.includes("../tools/billing.js"));

    const built = (await import(
      `${pathToFileURL(resolve(runtime, "tools", "billing.js")).href}?test=${crypto.randomUUID()}`
    )) as {
      attach: {
        kind: string;
        run(context: Record<string, unknown>): Promise<string>;
        apply(context: Record<string, unknown>): Promise<unknown>;
      };
    };
    assert.equal(built.attach.kind, "gated-tool");

    const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
    const realFetch = globalThis.fetch;
    process.env.OPENCOMPUTER_APPROVAL_URL = "https://edge.test/v1/sessions/s1/approvals";
    process.env.OPENCOMPUTER_APPROVAL_TOKEN = "runtime-token";
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      posted.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> });
      return new Response(
        JSON.stringify({ id: "apr_1", status: "pending", duplicate: false, message: "Recorded for approval." }),
        { headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;
    try {
      // Calling it records a proposal and tells the model to stop. No write.
      const answer = await built.attach.run({
        input: { plan: "pro" },
        messageId: "msg-1",
        sessionId: "s1",
        agentId: "a1",
      });
      assert.equal(answer, "Recorded for approval.");
      assert.equal(posted.length, 1);
      assert.deepEqual(posted[0]!.body.input, { plan: "pro" });
      assert.deepEqual(posted[0]!.body.preview, {
        title: "Move to pro",
        facts: [{ label: "Plan", value: "pro" }],
      });
      // The tool call is the proposal's identity, so a retry is one approval.
      assert.equal(posted[0]!.body.idempotencyKey, "msg-1");

      // A refusal reaches the model, which repeats it to a person. The
      // platform writes the sentence; a bare status code invites invention.
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "approval_needs_a_conversation",
              message: "This tool can only be used in a conversation where somebody can approve it.",
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        )) as unknown as typeof globalThis.fetch;
      await assert.rejects(
        built.attach.run({
          input: { plan: "pro" },
          messageId: "msg-2",
          sessionId: "s1",
          agentId: "a1",
        }),
        /somebody can approve it/,
      );

      // The write itself lives in apply, and never ran.
      assert.deepEqual(await built.attach.apply({ input: { plan: "pro" } }), {
        applied: "pro",
      });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.OPENCOMPUTER_APPROVAL_URL;
      delete process.env.OPENCOMPUTER_APPROVAL_TOKEN;
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler records the result tool and its pinned output schema", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-result-tool-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await mkdir(resolve(initialized.agentRoot, "tools"), { recursive: true });
    await writeFile(
      resolve(initialized.agentRoot, "tools", "report.ts"),
      `import { defineTool } from "@opencomputer/agent";

export const report = defineTool({
  name: "report",
  description: "Report the branch and pull request",
  input: {
    type: "object",
    properties: { branch: { type: "string" } },
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: {
      branch: { type: "string" },
      pr: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] },
    },
    required: ["branch"],
    additionalProperties: false,
  },
  result: true,
  async run({ input }) {
    return { branch: String(input.branch) };
  },
});

export const lookup = defineTool({
  name: "lookup",
  description: "Look something up",
  result: false,
  async run() {
    return { found: true };
  },
});
`,
    );
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { useTool } from "@opencomputer/agent";
import { report } from "./tools/report.js";

export default function Agent() {
  useTool(report);
  return "Report when the branch is known.";
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
      tools: string[];
      resultTool?: { id: string; output: Record<string, unknown> };
    };
    assert.deepEqual(manifest.tools, ["lookup", "report"]);
    assert.deepEqual(manifest.resultTool, {
      id: "report",
      output: {
        type: "object",
        properties: {
          branch: { type: "string" },
          pr: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] },
        },
        required: ["branch"],
        additionalProperties: false,
      },
    });
    const tools = await import(
      `${pathToFileURL(resolve(runtime, "tools", "report.js")).href}?test=${crypto.randomUUID()}`
    ) as { report: { id: string; result?: boolean }; lookup: { result?: boolean } };
    assert.equal(tools.report.result, true);
    assert.equal("result" in tools.lookup, false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler rejects a result tool without an output schema", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-result-tool-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await mkdir(resolve(initialized.agentRoot, "tools"), { recursive: true });
    await writeFile(
      resolve(initialized.agentRoot, "tools", "report.ts"),
      `import { defineTool } from "@opencomputer/agent";

export const report = defineTool({
  name: "report",
  description: "Report the branch",
  result: true,
  async run() {
    return { branch: "task/1" };
  },
});
`,
    );
    await assert.rejects(
      prepareAgent(initialized.agentRoot),
      /tools\/report\.ts defineTool\("report"\) is the result tool and must declare output/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler rejects more than one result tool per agent", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-result-tool-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await mkdir(resolve(initialized.agentRoot, "tools"), { recursive: true });
    for (const name of ["first", "second"]) {
      await writeFile(
        resolve(initialized.agentRoot, "tools", `${name}.ts`),
        `import { defineTool } from "@opencomputer/agent";

export const ${name} = defineTool({
  name: "${name}",
  description: "Report ${name}",
  output: { type: "object" },
  result: true,
  async run() {
    return {};
  },
});
`,
      );
    }
    await assert.rejects(
      prepareAgent(initialized.agentRoot),
      /An agent may declare one result tool; found "first" in tools\/first\.ts and "second" in tools\/second\.ts/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler rejects a result tool that waits for approval", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-result-tool-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await mkdir(resolve(initialized.agentRoot, "tools"), { recursive: true });
    await writeFile(
      resolve(initialized.agentRoot, "tools", "report.ts"),
      `import { defineTool } from "@opencomputer/agent";

export const report = defineTool({
  name: "report",
  description: "Report the branch",
  output: { type: "object" },
  result: true,
  preview() {
    return { title: "Report" };
  },
  async apply() {
    return {};
  },
});
`,
    );
    await assert.rejects(
      prepareAgent(initialized.agentRoot),
      /tools\/report\.ts defineTool\("report"\) waits for approval and cannot be the result tool/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// The review's finding 9: `result: true` arriving through a spread compiled as
// an ordinary tool with no `resultTool` in the manifest, while the built
// module still carried `result: true`. Every form the scan cannot read now
// fails the build and names the form.
test("the compiler refuses a defineTool() form it cannot read instead of compiling an ordinary tool", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-result-tool-"));
  const root = resolve(parent, "app");
  const tool = (declaration: string) => `import { defineTool } from "@opencomputer/agent";
const marks = { result: true } as const;
const flag = true;
export const report = defineTool({
  name: "report",
  description: "Report the branch",
  output: { type: "object", properties: { branch: { type: "string" } }, required: ["branch"], additionalProperties: false },
  ${declaration}
  async run() {
    return { branch: "task/1" };
  },
});
`;
  try {
    const initialized = await initializeAgentProject(root);
    await mkdir(resolve(initialized.agentRoot, "tools"), { recursive: true });
    const cases: Array<[string, RegExp]> = [
      ["...marks,", /tools\/report\.ts defineTool\("report"\) cannot spread \.\.\.marks/],
      ["result: flag,", /tools\/report\.ts defineTool\("report"\) result must be the literal true or false, not flag/],
      ["result: marks.result,", /result must be the literal true or false, not marks\.result/],
      ["result,", /result must be the literal true or false, not the shorthand property result/],
      ['["result"]: true,', /tools\/report\.ts defineTool\("report"\) cannot use the computed property name \["result"\]/],
    ];
    for (const [declaration, expected] of cases) {
      await writeFile(resolve(initialized.agentRoot, "tools", "report.ts"), tool(declaration));
      await assert.rejects(prepareAgent(initialized.agentRoot), expected, declaration);
    }
    // The literal keyword, wrapped in the idiomatic `as const`, still reads.
    await writeFile(resolve(initialized.agentRoot, "tools", "report.ts"), tool("result: true as const,"));
    const runtime = await prepareAgent(initialized.agentRoot);
    const manifest = JSON.parse(
      await readFile(resolve(runtime, ".opencomputer", "reactive.json"), "utf8"),
    ) as { resultTool?: { id: string } };
    assert.equal(manifest.resultTool?.id, "report");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// The second check: the runtime shim carries the manifest's result tool, so a
// module whose evaluated metadata disagrees with what the build recorded
// throws at import and the deployment fails to load rather than running the
// tool as an ordinary one.
test("the runtime shim refuses a tool module whose result metadata disagrees with the manifest", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-runtime-shim-"));
  try {
    const load = async (resultTool: string | null) => {
      const path = resolve(parent, `shim-${resultTool ?? "none"}.js`);
      await writeFile(path, agentApiRuntimeSource({ resultTool }));
      return (await import(`${pathToFileURL(path).href}?test=${crypto.randomUUID()}`)) as {
        defineTool: (input: Record<string, unknown>) => { result?: boolean };
      };
    };
    const output = { type: "object" };
    const run = async () => ({});
    const withReport = await load("report");
    assert.equal(withReport.defineTool({ name: "report", description: "d", output, result: true, run }).result, true);
    assert.equal("result" in withReport.defineTool({ name: "lookup", description: "d", run }), false);
    assert.throws(
      () => withReport.defineTool({ name: "lookup", description: "d", output, result: true, run }),
      /Tool lookup declares result: true, but the deployment records report as its result tool/,
    );
    assert.throws(
      () => withReport.defineTool({ name: "report", description: "d", output, run }),
      /Tool report is the deployment's result tool, but the module does not declare result: true/,
    );
    const withoutResult = await load(null);
    assert.throws(
      () => withoutResult.defineTool({ name: "report", description: "d", output, result: true, run }),
      /Tool report declares result: true, but the deployment records no result tool/,
    );
    assert.equal("result" in withoutResult.defineTool({ name: "report", description: "d", run }), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// One authored result schema: the review found the inline-only rule refused
// a local const used for both input and output, which forced a second
// hand-maintained copy. A const object literal in the same module, or a
// named import of one from a module inside the agent directory, is read
// without evaluation and pinned exactly as written.
test("the compiler reads the result tool's output schema from a const in the module or an imported const", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-result-schema-"));
  const root = resolve(parent, "app");
  const schema = {
    type: "object",
    properties: { branch: { type: "string" }, checks: { type: "array", items: { type: "string" } } },
    required: ["branch"],
    additionalProperties: false,
  };
  const manifestOf = async (agentRoot: string) =>
    JSON.parse(
      await readFile(resolve(agentRoot, ".opencomputer", "runtime", ".opencomputer", "reactive.json"), "utf8"),
    ) as { resultTool?: { id: string; output: Record<string, unknown> } };
  try {
    const initialized = await initializeAgentProject(root);
    await mkdir(resolve(initialized.agentRoot, "tools"), { recursive: true });
    // Same module, `as const`, one schema for input and output.
    await writeFile(
      resolve(initialized.agentRoot, "tools", "report.ts"),
      `import { defineTool } from "@opencomputer/agent";

const reportSchema = ${JSON.stringify(schema, null, 2)} as const;

export const report = defineTool({
  name: "report",
  description: "Report the branch",
  input: reportSchema,
  output: reportSchema,
  result: true,
  async run({ input }) {
    return { branch: String(input.branch) };
  },
});
`,
    );
    await prepareAgent(initialized.agentRoot);
    assert.deepEqual((await manifestOf(initialized.agentRoot)).resultTool, { id: "report", output: schema });

    // Imported from a module of the agent's own, under a different local name.
    await writeFile(
      resolve(initialized.agentRoot, "schemas.ts"),
      `export const reportSchema = ${JSON.stringify(schema)} satisfies Record<string, unknown>;\n`,
    );
    await writeFile(
      resolve(initialized.agentRoot, "tools", "report.ts"),
      `import { defineTool } from "@opencomputer/agent";
import { reportSchema as output } from "../schemas.js";

export const report = defineTool({
  name: "report",
  description: "Report the branch",
  input: output,
  output,
  result: true,
  async run({ input }) {
    return { branch: String(input.branch) };
  },
});
`,
    );
    await prepareAgent(initialized.agentRoot);
    assert.deepEqual((await manifestOf(initialized.agentRoot)).resultTool, { id: "report", output: schema });

    // A const exported under another name, read through the export list.
    await writeFile(
      resolve(initialized.agentRoot, "schemas.ts"),
      `const base = ${JSON.stringify(schema)} as const;\nexport { base as reportSchema };\n`,
    );
    await prepareAgent(initialized.agentRoot);
    assert.deepEqual((await manifestOf(initialized.agentRoot)).resultTool, { id: "report", output: schema });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler names the unsupported schema form instead of guessing", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-result-schema-"));
  const root = resolve(parent, "app");
  const tool = (imports: string, output: string) => `import { defineTool } from "@opencomputer/agent";
${imports}
export const report = defineTool({
  name: "report",
  description: "Report the branch",
  output: ${output},
  result: true,
  async run() {
    return { branch: "task/1" };
  },
});
`;
  try {
    const initialized = await initializeAgentProject(root);
    await mkdir(resolve(initialized.agentRoot, "tools"), { recursive: true });
    await writeFile(
      resolve(initialized.agentRoot, "schemas.ts"),
      `export const built = build();
export function build() { return { type: "object" }; }
const local = build();
export { local as renamed };
export { defineTool as reexported } from "@opencomputer/agent";
`,
    );
    const cases: Array<[string, string, RegExp]> = [
      ["", "build()", /defineTool\("report"\) output must be an inline object literal, a const object literal declared in the same module, or a named import of such a const from a module inside the agent directory, not build\(\)/],
      ["let mutable = { type: \"object\" };", "mutable", /output references mutable, which is declared with let or var; declare it as a const object literal/],
      ["const computed = build();\nfunction build() { return {}; }", "computed", /output references computed, whose value is not a static object literal: build\(\)/],
      ["import { built } from \"../schemas.js\";", "built", /output references built, exported by schemas\.ts, whose value is not a static object literal: build\(\)/],
      ["import { renamed } from \"../schemas.js\";", "renamed", /output references renamed, exported by schemas\.ts \(declared there as local\), whose value is not a static object literal: build\(\)/],
      ["import { reexported } from \"../schemas.js\";", "reexported", /output references reexported, which schemas\.ts re-exports from another module; import it from the module that declares it/],
      ["import { useTool } from \"@opencomputer/agent\";", "useTool", /output references useTool, imported from @opencomputer\/agent; a schema must be a const declared in a module inside the agent directory/],
      ["import * as schemas from \"../schemas.js\";", "schemas.local", /output must be an inline object literal, .* not schemas\.local/],
      ["", "missing", /output references missing, which is neither a const declared in this module nor a named import from a module inside the agent directory/],
    ];
    for (const [imports, output, expected] of cases) {
      await writeFile(resolve(initialized.agentRoot, "tools", "report.ts"), tool(imports, output));
      await assert.rejects(prepareAgent(initialized.agentRoot), expected, output);
    }
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
import settings from "./settings.json";

export const github = defineConnection({
  id: "fixture-github",
  origin: "https://api.github.com",
  methods: ["GET"],
  pathPrefix: "/repos/opencomputer/example/",
});
export const repository = settings.repository;
`,
    );
    await writeFile(
      resolve(initialized.agentRoot, "settings.json"),
      `${JSON.stringify({ repository: "opencomputer/example" })}\n`,
    );
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { repository } from "./config";

export default function Agent() {
  return \`Review missing tests in \${repository}.\`;
}
`,
    );

    const built = await buildAgentArtifact(initialized.agentRoot);
    const artifact = JSON.parse(built.body.toString("utf8")) as {
      files: Array<{ path: string }>;
    };
    assert.ok(!artifact.files.some((file) => file.path === "config.js"));
    assert.ok(!artifact.files.some((file) => file.path === "settings.json"));
    assert.ok(artifact.files.some((file) => file.path === "agent.js"));
    assert.ok(built.connections.includes("fixture-github"));
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

test("the compiler rejects imports outside the agent directory", async () => {
  const parent = await mkdtemp(
    resolve(tmpdir(), "opencomputer-source-boundary-"),
  );
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await writeFile(
      resolve(initialized.agentRoot, "..", "outside.ts"),
      "export const value = 1;\n",
    );
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { value } from "../outside";

export default function Agent() {
  return String(value);
}
`,
    );
    await assert.rejects(
      buildAgentArtifact(initialized.agentRoot),
      /must stay inside the agent directory/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler accepts Twilio and email channels alongside Slack", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-providers-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await mkdir(resolve(root, "opencomputer", "channels"), { recursive: true });
    await mkdir(resolve(initialized.agentRoot, "channels"), { recursive: true });

    await writeFile(
      resolve(root, "opencomputer", "channels", "shop-sms.ts"),
      `import { defineChannel } from "@opencomputer/agent";

export default defineChannel({
  id: "shop-sms",
  type: "twilio",
  idle: { suspendAfterSeconds: 60 },
});
`,
    );
    await writeFile(
      resolve(root, "opencomputer", "channels", "support-email.ts"),
      `import { defineChannel } from "@opencomputer/agent";

export default defineChannel({
  id: "support-email",
  type: "email",
});
`,
    );
    await writeFile(
      resolve(initialized.agentRoot, "channels", "shop-sms.ts"),
      `import { registerChannel } from "@opencomputer/agent";
import shopSms from "../../../channels/shop-sms.js";
export default registerChannel(shopSms, { on: ["message"] });
`,
    );

    const built = await readProjectResources(root);
    const sms = built.manifest.channels.find((c) => c.id === "shop-sms");
    const email = built.manifest.channels.find((c) => c.id === "support-email");

    // No number in the manifest: it is per-environment operational config,
    // bound to a connection the same way Slack conversation IDs are.
    assert.deepEqual(sms, {
      id: "shop-sms",
      type: "twilio",
      routing: { whenAmbiguous: "ask" },
      idle: { suspendAfterSeconds: 60 },
      events: ["message.inbound"],
      destinations: { reply: { type: "reply" } },
    });
    assert.equal(email?.type, "email");
    assert.deepEqual(email?.idle, { suspendAfterSeconds: 300 });
    assert.deepEqual(built.manifest.channelRegistrations, [
      { agentId: "hello-world", channelId: "shop-sms", triggers: ["message"] },
    ]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler rejects a trigger the provider cannot deliver", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-trigger-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await mkdir(resolve(root, "opencomputer", "channels"), { recursive: true });
    await mkdir(resolve(initialized.agentRoot, "channels"), { recursive: true });
    await writeFile(
      resolve(root, "opencomputer", "channels", "shop-sms.ts"),
      `import { defineChannel } from "@opencomputer/agent";
export default defineChannel({ id: "shop-sms", type: "twilio" });
`,
    );
    await writeFile(
      resolve(initialized.agentRoot, "channels", "shop-sms.ts"),
      `import { registerChannel } from "@opencomputer/agent";
import shopSms from "../../../channels/shop-sms.js";
export default registerChannel(shopSms, { on: ["mention"] });
`,
    );
    await assert.rejects(
      readProjectResources(root),
      /trigger mention is not available on a twilio channel/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler names providers by vendor, not by medium", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-vendor-"));
  const root = resolve(parent, "app");
  try {
    await initializeAgentProject(root);
    await mkdir(resolve(root, "opencomputer", "channels"), { recursive: true });
    // "sms" is a medium; the signature and payload this has to parse belong to
    // one vendor. A different SMS vendor is a different adapter.
    await writeFile(
      resolve(root, "opencomputer", "channels", "shop-sms.ts"),
      `import { defineChannel } from "@opencomputer/agent";
export default defineChannel({ id: "shop-sms", type: "sms" });
`,
    );
    await assert.rejects(
      readProjectResources(root),
      /unsupported channel type "sms". Supported: slack, twilio, email/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

const REQUIREMENTS_MEMORY = `import { defineMemory, documentMemory } from "@opencomputer/agent";

export const requirements = defineMemory({
  id: "requirements",
  description: "Verified requirements and decisions for a workshop, kept for later work.",
  provider: documentMemory({ maxBytes: 8_192 }),
});
`;

const KNOWLEDGE_MEMORY = `import {
  bearer, defineConnection, defineMemory, httpMemory, useSecret,
} from "@opencomputer/agent";

const connection = defineConnection({
  id: "memory-service",
  origin: "https://memory.example.com",
  methods: ["POST"],
  pathPrefix: "/oc-memory",
  headers: { Authorization: bearer(useSecret("MEMORY_TOKEN")) },
});

export const knowledge = defineMemory({
  id: "knowledge",
  description: "Verified facts needed in later sessions.",
  provider: httpMemory({
    connection,
    path: "/oc-memory",
    maxBytes: 8_192,
    tools: [{
      name: "remember",
      description: "Save a verified fact for future work.",
      access: "write",
      idempotent: false,
      input: {
        type: "object",
        properties: { fact: { type: "string", maxLength: 2_000 } },
        required: ["fact"],
        additionalProperties: false,
      },
    }],
  }),
});
`;

const KNOWLEDGE_DECLARATION = {
  id: "knowledge",
  description: "Verified facts needed in later sessions.",
  provider: {
    kind: "http",
    connection: "memory-service",
    path: "/oc-memory",
    maxBytes: 8192,
    tools: [
      {
        name: "remember",
        description: "Save a verified fact for future work.",
        access: "write",
        idempotent: false,
        input: {
          type: "object",
          properties: { fact: { type: "string", maxLength: 2000 } },
          required: ["fact"],
          additionalProperties: false,
        },
      },
    ],
  },
};

const REQUIREMENTS_DECLARATION = {
  id: "requirements",
  description:
    "Verified requirements and decisions for a workshop, kept for later work.",
  provider: { kind: "document", maxBytes: 8192 },
};

test("the compiler registers memory declarations in the artifact manifest", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-memory-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await writeFile(resolve(initialized.agentRoot, "memory.ts"), REQUIREMENTS_MEMORY);
    await writeFile(resolve(initialized.agentRoot, "knowledge.ts"), KNOWLEDGE_MEMORY);
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { useInput, useMemory, useModel } from "@opencomputer/agent";
import { requirements } from "./memory";
import { knowledge } from "./knowledge";

export default function Agent() {
  const input = useInput();
  const saved = useMemory(requirements);
  if (input.text?.includes("facts")) useMemory(knowledge);
  useModel("anthropic/claude-sonnet-4.6");
  return "Saved requirements (JSON string): " + JSON.stringify(saved.text) + " writable=" + String(saved.writable);
}
`,
    );

    const built = await buildAgentArtifact(initialized.agentRoot);
    assert.deepEqual(built.memory, [KNOWLEDGE_DECLARATION, REQUIREMENTS_DECLARATION]);
    assert.ok(built.connections.includes("memory-service"));
    const runtime = resolve(initialized.agentRoot, ".opencomputer", "runtime");
    const manifest = JSON.parse(
      await readFile(resolve(runtime, ".opencomputer", "reactive.json"), "utf8"),
    ) as { memory: unknown; tools: string[] };
    assert.deepEqual(manifest.memory, built.memory);
    assert.deepEqual(manifest.tools, []);

    // The compiled agent renders against the host's scope contract: the host
    // resolves one projection per session binding into scope.memory and
    // records which ids the render selected.
    const scope = {
      input: { source: "user", text: "hello" } as { source: string; text: string },
      memory: {
        requirements: {
          text: "Node.js 22, no paid services.",
          sources: [{ id: "workshop", title: "Workshop requirements", revision: "r1", updatedAt: "2026-09-10T12:00:00.000Z" }],
          writable: true,
        },
      } as Record<string, unknown>,
      selectedMemory: new Set<string>(),
    };
    (globalThis as Record<PropertyKey, unknown>)[Symbol.for("opencomputer.agent-hooks")] = {
      useInput: () => scope.input,
      useModel: () => undefined,
      useMemory(id: string) {
        const projection = scope.memory[id];
        if (projection) scope.selectedMemory.add(id);
        return projection;
      },
    };
    try {
      const module = (await import(
        `${pathToFileURL(resolve(runtime, "agent.js")).href}?test=${crypto.randomUUID()}`
      )) as { default: () => string };
      assert.equal(
        module.default(),
        'Saved requirements (JSON string): "Node.js 22, no paid services." writable=true',
      );
      assert.deepEqual([...scope.selectedMemory], ["requirements"]);
      scope.input = { source: "user", text: "facts please" };
      assert.throws(
        () => module.default(),
        /Memory "knowledge" is not bound to this session/,
      );
    } finally {
      delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("opencomputer.agent-hooks")];
    }

    // The runtime shim normalizes a definition to its manifest entry.
    const shim = (await import(
      `${pathToFileURL(resolve(runtime, "opencomputer-agent.js")).href}?test=${crypto.randomUUID()}`
    )) as {
      defineMemory: (input: unknown) => unknown;
      documentMemory: () => unknown;
    };
    assert.deepEqual(
      JSON.parse(JSON.stringify(shim.defineMemory({ id: "notes", description: " Notes. " }))),
      { kind: "memory", version: 1, id: "notes", description: "Notes.", provider: { kind: "document", maxBytes: 8192 } },
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler deduplicates identical memory declarations and rejects conflicting ones", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-memory-dup-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await writeFile(resolve(initialized.agentRoot, "memory.ts"), REQUIREMENTS_MEMORY);
    await writeFile(
      resolve(initialized.agentRoot, "memory-again.ts"),
      REQUIREMENTS_MEMORY.replace("export const requirements", "export const again"),
    );
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { useMemory } from "@opencomputer/agent";
import { requirements } from "./memory";
import { again } from "./memory-again";

export default function Agent() {
  return useMemory(requirements).text + useMemory(again).text;
}
`,
    );
    const built = await buildAgentArtifact(initialized.agentRoot);
    assert.deepEqual(built.memory, [REQUIREMENTS_DECLARATION]);

    await writeFile(
      resolve(initialized.agentRoot, "memory-again.ts"),
      REQUIREMENTS_MEMORY.replace("export const requirements", "export const again").replace(
        "maxBytes: 8_192",
        "maxBytes: 4_096",
      ),
    );
    await assert.rejects(
      buildAgentArtifact(initialized.agentRoot),
      /Memory "requirements" is declared with different configuration in memory-again\.ts and memory\.ts/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler validates memory declarations", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-memory-invalid-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    const build = async (memorySource: string, agentSource?: string) => {
      await writeFile(resolve(initialized.agentRoot, "memory.ts"), memorySource);
      await writeFile(
        resolve(initialized.agentRoot, "agent.ts"),
        agentSource ??
          `import { useMemory } from "@opencomputer/agent";
import { memory } from "./memory";

export default function Agent() {
  return useMemory(memory).text;
}
`,
      );
      return buildAgentArtifact(initialized.agentRoot);
    };
    const http = (tools: string, path = '"/oc-memory"') =>
      KNOWLEDGE_MEMORY.replace("export const knowledge", "export const memory")
        .replace('path: "/oc-memory"', `path: ${path}`)
        .replace(/tools: \[[\s\S]*\],\n  \}\)/, `tools: ${tools},\n  })`);
    const remember = (extra: string) =>
      `[{ name: "remember", description: "Save.", access: "write", input: { type: "object", properties: { fact: { type: "string" }${extra} } } }]`;

    await assert.rejects(
      build(http(remember(', memory: { type: "string" }'))),
      /tool remember input cannot declare the reserved memory argument/,
    );
    await assert.rejects(
      build(http(`[{ name: "remember", description: "Save.", access: "write", input: { type: "object", required: ["memory"] } }]`)),
      /tool remember input cannot declare the reserved memory argument/,
    );
    await assert.rejects(
      build(http(`[{ name: "Remember", description: "Save.", access: "write", input: { type: "object" } }]`)),
      /tool names must use 1 to 32 lowercase letters, numbers, and underscores/,
    );
    await assert.rejects(
      build(http(`[{ name: "remember", description: "Save.", access: "admin", input: { type: "object" } }]`)),
      /access must be "read" or "write"/,
    );
    await assert.rejects(
      build(http(`[{ name: "remember", description: "Save.", access: "read", input: { type: "object", properties: { a: { $ref: "#/x" } } } }]`)),
      /input cannot use \$ref/,
    );
    await assert.rejects(
      build(http(`[${Array.from({ length: 9 }, (_, i) => `{ name: "t${i}", description: "T.", access: "read", input: { type: "object" } }`).join(", ")}]`)),
      /at most 8 tools/,
    );
    await assert.rejects(
      build(http("[]", '"/elsewhere"')),
      /path \/elsewhere is outside connection memory-service pathPrefix \/oc-memory/,
    );
    await assert.rejects(
      build(http("[]", '"/oc-memory?x=1"')),
      /path must begin with a single \/ and contain no query or fragment/,
    );
    await assert.rejects(
      build(http("[]").replace('methods: ["POST"]', 'methods: ["GET"]')),
      /requires connection memory-service to allow POST/,
    );
    await assert.rejects(
      build(http("[]").replace("connection,", "connection: elsewhere,")),
      /references unknown connection elsewhere/,
    );
    await assert.rejects(
      build(REQUIREMENTS_MEMORY.replace("export const requirements", "export const memory").replace("8_192", "16_385")),
      /maxBytes must be a whole number between 1 and 16384/,
    );
    await assert.rejects(
      build(REQUIREMENTS_MEMORY.replace("export const requirements", "export const memory").replace('"requirements"', '"Requirements"')),
      /must use lowercase letters, numbers, and single hyphens/,
    );
    await assert.rejects(
      build(REQUIREMENTS_MEMORY.replace("export const requirements", "export const memory").replace("provider: documentMemory({ maxBytes: 8_192 })", "provider: custom")),
      /provider must be an inline documentMemory\(\) or httpMemory\(\) call/,
    );

    // A literal useMemory() must name a declared resource, and ordinary tools
    // cannot take a memory tool's fixed name.
    await assert.rejects(
      build(
        REQUIREMENTS_MEMORY.replace("export const requirements", "export const memory"),
        `import { useMemory } from "@opencomputer/agent";

export default function Agent() {
  return useMemory("requirements").text + useMemory("budget").text;
}
`,
      ),
      /useMemory\("budget"\) references a memory resource this agent does not declare/,
    );
    await assert.rejects(
      build(
        REQUIREMENTS_MEMORY.replace("export const requirements", "export const memory"),
        `import { useMemory, useTool } from "@opencomputer/agent";
import { memory } from "./memory";

export default function Agent() {
  useTool("memory_save");
  return useMemory(memory).text;
}
`,
      ),
      /Tool id "memory_save" collides with the fixed tool name of memory requirements/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the compiler rejects memory declarations it cannot register as written", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-memory-literal-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { useMemory } from "@opencomputer/agent";
import { memory } from "./memory";

export default function Agent() {
  return useMemory(memory).text;
}
`,
    );
    const build = async (memorySource: string, extra?: [string, string]) => {
      await writeFile(resolve(initialized.agentRoot, "memory.ts"), memorySource);
      if (extra) await writeFile(resolve(initialized.agentRoot, extra[0]), extra[1]);
      return buildAgentArtifact(initialized.agentRoot);
    };
    const declaration = (provider: string) =>
      `  id: "requirements",\n  description: "Requirements.",\n  provider: ${provider},\n`;

    // Review reproduction: an aliased callee executed a definition the
    // compiler never registered, so the artifact declared no memory.
    await assert.rejects(
      build(`import { defineMemory as declareMemory, documentMemory } from "@opencomputer/agent";

export const memory = declareMemory({
${declaration("documentMemory({ maxBytes: 4_096 })")}});
`),
      /memory\.ts imports defineMemory as declareMemory; the compiler registers memory only from a direct defineMemory\(\) call, so keep its name/,
    );
    await assert.rejects(
      build(
        `import { declareMemory } from "./lib";

export const memory = declareMemory({
${declaration("undefined")}});
`,
        ["lib.ts", 'export { defineMemory as declareMemory } from "@opencomputer/agent";\n'],
      ),
      /lib\.ts exports defineMemory as declareMemory; the compiler registers memory only from a direct defineMemory\(\) call/,
    );
    await rm(resolve(initialized.agentRoot, "lib.ts"));
    await assert.rejects(
      build(`import * as oc from "@opencomputer/agent";

export const memory = oc.defineMemory({
${declaration("oc.documentMemory({ maxBytes: 4_096 })")}});
`),
      /memory\.ts calls oc\.defineMemory\(\); the compiler registers memory only from a direct defineMemory\(\) call, so import defineMemory by name from @opencomputer\/agent/,
    );
    await assert.rejects(
      build(`import { defineMemory } from "@opencomputer/agent";

const declare = defineMemory;
export const memory = declare({
${declaration("undefined")}});
`),
      /memory\.ts uses defineMemory other than as a direct defineMemory\(\) call; the compiler registers memory only from that call, so do not alias, wrap, or shadow it/,
    );

    // Review reproduction: spreading options into the provider registered
    // the default limit while the definition kept 4096.
    await assert.rejects(
      build(`import { defineMemory, documentMemory } from "@opencomputer/agent";

const options = { maxBytes: 4_096 };
export const memory = defineMemory({
${declaration("documentMemory({ ...options })")}});
`),
      /memory\.ts Memory requirements documentMemory\(\) cannot spread options; write each option as a literal property/,
    );

    // Review reproduction: spreading the provider into the declaration
    // registered the default provider.
    await assert.rejects(
      build(`import { defineMemory, documentMemory } from "@opencomputer/agent";

const provider = { provider: documentMemory({ maxBytes: 4_096 }) };
export const memory = defineMemory({
  id: "requirements",
  description: "Requirements.",
  ...provider,
});
`),
      /memory\.ts defineMemory\(\) cannot spread provider; write each option as a literal property/,
    );

    // The same silent default through a shorthand, an accessor, a computed
    // name, or a non-literal argument.
    await assert.rejects(
      build(`import { defineMemory, documentMemory } from "@opencomputer/agent";

const provider = documentMemory({ maxBytes: 4_096 });
export const memory = defineMemory({ id: "requirements", description: "Requirements.", provider });
`),
      /memory\.ts defineMemory\(\) cannot use the shorthand property provider; write provider as a literal property/,
    );
    await assert.rejects(
      build(`import { defineMemory, documentMemory } from "@opencomputer/agent";

export const memory = defineMemory({
  id: "requirements",
  description: "Requirements.",
  get provider() { return documentMemory({ maxBytes: 4_096 }); },
});
`),
      /memory\.ts defineMemory\(\) cannot use methods or accessors/,
    );
    await assert.rejects(
      build(`import { defineMemory, documentMemory } from "@opencomputer/agent";

export const memory = defineMemory({
  id: "requirements",
  description: "Requirements.",
  ["provider"]: documentMemory({ maxBytes: 4_096 }),
});
`),
      /memory\.ts defineMemory\(\) must use static property names/,
    );
    await assert.rejects(
      build(`import { defineMemory } from "@opencomputer/agent";

const options = { id: "requirements", description: "Requirements." };
export const memory = defineMemory(options);
`),
      /memory\.ts defineMemory\(\) requires one object literal argument/,
    );
    await assert.rejects(
      build(`import { defineMemory, documentMemory } from "@opencomputer/agent";

const options = { maxBytes: 4_096 };
export const memory = defineMemory({
${declaration("documentMemory(options)")}});
`),
      /memory\.ts Memory requirements documentMemory\(\) requires one object literal argument/,
    );
    await assert.rejects(
      build(`import { defineMemory, documentMemory } from "@opencomputer/agent";

const LIMIT = 4_096;
export const memory = defineMemory({
${declaration("documentMemory({ maxBytes: LIMIT })")}});
`),
      /memory\.ts Memory requirements documentMemory\(\) maxBytes must be a static JSON value/,
    );

    // Review reproduction (U5): a namespace member reached through bracket
    // access executed a definition the compiler never registered.
    await assert.rejects(
      build(`import * as oc from "@opencomputer/agent";

export const memory = oc["defineMemory"]({ id: "notes", description: "Notes." });
`),
      /memory\.ts calls oc\["defineMemory"\]\(\); the compiler registers memory only from a direct defineMemory\(\) call, so import defineMemory by name from @opencomputer\/agent/,
    );
    await assert.rejects(
      build(`import * as oc from "@opencomputer/agent";

const name = "defineMemory";
export const memory = oc[name]({ id: "notes", description: "Notes." });
`),
      /memory\.ts accesses oc\[\.\.\.\] with a computed key; the compiler cannot tell whether that names a memory authoring function, so import what you need by name from @opencomputer\/agent/,
    );
    await assert.rejects(
      build(`import * as oc from "@opencomputer/agent";

const agent = oc;
export const memory = agent.defineMemory({ id: "notes", description: "Notes." });
`),
      /memory\.ts uses the namespace import oc other than as oc\.<name>; the compiler registers memory only from a direct defineMemory\(\) call, so import defineMemory by name from @opencomputer\/agent/,
    );
    await assert.rejects(
      build(`export const memory = (await import("@opencomputer/agent")).defineMemory({ id: "notes", description: "Notes." });
`),
      /memory\.ts imports @opencomputer\/agent dynamically; the compiler registers memory only from a static import, so import defineMemory by name/,
    );
    // The same reach through a module that re-exports the package.
    await assert.rejects(
      build(
        `import * as lib from "./lib";

export const memory = lib.defineMemory({ id: "notes", description: "Notes." });
`,
        ["lib.ts", 'export * from "@opencomputer/agent";\n'],
      ),
      /memory\.ts calls lib\.defineMemory\(\); the compiler registers memory only from a direct defineMemory\(\) call/,
    );
    await rm(resolve(initialized.agentRoot, "lib.ts"));

    // Type-only references and unaliased re-exports do not change what runs.
    await writeFile(
      resolve(initialized.agentRoot, "lib.ts"),
      'export { defineMemory, documentMemory } from "@opencomputer/agent";\n',
    );
    const built = await build(`import type { MemoryDefinition } from "@opencomputer/agent";
import { defineMemory, documentMemory } from "./lib";

type Declared = typeof defineMemory;
export const memory: MemoryDefinition = defineMemory({
${declaration("documentMemory({ maxBytes: 4_096 })")}});
export const declared: Declared | undefined = undefined;
`);
    assert.deepEqual(built.memory, [
      {
        id: "requirements",
        description: "Requirements.",
        provider: { kind: "document", maxBytes: 4096 },
      },
    ]);

    // A star re-export and a re-export of an imported binding are chains the
    // compiler follows; the namespace import stays usable for other members.
    await writeFile(
      resolve(initialized.agentRoot, "lib.ts"),
      'import { documentMemory } from "@opencomputer/agent";\nexport * from "@opencomputer/agent";\nexport { documentMemory };\n',
    );
    const chained = await build(`import * as oc from "@opencomputer/agent";
import { defineMemory, documentMemory } from "./lib";

export const memory = defineMemory({
${declaration("documentMemory({ maxBytes: 2_048 })")}});
export const secret = oc.useSecret;
`);
    assert.deepEqual(chained.memory, [
      {
        id: "requirements",
        description: "Requirements.",
        provider: { kind: "document", maxBytes: 2048 },
      },
    ]);
    await rm(resolve(initialized.agentRoot, "lib.ts"));

    // Review reproduction (U5): the spelling alone is not a declaration. A
    // property, a string and a local function of that name are unrelated to
    // the package's defineMemory; they neither register memory nor fail the
    // build.
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { useInput } from "@opencomputer/agent";
import { labels, config } from "./memory";

export default function Agent() {
  return \`\${labels.defineMemory}: \${config.id} \${useInput().text ?? ""}\`;
}
`,
    );
    const unrelated = await build(`export const labels = { defineMemory: "Memory settings" };

function defineMemory(input: { id: string }) {
  return { ...input, defineMemory: true };
}
export const config = defineMemory({ id: "settings" });
export const spelled = "defineMemory";
`);
    assert.deepEqual(unrelated.memory, []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a registered memory declaration is the definition the artifact executes", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-memory-parity-"));
  const root = resolve(parent, "app");
  try {
    const initialized = await initializeAgentProject(root);
    await writeFile(resolve(initialized.agentRoot, "knowledge.ts"), KNOWLEDGE_MEMORY);
    await writeFile(
      resolve(initialized.agentRoot, "agent.ts"),
      `import { defineMemory, documentMemory, useMemory } from "@opencomputer/agent";
export { knowledge } from "./knowledge";

export const requirements = defineMemory({
  id: "requirements",
  description: "  Verified requirements and decisions for a workshop, kept for later work.  ",
  provider: documentMemory({ maxBytes: 8_192 }),
});
export const notes = defineMemory({ id: "notes", description: "Notes." });

export default function Agent() {
  return useMemory(requirements).text;
}
`,
    );
    const built = await buildAgentArtifact(initialized.agentRoot);
    const runtime = resolve(initialized.agentRoot, ".opencomputer", "runtime");
    const module = (await import(
      `${pathToFileURL(resolve(runtime, "agent.js")).href}?test=${crypto.randomUUID()}`
    )) as Record<string, { kind: string; version: number; id: string; description: string; provider: unknown }>;
    const executed = ["knowledge", "notes", "requirements"].map((name) => {
      const definition = module[name]!;
      assert.equal(definition.kind, "memory");
      assert.equal(definition.version, 1);
      assert.ok(Object.isFrozen(definition));
      assert.ok(Object.isFrozen(definition.provider));
      return JSON.parse(
        JSON.stringify({
          id: definition.id,
          description: definition.description,
          provider: definition.provider,
        }),
      ) as unknown;
    });
    assert.deepEqual(built.memory, executed);
    assert.deepEqual(built.memory, [
      KNOWLEDGE_DECLARATION,
      { id: "notes", description: "Notes.", provider: { kind: "document", maxBytes: 8192 } },
      REQUIREMENTS_DECLARATION,
    ]);

    // The runtime rejects what the compiler rejects: the shim is the same
    // contract module, so a declaration that would not compile does not run.
    const shim = (await import(
      `${pathToFileURL(resolve(runtime, "opencomputer-agent.js")).href}?test=${crypto.randomUUID()}`
    )) as {
      defineMemory: (input: unknown) => { provider: { tools?: Array<{ input: Record<string, unknown> }> } };
      documentMemory: (input?: unknown) => unknown;
      httpMemory: (input: unknown) => unknown;
    };
    assert.throws(
      () => shim.documentMemory({ maxBytes: 16_385 }),
      /documentMemory maxBytes must be a whole number between 1 and 16384/,
    );
    assert.throws(
      () => shim.defineMemory({ id: "Requirements", description: "R." }),
      /defineMemory IDs must use lowercase letters, numbers, and single hyphens/,
    );
    assert.throws(
      () =>
        shim.httpMemory({
          connection: { kind: "connection", id: "memory-service", methods: ["GET"] },
        }),
      /httpMemory requires connection memory-service to allow POST/,
    );
    const definition = shim.defineMemory({
      id: "knowledge",
      description: "Facts.",
      provider: shim.httpMemory({
        connection: { kind: "connection", id: "memory-service" },
        tools: [
          {
            name: "remember",
            description: "Save.",
            access: "write",
            input: { type: "object", properties: { fact: { type: "string" } } },
          },
        ],
      }),
    });
    const schema = definition.provider.tools![0]!.input;
    assert.ok(Object.isFrozen(schema));
    assert.ok(Object.isFrozen(schema.properties));
    assert.ok(Object.isFrozen((schema.properties as Record<string, unknown>).fact));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the CLI's memory contract is the agent package's module", async () => {
  const repo = resolve(import.meta.dirname, "..", "..");
  const packageModule = resolve(repo, "agent", "src", "memory.ts");
  const cliModule = resolve(repo, "cli", "src", "memory.ts");
  assert.equal(
    await readFile(cliModule, "utf8"),
    await readFile(packageModule, "utf8"),
    "cli/src/memory.ts must stay byte-identical to agent/src/memory.ts; the compiler, the runtime shim and @opencomputer/agent share it",
  );
});
