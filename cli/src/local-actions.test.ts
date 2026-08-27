import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { startLocalActionRuntime } from "./local-actions.js";

test("the local action runtime exposes compiled actions through MCP", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "opencomputer-local-actions-"));
  const runtime = resolve(root, ".opencomputer", "runtime");
  const manifestDirectory = resolve(runtime, ".opencomputer");
  try {
    await writeFile(
      resolve(root, ".env.local"),
      "LOCAL_ACTION_TEST_TOKEN=local-fixture-token\n",
    );
    await mkdir(manifestDirectory, { recursive: true });
    await writeFile(
      resolve(runtime, "actions.js"),
      `export const verify = Object.freeze({
  kind: "action",
  version: 1,
  id: "verify-action",
  server: "fixture",
  tool: "verify",
  effect: "write",
  duration: "inline",
  secrets: { token: { kind: "secret", id: "LOCAL_ACTION_TEST_TOKEN" } },
  async run({ input, secrets, repositories }) {
    return {
      value: input.value,
      tokenPresent: secrets.token === "local-fixture-token",
      mirror: repositories.application.remote,
    };
  },
});

export default function Actions() {
  const hooks = globalThis[Symbol.for("opencomputer.action-hooks")];
  hooks.useAction();
  hooks.useGate(() => ({ action: "allow" }));
}
`,
    );
    await writeFile(
      resolve(manifestDirectory, "reactive.json"),
      `${JSON.stringify({
        actions: {
          entry: "../actions.js",
          definitions: [
            {
              id: "verify-action",
              server: "fixture",
              tool: "verify",
              description: "Verify the local action runtime",
              effect: "write",
              duration: "inline",
              secrets: { token: "LOCAL_ACTION_TEST_TOKEN" },
            },
          ],
        },
      })}\n`,
    );

    const actions = await startLocalActionRuntime({
      agentRoot: root,
      runtime,
      agentId: "fixture-agent",
      repositories: [
        {
          id: "application",
          mirror: "/local/application.git",
          defaultBranch: "main",
        },
      ],
    });
    assert.ok(actions);
    const mcp = spawn(actions.mcp.command[0]!, actions.mcp.command.slice(1), {
      env: actions.mcp.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const response = new Promise<Record<string, unknown>>((resolveResponse, reject) => {
        let output = "";
        mcp.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          const newline = output.indexOf("\n");
          if (newline < 0) return;
          try {
            resolveResponse(JSON.parse(output.slice(0, newline)) as Record<string, unknown>);
          } catch (error) {
            reject(error);
          }
        });
        mcp.once("error", reject);
        mcp.once("exit", (code) => {
          if (code !== null && code !== 0) reject(new Error(`MCP exited ${code}`));
        });
      });
      mcp.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "fixture_verify",
            arguments: { value: "works", repositoryId: "application" },
          },
        })}\n`,
      );
      const message = await response;
      const result = message.result as {
        structuredContent: {
          outcome: { status: string; output: unknown };
          secretVersions: unknown[];
        };
      };
      assert.deepEqual(result.structuredContent.outcome, {
        status: "succeeded",
        output: {
          value: "works",
          tokenPresent: true,
          mirror: "/local/application.git",
        },
      });
      assert.deepEqual(result.structuredContent.secretVersions, [
        {
          alias: "token",
          name: "LOCAL_ACTION_TEST_TOKEN",
          version: "local",
        },
      ]);
    } finally {
      mcp.kill("SIGTERM");
      await actions.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
