import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

import type { ResolvedConfig } from "./config.js";
import { findAgentRoot, prepareAgent } from "./project.js";

function sameToken(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

async function readBody(
  request: AsyncIterable<Uint8Array>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 2 * 1024 * 1024) {
      throw new Error("Connection request is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function startConnectionProxy(config: ResolvedConfig): Promise<{
  url: string;
  token: string;
  close(): Promise<void>;
}> {
  if (!config.apiKey) {
    throw new Error(
      "Not logged in. Run `opencomputer login` before testing connected tools.",
    );
  }
  const token = randomBytes(32).toString("base64url");
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/google/fetch") {
        response.writeHead(404).end();
        return;
      }
      const authorization = request.headers.authorization;
      if (
        !authorization?.startsWith("Bearer ") ||
        !sameToken(authorization.slice(7), token)
      ) {
        response.writeHead(401).end();
        return;
      }
      const upstream = await fetch(
        `${config.apiUrl}/api/managed-agents/connections/google/fetch`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": config.apiKey!,
          },
          body: await readBody(request),
          signal: AbortSignal.timeout(30_000),
        },
      );
      response.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    })().catch((error: unknown) => {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message:
              error instanceof Error
                ? error.message
                : "Connection proxy failed",
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not start the local connection proxy");
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    token,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function runOpenCode(
  args: string[],
  config: ResolvedConfig,
): Promise<void> {
  const root = await findAgentRoot();
  if (!root) {
    throw new Error(
      "No OpenComputer agent repository found. Run `opencomputer init <template>` first.",
    );
  }
  const runtime = await prepareAgent(root);
  const connections = await startConnectionProxy(config);
  const localExecutable = resolve(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "opencode.cmd" : "opencode",
  );
  const executable = await access(localExecutable)
    .then(() => localExecutable)
    .catch(() =>
      process.platform === "win32" ? "opencode.cmd" : "opencode",
    );
  const openCodeArgs =
    args[0] === "run"
      ? [...args, "--dir", runtime]
      : args.length === 0
        ? [runtime]
        : args;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        executable,
        openCodeArgs,
        {
          cwd: runtime,
          env: {
            ...process.env,
            OPENCOMPUTER_CONNECTIONS_URL: connections.url,
            OPENCOMPUTER_CONNECTION_TOKEN: connections.token,
            OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX:
              process.env.OPENCOMPUTER_MAX_OUTPUT_TOKENS ??
              process.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX ??
              "16384",
          },
          stdio: "inherit",
        },
      );
      child.once("error", (error) => {
        reject(
          error instanceof Error && "code" in error && error.code === "ENOENT"
            ? new Error("OpenCode is not installed. Run `npm install` first.")
            : error,
        );
      });
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else {
          reject(
            new Error(
              `OpenCode exited ${signal ? `with ${signal}` : `with code ${String(code)}`}`,
            ),
          );
        }
      });
    });
  } finally {
    await connections.close();
  }
}
