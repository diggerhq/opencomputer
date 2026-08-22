import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { Cron } from "croner";
import ts from "typescript";

export interface AgentManifest {
  schema: 1;
  id: string;
  name: string;
}

export interface BuiltAgentArtifact {
  agentId: string;
  name: string;
  channels: string[];
  connections: string[];
  httpConnections: HttpConnectionManifest[];
  body: Buffer;
  digest: string;
  elapsedMs: number;
}

export interface HttpConnectionManifest {
  id: string;
  origin: string;
  headers: Record<
    string,
    string | { kind: "secret"; name: string; prefix?: string; suffix?: string }
  >;
  methods?: string[];
  pathPrefix?: string;
  redirectOrigins?: Array<{ origin: string; pathPrefix?: string }>;
}

export interface McpServerManifest {
  id: string;
  url: string;
  connection?: string;
}

export interface ChannelDestinationManifest {
  type: "conversation";
  visibility: "public" | "private";
}

export interface ChannelDefinitionManifest {
  id: string;
  type: "slack";
  displayName?: string;
  scopes: { bot: string[] };
  events: Array<"app_mention" | "message.im">;
  destinations: Record<string, ChannelDestinationManifest>;
  routing: { whenAmbiguous: "ask" };
}

export interface ChannelRegistrationManifest {
  agentId: string;
  channelId: string;
  triggers: Array<"mention" | "direct-message">;
}

export interface OutboxDefinitionManifest {
  id: string;
  channelId: string;
  destination: string;
}

export interface OutboxRegistrationManifest {
  agentId: string;
  outboxId: string;
}

export interface ScheduleDefinitionManifest {
  id: string;
  agentId: string;
  cron: string;
  timezone: string;
  enabled: Array<"development" | "production">;
  overlap: "skip" | "allow";
  dispatch: {
    text?: string;
    payload?: unknown;
  };
}

export interface ProjectResourceManifest {
  version: 1;
  channels: ChannelDefinitionManifest[];
  channelRegistrations: ChannelRegistrationManifest[];
  outboxes: OutboxDefinitionManifest[];
  outboxRegistrations: OutboxRegistrationManifest[];
  schedules: ScheduleDefinitionManifest[];
}

export interface BuiltProjectResources {
  manifest: ProjectResourceManifest;
  digest: string;
}

export interface ProjectAgentSource {
  localId: string;
  root: string;
  manifest: AgentManifest;
}

const AGENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function updateGitignore(root: string): Promise<void> {
  const path = resolve(root, ".gitignore");
  const required = [
    "node_modules/",
    "dist/",
    ".opencomputer/",
    ".env",
    ".env.local",
  ];
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    // New repositories do not have a gitignore yet.
  }
  const lines = new Set(existing.split(/\r?\n/));
  const missing = required.filter((line) => !lines.has(line));
  if (!missing.length) return;
  const prefix =
    existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
  await writeFile(path, `${prefix}${missing.join("\n")}\n`);
}

export function agentIdFromName(value: string): string {
  const id = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id || !AGENT_ID_PATTERN.test(id)) {
    throw new Error("Agent names must contain letters or numbers");
  }
  return id;
}

export async function writeManifest(
  root: string,
  manifest: AgentManifest,
): Promise<void> {
  if (!AGENT_ID_PATTERN.test(manifest.id)) {
    throw new Error(
      "Agent IDs must use lowercase letters, numbers, and single hyphens",
    );
  }
  await writeFile(
    resolve(root, "opencomputer.toml"),
    [
      "# Committed agent identity. Keep `id` stable across deployments.",
      "schema = 1",
      `id = ${JSON.stringify(manifest.id)}`,
      `name = ${JSON.stringify(manifest.name)}`,
      "",
    ].join("\n"),
  );
}

