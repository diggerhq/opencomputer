import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  projectAgentMembers,
  selectProjectAgent,
  type ProjectAgentMember,
} from "./agent-selection.js";
import { runCommand } from "./commands.js";
import { CLIError } from "./errors.js";
import { initializeAgentProject } from "./project.js";

// OCFR-18: from a multi-agent project root, `secrets set NAME --agent <cloud
// agent>` selected the cloud scope but then failed to pick the one local agent
// whose connections give the secret its origins ("select an agent when
// starting dev mode"). Selection now maps the cloud agent to its project
// member through the bound project, in one place, for every command.

const members: ProjectAgentMember[] = projectAgentMembers(
  [
    { localId: "hello-world", root: "/p/opencomputer/agents/hello-world", manifest: {} as never },
    { localId: "billing", root: "/p/opencomputer/agents/billing", manifest: {} as never },
    { localId: "support", root: "/p/opencomputer/agents/support", manifest: {} as never },
  ],
  { agentId: "app" },
);

test("--agent selects the cloud agent and its local source through the binding", () => {
  assert.equal(selectProjectAgent(members, { agent: "app" }).localId, "hello-world");
  assert.equal(selectProjectAgent(members, { agent: "app--billing" }).localId, "billing");
  assert.equal(selectProjectAgent(members, { agent: "support" }).agentId, "app--support");
  assert.equal(selectProjectAgent(members, { localAgent: "billing" }).agentId, "app--billing");
  assert.equal(
    selectProjectAgent(members, { agent: "app--billing", localAgent: "billing" }).localId,
    "billing",
  );
  assert.equal(selectProjectAgent(members.slice(0, 1)).localId, "hello-world");
});

test("acceptance 2: unknown or ambiguous mappings list the valid local IDs and never pick the first", () => {
  const codeOf = (run: () => unknown): { code: string; message: string; details: unknown } => {
    try {
      run();
    } catch (error) {
      assert.ok(error instanceof CLIError);
      return { code: error.code, message: error.message, details: error.details };
    }
    assert.fail("expected the selection to fail");
  };

  const unknown = codeOf(() => selectProjectAgent(members, { agent: "app--payments" }));
  assert.equal(unknown.code, "local_agent_not_found");
  assert.match(unknown.message, /hello-world \(cloud agent app\), billing \(cloud agent app--billing\), support/);
  assert.deepEqual(
    (unknown.details as { localAgents: string[] }).localAgents,
    ["hello-world", "billing", "support"],
  );

  const unknownLocal = codeOf(() => selectProjectAgent(members, { localAgent: "payments" }));
  assert.equal(unknownLocal.code, "local_agent_not_found");
  assert.match(unknownLocal.message, /No local agent payments/);

  const mismatch = codeOf(() =>
    selectProjectAgent(members, { agent: "app--billing", localAgent: "support" }),
  );
  assert.equal(mismatch.code, "agent_selection_mismatch");
  assert.match(mismatch.message, /support deploys as cloud agent app--support, not app--billing/);

  // A local id that is also another member's cloud id: cloud ids win, and
  // several cloud matches are ambiguous.
  const twins = projectAgentMembers(
    [
      { localId: "app", root: "/p/a", manifest: {} as never },
      { localId: "app--app", root: "/p/b", manifest: {} as never },
      { localId: "app", root: "/p/c", manifest: {} as never },
    ],
    { agentId: "app" },
  );
  assert.equal(selectProjectAgent(twins, { agent: "app--app" }).root, "/p/c");
  assert.equal(selectProjectAgent(twins, { agent: "app--app--app" }).root, "/p/b");
  const ambiguous = codeOf(() =>
    selectProjectAgent(
      [...twins, { localId: "app", agentId: "app--app", root: "/p/d", index: 3 }],
      { agent: "app--app" },
    ),
  );
  assert.equal(ambiguous.code, "local_agent_ambiguous");
  assert.match(ambiguous.message, /matches several local agents/);

  const none = codeOf(() => selectProjectAgent(members));
  assert.equal(none.code, "local_agent_required");
  assert.match(none.message, /3 agents; choose one/);
  assert.match(none.message, /hello-world.*billing.*support/);
});

// ── The commands, against a Management API double ────────────────────────────