function tomlString(source: string, key: string): string | undefined {
  const match = source.match(
    new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, "m"),
  );
  if (!match?.[1]) return undefined;
  try {
    const value: unknown = JSON.parse(match[1]);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function readManifest(root: string): Promise<AgentManifest> {
  if (!(await exists(resolve(root, "opencomputer.toml")))) {
    const id = agentIdFromName(basename(root));
    return {
      schema: 1,
      id,
      name: id
        .split("-")
        .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
        .join(" "),
    };
  }
  const source = await readFile(resolve(root, "opencomputer.toml"), "utf8");
  const schema = Number(source.match(/^\s*schema\s*=\s*(\d+)\s*$/m)?.[1]);
  const id = tomlString(source, "id");
  const name = tomlString(source, "name");
  if (schema !== 1 || !id || !name || !AGENT_ID_PATTERN.test(id)) {
    throw new Error(
      "opencomputer.toml must contain schema = 1 and a valid id and name",
    );
  }
  return {
    schema: 1,
    id,
    name,
  };
}

export async function findAgentRoot(
  startDirectory = process.cwd(),
): Promise<string | undefined> {
  let directory = resolve(startDirectory);
  for (;;) {
    const nested = resolve(directory, "opencomputer");
    if (await exists(resolve(directory, "agent.ts"))) {
      return directory;
    }
    if (await exists(resolve(nested, "agent.ts"))) {
      return nested;
    }
    for (const agentsDirectory of [
      resolve(directory, "opencomputer", "agents"),
      resolve(directory, "agents"),
    ]) {
      if (!(await exists(agentsDirectory))) continue;
      const detected: string[] = [];
      for (const entry of await readdir(agentsDirectory, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) continue;
        const agent = resolve(agentsDirectory, entry.name);
        if (await exists(resolve(agent, "agent.ts"))) {
          detected.push(agent);
        }
      }
      if (detected.length === 1) return detected[0];
      if (detected.length > 1) {
        throw new Error(
          "This project has multiple agents. Select an agent when starting dev mode.",
        );
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function projectAgentIds(source: string, path: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  for (const statement of file.statements) {
    if (
      !ts.isExportAssignment(statement) ||
      !ts.isObjectLiteralExpression(statement.expression)
    ) {
      continue;
    }
    const property = statement.expression.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ts.isPropertyAssignment(candidate) &&
        ((ts.isIdentifier(candidate.name) &&
          candidate.name.text === "agents") ||
          (ts.isStringLiteral(candidate.name) &&
            candidate.name.text === "agents")),
    );
    if (!property || !ts.isArrayLiteralExpression(property.initializer)) break;
    const ids = property.initializer.elements.map((element) => {
      if (!ts.isStringLiteralLike(element)) {
        throw new Error(
          "opencomputer/project.ts agents must be string literals",
        );
      }
      return element.text;
    });
    if (!ids.length || new Set(ids).size !== ids.length) {
      throw new Error(
        "opencomputer/project.ts must list at least one unique agent",
      );
    }
    return ids;
  }
  throw new Error(
    "opencomputer/project.ts must export an object with an agents array",
  );
}

export async function readProjectAgents(
  projectRoot: string,
): Promise<ProjectAgentSource[]> {
  const path = resolve(projectRoot, "opencomputer", "project.ts");
  const ids = projectAgentIds(await readFile(path, "utf8"), path);
  return Promise.all(
    ids.map(async (localId) => {
      if (!AGENT_ID_PATTERN.test(localId)) {
        throw new Error(`Invalid project agent ID: ${localId}`);
      }
      const root = resolve(projectRoot, "opencomputer", "agents", localId);
      if (!(await exists(resolve(root, "agent.ts")))) {
        throw new Error(
          `Project agent ${localId} is missing opencomputer/agents/${localId}/agent.ts`,
        );
      }
      return { localId, root, manifest: await readManifest(root) };
    }),
  );
}

export async function assertStarterTarget(directory: string): Promise<void> {
  const root = resolve(directory);
  if (!(await exists(root))) {
    await mkdir(root, { recursive: true });
    return;
  }
  const reserved = [
    "opencomputer/project.ts",
    "opencomputer/agents/hello-world/agent.ts",
    "package.json",
    "vite.config.ts",
    "index.html",
    "src/App.tsx",
    "src/main.tsx",
  ];
  const conflicts: string[] = [];
  for (const path of reserved) {
    if (await exists(resolve(root, path))) conflicts.push(path);
  }
  if (conflicts.length) {
    throw new Error(
      `Target already contains OpenComputer app files: ${conflicts.join(", ")}`,
    );
  }
}

export async function initializeAgentProject(
  directory: string,
  project?: { id: string; name: string; agentId: string },
  options: { spa?: boolean } = {},
): Promise<{
  root: string;
  agentRoot: string;
  manifest: AgentManifest;
  files: string[];
}> {
  const root = resolve(directory);
  const spa = options.spa ?? false;
  const agentRoot = resolve(root, "opencomputer", "agents", "hello-world");
  await assertStarterTarget(root);
  await mkdir(agentRoot, { recursive: true });
  const manifest: AgentManifest = {
    schema: 1,
    id: project?.agentId ?? "hello-world",
    name: "Hello World",
  };
  for (const path of [
    "opencomputer.toml",
    "opencomputer.config.ts",
    "opencomputer.ts",
    "opencode.json",
    "package.json",
    ".gitignore",
    "README.md",
    "tools",
    "connections",
    "skills",
    "channels",
    "workspace",
    "evals",
  ]) {
    await rm(resolve(agentRoot, path), { recursive: true, force: true });
  }
  await writeFile(
    resolve(agentRoot, "agent.ts"),
    `import { useInput, useModel } from "@opencomputer/agent";

export default function Agent() {
  const input = useInput();
  useModel("anthropic/claude-sonnet-4.6");

  return input.text
    ? "You are a helpful OpenComputer agent. Respond directly to: " + input.text
    : "You are a helpful OpenComputer agent.";
}
`,
  );
  await updateGitignore(root);
  await writeFile(
    resolve(root, "opencomputer", ".env.example"),
    `# Development agent secrets belong in .env.local beside this file.
# Add only names referenced by useSecret() in a defineConnection() declaration.
`,
  );
  if (spa) await mkdir(resolve(root, "src"), { recursive: true });
  await writeFile(
    resolve(root, "opencomputer", "project.ts"),
    `export default {
  name: ${JSON.stringify(project?.name ?? basename(root))},
  agents: ["hello-world"],
};
`,
  );

  await writeFile(
    resolve(root, "package.json"),
    `${JSON.stringify(
      {
        name: `opencomputer-app-${manifest.id}`,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          ...(spa
            ? { "dev:web": "vite", build: "tsc -b && vite build" }
            : {}),
          session: "opencomputer session",
          deploy: "opencomputer deploy",
        },
        dependencies: {
          "@opencomputer/agent": "^0.5.0",
          ...(spa
            ? {
                "@opencomputer/react": "^0.1.0",
                react: "^19.2.0",
                "react-dom": "^19.2.0",
              }
            : {}),
        },
        devDependencies: {
          "@opencomputer/cli": "^0.6.1",
          ...(spa
            ? {
                "@types/node": "^24.0.0",
                "@types/react": "^19.2.0",
                "@types/react-dom": "^19.2.0",
                "@vitejs/plugin-react": "^6.0.0",
                typescript: "^5.9.0",
                vite: "^8.0.0",
              }
            : {}),
        },
      },
      null,
      2,
    )}\n`,
  );
  if (spa)
    await writeFile(
      resolve(root, "vite.config.ts"),
      `import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function openComputerDev() {
  try {
    return JSON.parse(
      readFileSync(resolve(".opencomputer/dev.json"), "utf8"),
    ) as { url: string; token: string; agent: string };
  } catch {
    throw new Error(
      "OpenComputer is not running. Start npm run deploy -- --watch first.",
    );
  }
}

function openComputerAgent() {
  try {
    const binding = JSON.parse(
      readFileSync(resolve(".opencomputer/project.json"), "utf8"),
    ) as { agentId?: string };
    if (binding.agentId) return binding.agentId;
  } catch {
    // The production build below reports the actionable binding error.
  }
  throw new Error(
    "This app is not connected to an OpenComputer project. Run npm run deploy -- --watch first.",
  );
}

export default defineConfig(({ command }) => {
  const dev = command === "serve" ? openComputerDev() : undefined;
  return {
    plugins: [react()],
    define: {
      __OPENCOMPUTER_AGENT__: JSON.stringify(
        dev?.agent ?? \`\${openComputerAgent()}@production\`,
      ),
    },
    ...(dev ? { server: {
      proxy: {
        "/api/opencomputer": {
          target: dev.url,
          headers: { authorization: \`Bearer \${dev.token}\` },
          rewrite: (path) => path.replace(/^\\/api\\/opencomputer/, ""),
        },
      },
    } } : {}),
  };
});
`,
    );
  if (spa)
    await writeFile(
      resolve(root, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            useDefineForClassFields: true,
            lib: ["ES2022", "DOM", "DOM.Iterable"],
            allowJs: false,
            skipLibCheck: true,
            esModuleInterop: true,
            allowSyntheticDefaultImports: true,
            strict: true,
            forceConsistentCasingInFileNames: true,
            module: "ESNext",
            moduleResolution: "Bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            noEmit: true,
            jsx: "react-jsx",
            types: ["node", "vite/client"],
          },
          include: ["src", "vite.config.ts"],
        },
        null,
        2,
      )}\n`,
    );
  if (spa)
    await writeFile(
      resolve(root, "index.html"),
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#11110f" />
    <title>Hello World · OpenComputer</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    );
  if (spa)
    await writeFile(
      resolve(root, "src", "App.tsx"),
      `import { useAgent } from "@opencomputer/react";
import { FormEvent, useState } from "react";

declare const __OPENCOMPUTER_AGENT__: string;

export default function App() {
  const [input, setInput] = useState("");
  const { messages, send, isRunning, error } = useAgent(__OPENCOMPUTER_AGENT__);

  function submit(event: FormEvent) {
    event.preventDefault();
    const prompt = input;
    setInput("");
    void send(prompt);
  }

  return (
    <main>
      <section className="hero">
        <span className="eyebrow">OpenComputer</span>
        <h1>Hello, world.</h1>
        <p>Your first agent is live. The React app stays local while agent code syncs to Development (Cloud).</p>
      </section>

      <section className="chat" aria-label="Agent conversation">
        <div className="messages">
          {messages.length === 0 ? (
            <button className="suggestion" onClick={() => void send("Say hello and tell me what you can do.")}>
              Say hello and tell me what you can do →
            </button>
          ) : (
            messages.map((message) => (
              <article key={message.id} className={message.role}>
                <strong>{message.role === "user" ? "You" : "Agent"}</strong>
                <p>{message.text || "Thinking…"}</p>
              </article>
            ))
          )}
        </div>
        {error ? <p className="error">{error}</p> : null}
        <form onSubmit={submit}>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Message the hello-world agent…"
            aria-label="Message"
          />
          <button disabled={isRunning || !input.trim()}>
            {isRunning ? "Running…" : "Send"}
          </button>
        </form>
      </section>
    </main>
  );
}
`,
    );
  if (spa)
    await writeFile(
      resolve(root, "src", "main.tsx"),
      `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
    );
  if (spa)
    await writeFile(
      resolve(root, "src", "styles.css"),
      `@import url("https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Serif+Display&display=swap");

:root { color: #1d1c19; background: #f4f1e9; font-family: "DM Sans", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; min-height: 100vh; }
button, input { font: inherit; }
main { width: min(760px, calc(100% - 32px)); margin: 0 auto; padding: 12vh 0 48px; }
.hero { margin-bottom: 36px; }
.eyebrow { color: #706b60; font-size: 12px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; }
h1 { margin: 10px 0; font: 400 clamp(48px, 10vw, 84px)/.95 "DM Serif Display", serif; }
.hero p { max-width: 580px; color: #625e55; font-size: 18px; line-height: 1.6; }
.chat { overflow: hidden; border: 1px solid #d9d4c8; border-radius: 18px; background: rgba(255,255,255,.72); box-shadow: 0 18px 60px rgba(56,48,34,.08); }
.messages { display: grid; gap: 14px; min-height: 260px; max-height: 52vh; overflow-y: auto; padding: 24px; }
article { max-width: 82%; border-radius: 14px; padding: 12px 14px; }
article strong { display: block; margin-bottom: 4px; font-size: 12px; color: #777166; }
article p { margin: 0; line-height: 1.55; white-space: pre-wrap; }
article.user { justify-self: end; background: #1d1c19; color: white; }
article.user strong { color: #bdb7ab; }
article.assistant { background: #ece8de; }
.suggestion { align-self: center; justify-self: center; border: 1px solid #d9d4c8; border-radius: 999px; background: transparent; padding: 10px 16px; cursor: pointer; }
.suggestion:hover { background: #ece8de; }
.error { margin: 0 24px 12px; color: #a33a2b; font-size: 14px; }
form { display: flex; gap: 10px; border-top: 1px solid #ddd8cc; padding: 14px; background: white; }
input { min-width: 0; flex: 1; border: 0; outline: 0; padding: 10px; background: transparent; }
form button { border: 0; border-radius: 10px; background: #d85b35; color: white; padding: 10px 18px; font-weight: 600; cursor: pointer; }
form button:disabled { cursor: default; opacity: .45; }
`,
    );
  await writeFile(
    resolve(root, "README.md"),
    spa
      ? `# Hello World OpenComputer app

This project keeps agent definitions in \`opencomputer/\` and the React app in
\`src/\`.

Deploy agent changes to Development (Cloud):

\`\`\`bash
npm run deploy -- --watch
\`\`\`

Start the web app separately:

\`\`\`bash
npm run dev:web
\`\`\`

The first run asks you to create a cloud project or select an existing one.
That choice is saved for later watched deployments.

Development secrets can be placed in \`opencomputer/.env.local\`. Only values
referenced by \`useSecret()\` are synchronized, and their allowed origins are
inferred from \`defineConnection()\` declarations.
`
      : `# Hello World OpenComputer agent

This project keeps agent definitions in \`opencomputer/\`.

Deploy agent changes to Development (Cloud):

\`\`\`bash
npm run deploy -- --watch
\`\`\`

The first run asks you to create a cloud project or select an existing one.
That choice is saved for later watched deployments.

Development secrets can be placed in \`opencomputer/.env.local\`. Only values
referenced by \`useSecret()\` are synchronized, and their allowed origins are
inferred from \`defineConnection()\` declarations.
`,
  );

  const appFiles = spa
    ? [
        "package.json",
        "vite.config.ts",
        "tsconfig.json",
        "index.html",
        "README.md",
        ".gitignore",
        "src/App.tsx",
        "src/main.tsx",
        "src/styles.css",
      ]
    : ["package.json", "README.md", ".gitignore"];
  return {
    root,
    agentRoot,
    manifest,
    files: [
      "opencomputer/project.ts",
      "opencomputer/.env.example",
      "opencomputer/agents/hello-world/agent.ts",
      ...appFiles,
    ],
  };
}

function literalHookIds(source: string, hook: string): string[] {
  const pattern = new RegExp(`\\b${hook}\\(\\s*["']([^"']+)["']`, "g");
  return [...source.matchAll(pattern)].map((match) => match[1]!).sort();
}

function definedConnectionBindings(
  source: string,
  path: string,
): Map<string, HttpConnectionManifest> {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const definitions = new Map(
    definedHttpConnections(source, path).map((definition) => [
      definition.id,
      definition,
    ]),
  );
  const bindings = new Map<string, HttpConnectionManifest>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "defineConnection"
    ) {
      const input = node.initializer.arguments[0];
      if (input && ts.isObjectLiteralExpression(input)) {
        const id = literalStringValue(
          objectProperty(input, "id"),
          "connection id",
        );
        const definition = definitions.get(id);
        if (definition) bindings.set(node.name.text, definition);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return bindings;
}

function definedMcpServers(
  source: string,
  path: string,
  connectionBindings: ReadonlyMap<string, HttpConnectionManifest>,
): McpServerManifest[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const definitions: McpServerManifest[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineMcpServer"
    ) {
      const input = node.arguments[0];
      if (!input || !ts.isObjectLiteralExpression(input)) {
        throw new Error("defineMcpServer() requires an object literal");
      }
      const id = literalStringValue(
        objectProperty(input, "id"),
        "MCP server id",
      );
      const value = literalStringValue(
        objectProperty(input, "url"),
        `MCP server ${id} URL`,
      );
      const url = new URL(value);
      if (url.protocol !== "https:") {
        throw new Error(`MCP server ${id} must use HTTPS`);
      }
      const connectionExpression = objectProperty(input, "connection");
      let connection: HttpConnectionManifest | undefined;
      if (connectionExpression) {
        if (!ts.isIdentifier(connectionExpression)) {
          throw new Error(
            `MCP server ${id} connection must reference a defineConnection() binding`,
          );
        }
        connection = connectionBindings.get(connectionExpression.text);
        if (!connection) {
          throw new Error(
            `MCP server ${id} references unknown connection ${connectionExpression.text}`,
          );
        }
        if (
          url.origin !== connection.origin ||
          (connection.pathPrefix &&
            !url.pathname.startsWith(connection.pathPrefix))
        ) {
          throw new Error(
            `MCP server ${id} URL is outside connection ${connection.id}`,
          );
        }
      }
      definitions.push({
        id,
        url: url.toString(),
        ...(connection ? { connection: connection.id } : {}),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return definitions.sort((left, right) => left.id.localeCompare(right.id));
}

function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  const property = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      ((ts.isIdentifier(candidate.name) && candidate.name.text === name) ||
        (ts.isStringLiteral(candidate.name) && candidate.name.text === name)),
  );
  return property?.initializer;
}

function literalStringValue(
  expression: ts.Expression | undefined,
  label: string,
): string {
  if (!expression || !ts.isStringLiteralLike(expression)) {
    throw new Error(`${label} must be a string literal`);
  }
  return expression.text;
}

function literalStringArray(
  expression: ts.Expression | undefined,
  label: string,
): string[] {
  if (!expression || !ts.isArrayLiteralExpression(expression)) {
    throw new Error(`${label} must be an array literal`);
  }
  return expression.elements.map((element) =>
    literalStringValue(element, `${label} item`),
  );
}

function staticPropertyName(name: ts.PropertyName, label: string): string {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  throw new Error(`${label} must use static property names`);
}

function defaultExportCall(
  source: string,
  path: string,
  helper: string,
): ts.CallExpression {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const statement = file.statements.find(
    (candidate): candidate is ts.ExportAssignment =>
      ts.isExportAssignment(candidate) &&
      ts.isCallExpression(candidate.expression) &&
      ts.isIdentifier(candidate.expression.expression) &&
      candidate.expression.expression.text === helper,
  );
  if (!statement || !ts.isCallExpression(statement.expression)) {
    throw new Error(`${path} must default-export ${helper}()`);
  }
  return statement.expression;
}

function importedResourceId(
  source: string,
  path: string,
  localName: string,
  label: string,
): string {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      statement.importClause?.name?.text === localName,
  );
  if (!declaration || !ts.isStringLiteralLike(declaration.moduleSpecifier)) {
    throw new Error(`${path} must default-import the ${label} definition`);
  }
  const module = basename(declaration.moduleSpecifier.text).replace(
    /\.(?:js|ts)$/,
    "",
  );
  if (!AGENT_ID_PATTERN.test(module)) {
    throw new Error(`${path} imports an invalid ${label} resource name`);
  }
  return module;
}

function channelDefinition(
  source: string,
  path: string,
): ChannelDefinitionManifest {
  const call = defaultExportCall(source, path, "defineChannel");
  const input = call.arguments[0];
  if (!input || !ts.isObjectLiteralExpression(input)) {
    throw new Error(`${path} defineChannel() requires an object literal`);
  }
  const id = literalStringValue(objectProperty(input, "id"), `${path} channel id`);
  if (basename(path, ".ts") !== id || !AGENT_ID_PATTERN.test(id)) {
    throw new Error(`${path} filename must match its valid channel id`);
  }
  const type = literalStringValue(
    objectProperty(input, "type"),
    `${path} channel type`,
  );
  if (type !== "slack") throw new Error(`${path} supports only type "slack"`);
  const scopesExpression = objectProperty(input, "scopes");
  if (!scopesExpression || !ts.isObjectLiteralExpression(scopesExpression)) {
    throw new Error(`${path} scopes must be an object literal`);
  }
  const scopes = [
    ...new Set(
      literalStringArray(
        objectProperty(scopesExpression, "bot"),
        `${path} Slack bot scopes`,
      ),
    ),
  ].sort();
  const events = [
    ...new Set(
      objectProperty(input, "events")
        ? literalStringArray(objectProperty(input, "events"), `${path} events`)
        : [],
    ),
  ].sort();
  const allowedEvents = new Set(["app_mention", "message.im"]);
  if (events.some((event) => !allowedEvents.has(event))) {
    throw new Error(`${path} declares an unsupported Slack event`);
  }
  const requiredEventScopes: Record<string, string> = {
    app_mention: "app_mentions:read",
    "message.im": "im:history",
  };
  for (const event of events) {
    const required = requiredEventScopes[event]!;
    if (!scopes.includes(required)) {
      throw new Error(`${path} event ${event} requires bot scope ${required}`);
    }
  }
  const destinations: Record<string, ChannelDestinationManifest> = {};
  const destinationsExpression = objectProperty(input, "destinations");
  if (destinationsExpression) {
    if (!ts.isObjectLiteralExpression(destinationsExpression)) {
      throw new Error(`${path} destinations must be an object literal`);
    }
    for (const property of destinationsExpression.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error(`${path} destinations cannot use spreads`);
      }
      const name = staticPropertyName(property.name, `${path} destination`);
      if (!AGENT_ID_PATTERN.test(name)) {
        throw new Error(`${path} has invalid destination ${name}`);
      }
      if (!ts.isObjectLiteralExpression(property.initializer)) {
        throw new Error(`${path} destination ${name} must be an object literal`);
      }
      const destinationType = literalStringValue(
        objectProperty(property.initializer, "type"),
        `${path} destination ${name} type`,
      );
      const visibility = literalStringValue(
        objectProperty(property.initializer, "visibility"),
        `${path} destination ${name} visibility`,
      );
      if (
        destinationType !== "conversation" ||
        (visibility !== "public" && visibility !== "private")
      ) {
        throw new Error(`${path} destination ${name} is unsupported`);
      }
      const required = visibility === "private" ? "groups:read" : "channels:read";
      if (!scopes.includes(required) || !scopes.includes("chat:write")) {
        throw new Error(
          `${path} destination ${name} requires ${required} and chat:write`,
        );
      }
      destinations[name] = { type: "conversation", visibility };
    }
  }
  const routingExpression = objectProperty(input, "routing");
  if (routingExpression && !ts.isObjectLiteralExpression(routingExpression)) {
    throw new Error(`${path} routing must be an object literal`);
  }
  if (routingExpression) {
    const ambiguity = objectProperty(routingExpression, "whenAmbiguous");
    if (ambiguity && literalStringValue(ambiguity, `${path} ambiguity policy`) !== "ask") {
      throw new Error(`${path} supports only routing.whenAmbiguous = "ask"`);
    }
  }
  const displayNameExpression = objectProperty(input, "displayName");
  return {
    id,
    type: "slack",
    ...(displayNameExpression
      ? { displayName: literalStringValue(displayNameExpression, `${path} displayName`) }
      : {}),
    scopes: { bot: scopes },
    events: events as ChannelDefinitionManifest["events"],
    destinations,
    routing: { whenAmbiguous: "ask" },
  };
}

function channelRegistration(
  source: string,
  path: string,
  agentId: string,
  channels: ReadonlyMap<string, ChannelDefinitionManifest>,
): ChannelRegistrationManifest {
  const call = defaultExportCall(source, path, "registerChannel");
  const channelExpression = call.arguments[0];
  const input = call.arguments[1];
  if (!channelExpression || !ts.isIdentifier(channelExpression)) {
    throw new Error(`${path} must register an imported channel definition`);
  }
  if (!input || !ts.isObjectLiteralExpression(input)) {
    throw new Error(`${path} registerChannel() requires an object literal`);
  }
  const channelId = importedResourceId(
    source,
    path,
    channelExpression.text,
    "channel",
  );
  const channel = channels.get(channelId);
  if (!channel) throw new Error(`${path} references unknown channel ${channelId}`);
  const triggers = [
    ...new Set(
      literalStringArray(objectProperty(input, "on"), `${path} triggers`),
    ),
  ].sort();
  const triggerEvents: Record<string, string> = {
    mention: "app_mention",
    "direct-message": "message.im",
  };
  for (const trigger of triggers) {
    const event = triggerEvents[trigger];
    if (!event || !channel.events.includes(event as "app_mention" | "message.im")) {
      throw new Error(`${path} trigger ${trigger} is not declared by ${channelId}`);
    }
  }
  return {
    agentId,
    channelId,
    triggers: triggers as ChannelRegistrationManifest["triggers"],
  };
}

function outboxDefinition(
  source: string,
  path: string,
  channels: ReadonlyMap<string, ChannelDefinitionManifest>,
): OutboxDefinitionManifest {
  const call = defaultExportCall(source, path, "defineOutbox");
  const input = call.arguments[0];
  if (!input || !ts.isObjectLiteralExpression(input)) {
    throw new Error(`${path} defineOutbox() requires an object literal`);
  }
  const id = literalStringValue(objectProperty(input, "id"), `${path} outbox id`);
  if (basename(path, ".ts") !== id || !AGENT_ID_PATTERN.test(id)) {
    throw new Error(`${path} filename must match its valid outbox id`);
  }
  const delivery = objectProperty(input, "delivery");
  if (!delivery || !ts.isObjectLiteralExpression(delivery)) {
    throw new Error(`${path} delivery must be an object literal`);
  }
  const channelExpression = objectProperty(delivery, "channel");
  if (!channelExpression || !ts.isIdentifier(channelExpression)) {
    throw new Error(`${path} delivery.channel must reference an imported channel`);
  }
  const channelId = importedResourceId(
    source,
    path,
    channelExpression.text,
    "channel",
  );
  const destination = literalStringValue(
    objectProperty(delivery, "destination"),
    `${path} destination`,
  );
  if (!channels.get(channelId)?.destinations[destination]) {
    throw new Error(
      `${path} references unknown destination ${destination} on ${channelId}`,
    );
  }
  return { id, channelId, destination };
}

function outboxRegistration(
  source: string,
  path: string,
  agentId: string,
  outboxes: ReadonlyMap<string, OutboxDefinitionManifest>,
): OutboxRegistrationManifest {
  const call = defaultExportCall(source, path, "registerOutbox");
  const expression = call.arguments[0];
  if (!expression || !ts.isIdentifier(expression)) {
    throw new Error(`${path} must register an imported outbox definition`);
  }
  const outboxId = importedResourceId(source, path, expression.text, "outbox");
  if (!outboxes.has(outboxId)) {
    throw new Error(`${path} references unknown outbox ${outboxId}`);
  }
  return { agentId, outboxId };
}

function staticJsonValue(expression: ts.Expression, label: string): unknown {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expression.operand)
  ) {
    return -Number(expression.operand.text);
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.map((element) => {
      if (ts.isSpreadElement(element)) {
        throw new Error(`${label} cannot use spreads`);
      }
      return staticJsonValue(element, label);
    });
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const value: Record<string, unknown> = {};
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error(`${label} cannot use methods or spreads`);
      }
      value[staticPropertyName(property.name, label)] = staticJsonValue(
        property.initializer,
        label,
      );
    }
    return value;
  }
  throw new Error(`${label} must be a static JSON value`);
}

function scheduleDefinition(
  source: string,
  path: string,
  agentId: string,
): ScheduleDefinitionManifest {
  const call = defaultExportCall(source, path, "defineSchedule");
  const input = call.arguments[0];
  if (!input || !ts.isObjectLiteralExpression(input)) {
    throw new Error(`${path} defineSchedule() requires an object literal`);
  }
  const id = literalStringValue(objectProperty(input, "id"), `${path} schedule id`);
  if (basename(path, ".ts") !== id || !AGENT_ID_PATTERN.test(id)) {
    throw new Error(`${path} filename must match its valid schedule id`);
  }
  const cron = literalStringValue(objectProperty(input, "cron"), `${path} cron`)
    .trim()
    .replace(/\s+/g, " ");
  if (cron.split(" ").length !== 5) {
    throw new Error(`${path} cron must contain exactly five fields`);
  }
  const timezoneExpression = objectProperty(input, "timezone");
  const timezone = timezoneExpression
    ? literalStringValue(timezoneExpression, `${path} timezone`)
    : "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`${path} timezone must be a valid IANA timezone`);
  }
  try {
    new Cron(cron, { timezone, paused: true });
  } catch {
    throw new Error(`${path} cron is invalid`);
  }
  const enabledExpression = objectProperty(input, "enabled");
  const enabled = [
    ...new Set(
      enabledExpression
        ? literalStringArray(enabledExpression, `${path} enabled environments`)
        : ["production"],
    ),
  ].sort();
  if (
    !enabled.length ||
    enabled.some(
      (environment) =>
        environment !== "development" && environment !== "production",
    )
  ) {
    throw new Error(`${path} enabled environments are invalid`);
  }
  const overlapExpression = objectProperty(input, "overlap");
  const overlap = overlapExpression
    ? literalStringValue(overlapExpression, `${path} overlap`)
    : "skip";
  if (overlap !== "skip" && overlap !== "allow") {
    throw new Error(`${path} overlap must be "skip" or "allow"`);
  }
  const dispatchExpression = objectProperty(input, "dispatch");
  if (!dispatchExpression || !ts.isObjectLiteralExpression(dispatchExpression)) {
    throw new Error(`${path} dispatch must be an object literal`);
  }
  const textExpression = objectProperty(dispatchExpression, "text");
  const text = textExpression
    ? literalStringValue(textExpression, `${path} dispatch text`).trim()
    : undefined;
  const payloadExpression = objectProperty(dispatchExpression, "payload");
  const payload = payloadExpression
    ? staticJsonValue(payloadExpression, `${path} dispatch payload`)
    : undefined;
  if (!text && payload === undefined) {
    throw new Error(`${path} dispatch requires text or payload`);
  }
  if (payload !== undefined && JSON.stringify(payload).length > 32 * 1024) {
    throw new Error(`${path} dispatch payload cannot exceed 32 KiB`);
  }
  return {
    id,
    agentId,
    cron,
    timezone,
    enabled: enabled as ScheduleDefinitionManifest["enabled"],
    overlap,
    dispatch: {
      ...(text ? { text } : {}),
      ...(payload === undefined ? {} : { payload }),
    },
  };
}