const AGENT_SOURCE = (id: string, pathPrefix: string) =>
  `import { bearer, defineConnection, useConnection, useSecret } from "@opencomputer/agent";
const api = defineConnection({
  id: "${id}-api",
  origin: "https://${id}.example.com",
  pathPrefix: ${pathPrefix},
  headers: { Authorization: bearer(useSecret("API_TOKEN")) },
});
export default function Agent() { useConnection(api); return "${id}"; }
`;

async function threeAgentProject(billingPathPrefix = '"/v1"'): Promise<string> {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-agents-"));
  const { root } = await initializeAgentProject(resolve(parent, "app"));
  for (const [id, prefix] of [["billing", billingPathPrefix], ["support", '"/v2"']] as const) {
    const agentRoot = resolve(root, "opencomputer", "agents", id);
    await mkdir(agentRoot, { recursive: true });
    await writeFile(resolve(agentRoot, "agent.ts"), AGENT_SOURCE(id, prefix));
  }
  await writeFile(
    resolve(root, "opencomputer", "project.ts"),
    'export default { name: "app", agents: ["hello-world", "billing", "support"] };\n',
  );
  await writeFile(resolve(root, "opencomputer", ".env.example"), "API_TOKEN=\n");
  await writeFile(resolve(root, "opencomputer", ".env.local"), "API_TOKEN=x\n");
  await mkdir(resolve(root, ".opencomputer"), { recursive: true });
  await writeFile(
    resolve(root, ".opencomputer", "project.json"),
    JSON.stringify({
      version: 1,
      apiUrl: "http://127.0.0.1:1",
      projectId: "prj_1",
      projectName: "app",
      agentId: "app",
    }),
  );
  return parent;
}

interface Cloud {
  puts: Array<{ path: string; body: Record<string, unknown> }>;
}

function fakeCloud(context: test.TestContext): Cloud {
  const cloud: Cloud = { puts: [] };
  const agents = ["app", "app--billing", "app--support"].map((id) => ({ id, name: id }));
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/api/managed-agents/projects" && request.method === "GET") {
      return Response.json({
        projects: [
          { id: "prj_1", slug: "app", name: "app", environments: [], agents, createdAt: "2026-01-01T00:00:00Z" },
        ],
      });
    }
    const secret = url.pathname.match(/^\/api\/managed-agents\/projects\/prj_1\/secrets\/([^/]+)$/);
    if (secret && request.method === "PUT") {
      const body = (await request.json()) as Record<string, unknown>;
      cloud.puts.push({ path: url.pathname, body });
      return Response.json({
        name: secret[1],
        projectId: "prj_1",
        environment: body.environment,
        ...(body.agentId ? { agentId: body.agentId } : {}),
        allowedOrigins: body.allowedOrigins,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    }
    return Response.json({ error: { code: "not_found", message: url.pathname } }, { status: 404 });
  });
  return cloud;
}

/** Run one command from `cwd` with a piped secret value, capturing JSON stdout. */
async function runFrom(
  context: test.TestContext,
  cwd: string,
  command: string,
  args: string[],
): Promise<{ stdout: string; error?: CLIError | Error }> {
  const previousCwd = process.cwd();
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: Object.assign(Readable.from(["s3cret"]), { isTTY: false }),
  });
  let stdout = "";
  const write = context.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  process.chdir(cwd);
  try {
    await runCommand(command, args, {
      apiUrl: "http://127.0.0.1:1",
      apiKey: "osb_test",
      json: true,
    });
    return { stdout };
  } catch (error) {
    return { stdout, error: error as Error };
  } finally {
    process.chdir(previousCwd);
    Object.defineProperty(process, "stdin", stdin);
    write.mock.restore();
  }
}