async function typescriptFiles(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => resolve(directory, entry.name))
    .sort();
}

export async function readProjectResources(
  projectRoot: string,
): Promise<BuiltProjectResources> {
  const opencomputer = resolve(projectRoot, "opencomputer");
  const channelDefinitions = await Promise.all(
    (await typescriptFiles(resolve(opencomputer, "channels"))).map(async (path) =>
      channelDefinition(await readFile(path, "utf8"), path),
    ),
  );
  const channels = new Map(channelDefinitions.map((channel) => [channel.id, channel]));
  if (channels.size !== channelDefinitions.length) {
    throw new Error("Project channel IDs must be unique");
  }
  const outboxDefinitions = await Promise.all(
    (await typescriptFiles(resolve(opencomputer, "outboxes"))).map(async (path) =>
      outboxDefinition(await readFile(path, "utf8"), path, channels),
    ),
  );
  const outboxes = new Map(outboxDefinitions.map((outbox) => [outbox.id, outbox]));
  if (outboxes.size !== outboxDefinitions.length) {
    throw new Error("Project outbox IDs must be unique");
  }
  const agents = await readProjectAgents(projectRoot);
  const channelRegistrations: ChannelRegistrationManifest[] = [];
  const outboxRegistrations: OutboxRegistrationManifest[] = [];
  const schedules: ScheduleDefinitionManifest[] = [];
  for (const agent of agents) {
    for (const path of await typescriptFiles(resolve(agent.root, "channels"))) {
      channelRegistrations.push(
        channelRegistration(
          await readFile(path, "utf8"),
          path,
          agent.localId,
          channels,
        ),
      );
    }
    for (const path of await typescriptFiles(resolve(agent.root, "outboxes"))) {
      outboxRegistrations.push(
        outboxRegistration(
          await readFile(path, "utf8"),
          path,
          agent.localId,
          outboxes,
        ),
      );
    }
    for (const path of await typescriptFiles(resolve(agent.root, "schedules"))) {
      schedules.push(
        scheduleDefinition(await readFile(path, "utf8"), path, agent.localId),
      );
    }
  }
  const scheduleKeys = schedules.map(({ agentId, id }) => `${agentId}:${id}`);
  if (new Set(scheduleKeys).size !== scheduleKeys.length) {
    throw new Error("Agent schedule IDs must be unique within each agent");
  }
  const manifest: ProjectResourceManifest = {
    version: 1,
    channels: channelDefinitions.sort((left, right) => left.id.localeCompare(right.id)),
    channelRegistrations: channelRegistrations.sort((left, right) =>
      `${left.channelId}:${left.agentId}`.localeCompare(`${right.channelId}:${right.agentId}`),
    ),
    outboxes: outboxDefinitions.sort((left, right) => left.id.localeCompare(right.id)),
    outboxRegistrations: outboxRegistrations.sort((left, right) =>
      `${left.outboxId}:${left.agentId}`.localeCompare(`${right.outboxId}:${right.agentId}`),
    ),
    schedules: schedules.sort((left, right) =>
      `${left.agentId}:${left.id}`.localeCompare(`${right.agentId}:${right.id}`),
    ),
  };
  const serialized = JSON.stringify(manifest);
  return {
    manifest,
    digest: createHash("sha256").update(serialized).digest("hex"),
  };
}

function secretNameFromExpression(expression: ts.Expression): string {
  if (
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== "useSecret"
  ) {
    throw new Error("Connection secret headers must reference useSecret()");
  }
  return literalStringValue(expression.arguments[0], "useSecret name");
}

function connectionHeaderValue(
  expression: ts.Expression,
): HttpConnectionManifest["headers"][string] {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression)
  ) {
    throw new Error(
      "Connection headers must be string literals, bearer(useSecret()), or secretHeader(useSecret())",
    );
  }
  const helper = expression.expression.text;
  if (helper === "bearer") {
    const secret = expression.arguments[0];
    if (!secret) throw new Error("bearer() requires useSecret()");
    return {
      kind: "secret",
      name: secretNameFromExpression(secret),
      prefix: "Bearer ",
    };
  }
  if (helper === "secretHeader") {
    const secret = expression.arguments[0];
    if (!secret) throw new Error("secretHeader() requires useSecret()");
    const result: {
      kind: "secret";
      name: string;
      prefix?: string;
      suffix?: string;
    } = { kind: "secret", name: secretNameFromExpression(secret) };
    const options = expression.arguments[1];
    if (options) {
      if (!ts.isObjectLiteralExpression(options)) {
        throw new Error("secretHeader options must be an object literal");
      }
      const prefix = objectProperty(options, "prefix");
      const suffix = objectProperty(options, "suffix");
      if (prefix)
        result.prefix = literalStringValue(prefix, "secretHeader prefix");
      if (suffix)
        result.suffix = literalStringValue(suffix, "secretHeader suffix");
    }
    return result;
  }
  throw new Error(`Unsupported connection header helper: ${helper}`);
}