test("acceptance 1 and 3: from a three-agent root, `secrets set --agent` infers only that agent's origins", async (context) => {
  const parent = await threeAgentProject();
  const cloud = fakeCloud(context);
  try {
    const run = await runFrom(context, resolve(parent, "app"), "secrets", [
      "set",
      "API_TOKEN",
      "--agent",
      "app--billing",
      "--value-stdin",
    ]);
    assert.equal(run.error, undefined, run.error?.message);
    assert.equal(cloud.puts.length, 1);
    assert.deepEqual(cloud.puts[0]!.body.allowedOrigins, ["https://billing.example.com"]);
    assert.equal(cloud.puts[0]!.body.agentId, "app--billing");
    const output = JSON.parse(run.stdout) as { preflight: unknown; allowedOrigins: string[] };
    assert.deepEqual(output.preflight, { agent: { localId: "billing", agentId: "app--billing" } });
    assert.deepEqual(output.allowedOrigins, ["https://billing.example.com"]);

    const alias = await runFrom(context, resolve(parent, "app"), "secrets", [
      "set",
      "API_TOKEN",
      "--agent",
      "billing",
      "--value-stdin",
    ]);
    assert.equal(alias.error, undefined, alias.error?.message);
    assert.equal(cloud.puts.length, 2);
    assert.equal(cloud.puts[1]!.body.agentId, "app--billing", "a local id alias scopes to its cloud agent");
    assert.deepEqual(cloud.puts[1]!.body.allowedOrigins, ["https://billing.example.com"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("`--local-agent` names the source when the cloud id is not given, and the mapping is checked when both are", async (context) => {
  const parent = await threeAgentProject();
  const cloud = fakeCloud(context);
  try {
    const app = resolve(parent, "app");
    const local = await runFrom(context, app, "secrets", [
      "set",
      "API_TOKEN",
      "--local-agent",
      "support",
      "--value-stdin",
    ]);
    assert.equal(local.error, undefined, local.error?.message);
    assert.equal(cloud.puts[0]!.body.agentId, "app--support");
    assert.deepEqual(cloud.puts[0]!.body.allowedOrigins, ["https://support.example.com"]);

    const mismatch = await runFrom(context, app, "secrets", [
      "set",
      "API_TOKEN",
      "--agent",
      "app--billing",
      "--local-agent",
      "support",
      "--value-stdin",
    ]);
    assert.ok(mismatch.error instanceof CLIError);
    assert.equal(mismatch.error.code, "agent_selection_mismatch");
    assert.equal(cloud.puts.length, 1);

    const none = await runFrom(context, app, "secrets", ["set", "API_TOKEN", "--value-stdin"]);
    assert.ok(none.error instanceof CLIError);
    assert.equal(none.error.code, "local_agent_required");
    assert.match(none.error.message, /billing/);

    // Standing in an agent's directory still names it, as it always has.
    const inside = await runFrom(
      context,
      resolve(app, "opencomputer", "agents", "support"),
      "secrets",
      ["set", "API_TOKEN", "--value-stdin"],
    );
    assert.equal(inside.error, undefined, inside.error?.message);
    assert.deepEqual(cloud.puts.at(-1)!.body.allowedOrigins, ["https://support.example.com"]);
    assert.equal(cloud.puts.at(-1)!.body.agentId, undefined);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("acceptance 7: a compiler requirement fails the secret before any cloud mutation", async (context) => {
  const parent = await threeAgentProject("prefix");
  const cloud = fakeCloud(context);
  try {
    await writeFile(
      resolve(parent, "app", "opencomputer", "agents", "billing", "agent.ts"),
      `const prefix = "/v1";\n${AGENT_SOURCE("billing", "prefix")}`,
    );
    const run = await runFrom(context, resolve(parent, "app"), "secrets", [
      "set",
      "API_TOKEN",
      "--agent",
      "app--billing",
      "--value-stdin",
    ]);
    assert.ok(run.error instanceof CLIError);
    assert.equal(run.error.code, "literal_required");
    assert.match(run.error.message, /connection billing-api pathPrefix must be a string literal/);
    assert.match(run.error.hint, /Nothing was changed in the cloud/);
    assert.deepEqual(run.error.details, { agent: { localId: "billing", agentId: "app--billing" } });
    assert.deepEqual(cloud.puts, []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("`doctor --agent` narrows to one member and `deploy` refuses a selection", async (context) => {
  const parent = await threeAgentProject();
  fakeCloud(context);
  try {
    const app = resolve(parent, "app");
    const narrowed = await runFrom(context, app, "doctor", ["--agent", "app--billing"]);
    assert.equal(narrowed.error, undefined, narrowed.error?.message);
    const result = JSON.parse(narrowed.stdout) as {
      ok: boolean;
      resolution: { selected?: unknown; agents: unknown[] };
    };
    assert.equal(result.ok, true);
    assert.equal(result.resolution.agents.length, 3);
    assert.deepEqual(result.resolution.selected, { localId: "billing", agentId: "app--billing" });

    const unknown = await runFrom(context, app, "doctor", ["--agent", "app--payments"]);
    assert.ok(unknown.error instanceof CLIError);
    assert.equal(unknown.error.code, "local_agent_not_found");

    const deploy = await runFrom(context, app, "deploy", ["--agent", "app--billing"]);
    assert.match(deploy.error?.message ?? "", /publish every agent of the project together/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