function definedHttpConnections(
  source: string,
  path: string,
): HttpConnectionManifest[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const definitions: HttpConnectionManifest[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineConnection"
    ) {
      const input = node.arguments[0];
      if (!input || !ts.isObjectLiteralExpression(input)) {
        throw new Error("defineConnection() requires an object literal");
      }
      const id = literalStringValue(
        objectProperty(input, "id"),
        "connection id",
      );
      const originValue = literalStringValue(
        objectProperty(input, "origin"),
        `connection ${id} origin`,
      );
      const origin = new URL(originValue);
      if (origin.protocol !== "https:" || origin.pathname !== "/") {
        throw new Error(
          `Connection ${id} must use an HTTPS origin without a path`,
        );
      }
      const headers: HttpConnectionManifest["headers"] = {};
      const headerExpression = objectProperty(input, "headers");
      if (headerExpression) {
        if (!ts.isObjectLiteralExpression(headerExpression)) {
          throw new Error(`Connection ${id} headers must be an object literal`);
        }
        for (const property of headerExpression.properties) {
          if (!ts.isPropertyAssignment(property)) {
            throw new Error(`Connection ${id} headers cannot use spreads`);
          }
          const name =
            ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
              ? property.name.text
              : undefined;
          if (!name)
            throw new Error(`Connection ${id} has an invalid header name`);
          const value = connectionHeaderValue(property.initializer);
          if (
            [
              "api-key",
              "authorization",
              "cookie",
              "proxy-authorization",
              "x-api-key",
            ].includes(name.toLowerCase()) &&
            typeof value === "string"
          ) {
            throw new Error(
              `Connection ${id} header ${name} must use useSecret()`,
            );
          }
          headers[name] = value;
        }
      }
      const definition: HttpConnectionManifest = {
        id,
        origin: origin.origin,
        headers,
      };
      const methods = objectProperty(input, "methods");
      if (methods) {
        if (!ts.isArrayLiteralExpression(methods)) {
          throw new Error(`Connection ${id} methods must be an array literal`);
        }
        definition.methods = methods.elements.map((method) =>
          literalStringValue(method, `connection ${id} method`).toUpperCase(),
        );
      }
      const pathPrefix = objectProperty(input, "pathPrefix");
      if (pathPrefix) {
        definition.pathPrefix = literalStringValue(
          pathPrefix,
          `connection ${id} pathPrefix`,
        );
      }
      const redirectOrigins = objectProperty(input, "redirectOrigins");
      if (redirectOrigins) {
        if (!ts.isArrayLiteralExpression(redirectOrigins)) {
          throw new Error(
            `Connection ${id} redirectOrigins must be an array literal`,
          );
        }
        if (redirectOrigins.elements.length > 16) {
          throw new Error(
            `Connection ${id} may declare at most 16 redirect origins`,
          );
        }
        const policies = new Set<string>();
        definition.redirectOrigins = redirectOrigins.elements.map(
          (element, index) => {
            if (!ts.isObjectLiteralExpression(element)) {
              throw new Error(
                `Connection ${id} redirect origin ${index} must be an object literal`,
              );
            }
            const value = literalStringValue(
              objectProperty(element, "origin"),
              `connection ${id} redirect origin ${index}`,
            );
            const redirectOrigin = new URL(value);
            if (
              redirectOrigin.protocol !== "https:" ||
              redirectOrigin.pathname !== "/"
            ) {
              throw new Error(
                `Connection ${id} redirect origin ${index} must be an HTTPS origin without a path`,
              );
            }
            const redirectPathPrefix = objectProperty(element, "pathPrefix");
            const parsedPathPrefix = redirectPathPrefix
              ? literalStringValue(
                  redirectPathPrefix,
                  `connection ${id} redirect origin ${index} pathPrefix`,
                )
              : undefined;
            if (
              parsedPathPrefix !== undefined &&
              !parsedPathPrefix.startsWith("/")
            ) {
              throw new Error(
                `Connection ${id} redirect origin ${index} pathPrefix must start with /`,
              );
            }
            const policyKey = `${redirectOrigin.origin}\n${parsedPathPrefix ?? ""}`;
            if (policies.has(policyKey)) {
              throw new Error(
                `Connection ${id} redirect origin policies must be unique`,
              );
            }
            policies.add(policyKey);
            return {
              origin: redirectOrigin.origin,
              ...(parsedPathPrefix ? { pathPrefix: parsedPathPrefix } : {}),
            };
          },
        );
      }
      definitions.push(definition);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return definitions;
}

function definedToolIds(source: string): string[] {
  return [
    ...source.matchAll(
      /\bdefineTool(?:<[^>]+>)?\s*\(\s*\{[\s\S]*?\bname\s*:\s*["']([^"']+)["'][\s\S]*?\}\s*\)/g,
    ),
  ]
    .map((match) => match[1]!)
    .sort();
}

function agentApiRuntimeSource(): string {
  return `function hooks() {
  const value = globalThis[Symbol.for("opencomputer.agent-hooks")];
  if (!value) throw new Error("OpenComputer hooks can only run while rendering an agent");
  return value;
}
function id(value, kind) {
  const normalized = String(value).trim();
  if (!normalized) throw new Error(kind + " requires a non-empty id");
  return normalized;
}
export const useSecret = (value) => {
  const name = id(value, "useSecret");
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) throw new Error("Invalid secret name " + JSON.stringify(name));
  return Object.freeze({ kind: "secret", id: name });
};
export const secretHeader = (secret, options = {}) => Object.freeze({ kind: "secret-header", secret, ...options });
export const bearer = (secret) => secretHeader(secret, { prefix: "Bearer " });
export const defineConnection = (input) => {
  const connectionId = id(input.id, "defineConnection");
  const origin = new URL(input.origin);
  if (origin.protocol !== "https:" || origin.pathname !== "/") throw new Error("Connection origins must be HTTPS origins without a path");
  for (const [name, value] of Object.entries(input.headers || {})) {
    if (["api-key", "authorization", "cookie", "proxy-authorization", "x-api-key"].includes(name.toLowerCase()) && typeof value === "string") throw new Error(name + " must use useSecret()");
  }
  const redirectOrigins = (input.redirectOrigins || []).map((input) => {
    const redirectOrigin = new URL(input.origin);
    if (redirectOrigin.protocol !== "https:" || redirectOrigin.pathname !== "/") throw new Error("Connection redirect origins must be HTTPS origins without a path");
    if (input.pathPrefix != null && !input.pathPrefix.startsWith("/")) throw new Error("Connection redirect path prefixes must start with /");
    return Object.freeze({ origin: redirectOrigin.origin, ...(input.pathPrefix ? { pathPrefix: input.pathPrefix } : {}) });
  });
  if (redirectOrigins.length > 16) throw new Error("Connections may declare at most 16 redirect origins");
  if (new Set(redirectOrigins.map(({ origin, pathPrefix }) => origin + "\\n" + (pathPrefix || ""))).size !== redirectOrigins.length) throw new Error("Connection redirect origin policies must be unique");
  return Object.freeze({
    kind: "connection",
    ...input,
    id: connectionId,
    origin: origin.origin,
    headers: Object.freeze({ ...(input.headers || {}) }),
    ...(redirectOrigins.length ? { redirectOrigins: Object.freeze(redirectOrigins) } : {}),
    async fetch(path, init = {}) {
      const base = globalThis.process?.env?.OPENCOMPUTER_CONNECTIONS_URL;
      const token = globalThis.process?.env?.OPENCOMPUTER_CONNECTION_TOKEN;
      if (!base || !token) throw new Error("OpenComputer managed egress is unavailable");
      if (!path.startsWith("/")) throw new Error("Connection requests require an absolute path");
      const headers = {};
      new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
      if (init.body != null && typeof init.body !== "string") throw new Error("Managed connection request bodies must currently be strings");
      if (typeof init.body === "string" && init.body.length > 5 * 1024 * 1024) throw new Error("Managed connection request bodies cannot exceed 5 MiB");
      return fetch(base.replace(/\\\/$/, "") + "/" + encodeURIComponent(connectionId) + "/fetch", {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ method: (init.method || "GET").toUpperCase(), path, headers, ...(init.body == null ? {} : { body: init.body }) }),
        signal: init.signal,
      });
    },
  });
};
export const defineMcpServer = (input) => {
  const url = new URL(input.url);
  if (url.protocol !== "https:") throw new Error("MCP server URLs must use HTTPS");
  return Object.freeze({ kind: "mcp", ...input, id: id(input.id, "defineMcpServer"), url: url.toString() });
};
export const defineTool = (input) => {
  const toolId = id(input.name, "defineTool");
  if (!/^[a-zA-Z0-9_-]+$/.test(toolId)) throw new Error("Invalid tool id " + JSON.stringify(toolId));
  if (!String(input.description).trim()) throw new Error("defineTool requires a non-empty description");
  if (input.input && typeof input.input !== "object") throw new Error("defineTool input must be a JSON Schema object");
  if (input.output && typeof input.output !== "object") throw new Error("defineTool output must be a JSON Schema object");
  return Object.freeze({ kind: "tool", version: 1, ...input, id: toolId, name: toolId });
};
export const publishOutbox = async (outbox, input) => {
  const outboxId = id(typeof outbox === "string" ? outbox : outbox.id, "publishOutbox");
  const type = String(input.type).trim();
  if (!/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(type)) throw new Error("Outbox event types must use lowercase dot notation");
  const idempotencyKey = String(input.idempotencyKey).trim();
  if (!idempotencyKey || idempotencyKey.length > 256) throw new Error("Outbox idempotency keys must contain 1 to 256 characters");
  const base = globalThis.process?.env?.OPENCOMPUTER_OUTBOX_URL;
  const token = globalThis.process?.env?.OPENCOMPUTER_OUTBOX_TOKEN;
  if (!base || !token) throw new Error("OpenComputer outbox delivery is unavailable");
  const response = await fetch(base.replace(/\\\/$/, "") + "/" + encodeURIComponent(outboxId) + "/items", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ type, content: input.content, idempotencyKey }),
  });
  if (!response.ok) throw new Error("Outbox publish failed with status " + response.status);
  return await response.json();
};
export const useInput = () => hooks().useInput();
export const useCurrentInput = useInput;
export const useModel = (model) => hooks().useModel(model);
export const useTool = (tool) => hooks().useTool(tool);
export const useSubagent = (agent) => hooks().useSubagent(agent);
export const useMcpServer = (server) => hooks().useMcpServer(server);
export const useSessionData = (key) => hooks().useSessionData(key);
`;
}

export async function prepareAgent(root: string): Promise<string> {
  const runtime = resolve(root, ".opencomputer", "runtime");
  await rm(runtime, { recursive: true, force: true });
  await mkdir(runtime, { recursive: true });
  const agentSource = await readFile(resolve(root, "agent.ts"), "utf8");
  const reactive = /export\s+default\s+(?:async\s+)?function\b/.test(
    agentSource,
  );
  if (!reactive) {
    throw new Error(
      "agent.ts must default-export a synchronous agent function",
    );
  }
  await writeFile(
    resolve(runtime, "AGENTS.md"),
    `# OpenComputer runtime identity

You are an OpenComputer agent. OpenCode is an internal execution detail, not
the product or support surface presented to users.

- Identify yourself and your environment as OpenComputer.
- Never direct users to OpenCode commands, settings, websites, repositories,
  issue trackers, or support channels.
- Use the question tool when structured clarification is useful. OpenComputer
  delivers it through the current chat and resumes when the user replies.

`,
  );
  const openCodeConfig = resolve(root, "opencode.json");
  if (await exists(openCodeConfig)) {
    const parsed: unknown = JSON.parse(await readFile(openCodeConfig, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("opencode.json must contain a JSON object");
    }
    const config = parsed as Record<string, unknown>;
    const configuredTools =
      config.tools &&
      typeof config.tools === "object" &&
      !Array.isArray(config.tools)
        ? (config.tools as Record<string, unknown>)
        : {};
    const configuredPermission =
      config.permission &&
      typeof config.permission === "object" &&
      !Array.isArray(config.permission)
        ? (config.permission as Record<string, unknown>)
        : {};
    const questionDenied =
      configuredTools.question === false ||
      configuredPermission.question === "deny";
    await writeFile(
      resolve(runtime, "opencode.json"),
      `${JSON.stringify(
        {
          ...config,
          tools: { ...configuredTools, question: !questionDenied },
          permission: {
            ...configuredPermission,
            ...(configuredPermission.calendar_create_time_off === "ask"
              ? { calendar_create_time_off: "allow" }
              : {}),
            question: questionDenied ? "deny" : "allow",
          },
        },
        null,
        2,
      )}\n`,
    );
  }
  const skills = resolve(root, "skills");
  if (await exists(skills)) {
    await mkdir(resolve(runtime, ".opencode"), { recursive: true });
    await cp(skills, resolve(runtime, ".opencode", "skills"), {
      recursive: true,
    });
  }
  const workspace = resolve(root, "workspace");
  if (await exists(workspace)) {
    await cp(workspace, runtime, { recursive: true });
  }
  await writeFile(
    resolve(runtime, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  const transpile = (source: string, filename: string) =>
    ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
      reportDiagnostics: true,
    });
  const compiledAgent = transpile(agentSource, "agent.ts");
  const diagnostics = compiledAgent.diagnostics ?? [];
  if (
    diagnostics.some(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    )
  ) {
    throw new Error(
      `agent.ts could not be compiled: ${diagnostics
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        )
        .join("; ")}`,
    );
  }
  const compiledSource = compiledAgent.outputText.replace(
    /(["'])@opencomputer\/agent\1/g,
    '"./opencomputer-agent.js"',
  );
  await writeFile(resolve(runtime, "agent.js"), compiledSource);
  await writeFile(
    resolve(runtime, "opencomputer-agent.js"),
    agentApiRuntimeSource(),
  );
  const toolSources: Array<{ filename: string; source: string }> = [];
  const sourceTools = resolve(root, "tools");
  if (await exists(sourceTools)) {
    const entries = await readdir(sourceTools, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.[cm]?[jt]s$/.test(entry.name)) continue;
      toolSources.push({
        filename: entry.name,
        source: await readFile(resolve(sourceTools, entry.name), "utf8"),
      });
    }
  }
  const reactiveTools: string[] = [];
  const toolModules: string[] = [];
  await mkdir(resolve(runtime, "tools"), { recursive: true });
  for (const candidate of toolSources) {
    const ids = definedToolIds(candidate.source);
    const calls = [
      ...candidate.source.matchAll(/\bdefineTool(?:<[^>]+>)?\s*\(/g),
    ].length;
    if (ids.length !== calls) {
      throw new Error(
        `${candidate.filename} must give every defineTool() a literal string name`,
      );
    }
    const compiledTool = transpile(candidate.source, candidate.filename);
    const toolDiagnostics = compiledTool.diagnostics ?? [];
    if (
      toolDiagnostics.some(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      )
    ) {
      throw new Error(
        `${candidate.filename} could not be compiled: ${toolDiagnostics
          .map((diagnostic) =>
            ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
          )
          .join("; ")}`,
      );
    }
    const outputName = candidate.filename.replace(/\.[^.]+$/, ".js");
    const output = compiledTool.outputText.replace(
      /(["'])@opencomputer\/agent\1/g,
      '"../opencomputer-agent.js"',
    );
    await writeFile(resolve(runtime, "tools", outputName), output);
    if (ids.length > 0) {
      reactiveTools.push(...ids);
      toolModules.push(`../tools/${outputName}`);
    }
  }
  const duplicateTool = reactiveTools.find(
    (id, index) => reactiveTools.indexOf(id) !== index,
  );
  if (duplicateTool) {
    throw new Error(
      `Tool id ${JSON.stringify(duplicateTool)} is defined more than once`,
    );
  }
  const httpConnections = [
    agentSource,
    ...toolSources.map((item) => item.source),
  ].flatMap((source, index) =>
    definedHttpConnections(
      source,
      index === 0 ? "agent.ts" : toolSources[index - 1]!.filename,
    ),
  );
  const duplicateConnection = httpConnections.find(
    (connection, index) =>
      httpConnections.findIndex(
        (candidate) => candidate.id === connection.id,
      ) !== index,
  );
  if (duplicateConnection) {
    throw new Error(
      `Connection id ${JSON.stringify(duplicateConnection.id)} is defined more than once`,
    );
  }
  const connectionBindings = new Map<string, HttpConnectionManifest>();
  for (const [index, source] of [
    agentSource,
    ...toolSources.map((item) => item.source),
  ].entries()) {
    const filename =
      index === 0 ? "agent.ts" : toolSources[index - 1]!.filename;
    for (const [name, definition] of definedConnectionBindings(
      source,
      filename,
    )) {
      const existing = connectionBindings.get(name);
      if (existing && existing.id !== definition.id) {
        throw new Error(
          `Connection binding ${JSON.stringify(name)} is defined more than once`,
        );
      }
      connectionBindings.set(name, definition);
    }
  }
  const mcpServerDefinitions = definedMcpServers(
    agentSource,
    "agent.ts",
    connectionBindings,
  );
  const duplicateMcpServer = mcpServerDefinitions.find(
    (server, index) =>
      mcpServerDefinitions.findIndex(
        (candidate) => candidate.id === server.id,
      ) !== index,
  );
  if (duplicateMcpServer) {
    throw new Error(
      `MCP server id ${JSON.stringify(duplicateMcpServer.id)} is defined more than once`,
    );
  }
  await mkdir(resolve(runtime, ".opencomputer"), { recursive: true });
  await writeFile(
    resolve(runtime, ".opencomputer", "reactive.json"),
    `${JSON.stringify(
      {
        version: 2,
        entry: "../agent.js",
        tools: [
          ...new Set([
            ...reactiveTools,
            ...literalHookIds(agentSource, "useTool"),
          ]),
        ].sort(),
        toolModules: toolModules.sort(),
        subagents: literalHookIds(agentSource, "useSubagent"),
        connections: httpConnections.map((connection) => connection.id).sort(),
        httpConnections,
        mcpServers: [
          ...new Set([
            ...mcpServerDefinitions.map((server) => server.id),
            ...literalHookIds(agentSource, "useMcpServer"),
          ]),
        ].sort(),
        mcpServerDefinitions,
      },
      null,
      2,
    )}\n`,
  );
  return runtime;
}

async function collectFiles(
  root: string,
  directory = root,
): Promise<Array<{ path: string; content: string }>> {
  const result: Array<{ path: string; content: string }> = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await collectFiles(root, path)));
    else if (entry.isFile()) {
      result.push({
        path: relative(root, path).split("\\").join("/"),
        content: (await readFile(path)).toString("base64"),
      });
    }
  }
  return result;
}

export async function buildAgentArtifact(
  root: string,
  agentId?: string,
): Promise<BuiltAgentArtifact> {
  const startedAt = performance.now();
  const manifest = await readManifest(root);
  const runtime = await prepareAgent(root);
  const reactive = JSON.parse(
    await readFile(resolve(runtime, ".opencomputer", "reactive.json"), "utf8"),
  ) as { connections?: string[]; httpConnections?: HttpConnectionManifest[] };
  const connections = [...new Set(reactive.connections ?? [])].sort();
  const httpConnections = reactive.httpConnections ?? [];
  const body = Buffer.from(
    JSON.stringify({
      version: 1,
      channels: [],
      files: await collectFiles(runtime),
    }),
  );
  return {
    agentId: agentId ?? manifest.id,
    name: manifest.name,
    channels: [],
    connections,
    httpConnections,
    body,
    digest: createHash("sha256").update(body).digest("hex"),
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}
