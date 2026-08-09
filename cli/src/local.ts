import {
  createOpencode,
  type OpencodeClient,
  type ToolPart,
} from "@opencode-ai/sdk/v2";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ResolvedConfig } from "./config.js";
import { findAgentRoot, prepareAgent, readManifest } from "./project.js";
import { formatSessionEvent, runSessionPrompt } from "./session-prompt.js";

interface DevState {
  version: 3;
  pid: number;
  url: string;
  token: string;
  agentRoot: string;
  agentId: string;
  startedAt: string;
}

interface LocalEvent {
  type: string;
  data: Record<string, unknown>;
}

interface LocalMessage {
  role: "user" | "assistant";
  text: string;
}

interface LocalSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: LocalMessage[];
}

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
  limit = 2 * 1024 * 1024,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limit) throw new Error("Request is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  return (
    typeof header === "string" &&
    header.startsWith("Bearer ") &&
    sameToken(header.slice(7), token)
  );
}

function sendJSON(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export async function startGateway(config: ResolvedConfig): Promise<{
  url: string;
  token: string;
  close(): Promise<void>;
}> {
  if (!config.apiKey) {
    throw new Error(
      "Not logged in. Run `opencomputer login` before starting dev mode.",
    );
  }
  const token = randomBytes(32).toString("base64url");
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const header = request.headers.authorization;
      if (
        !header?.startsWith("Bearer ") ||
        !sameToken(header.slice(7), token)
      ) {
        response.writeHead(401).end();
        return;
      }
      let target: string;
      let upstreamMethod = request.method;
      let upstreamBody: Buffer | string | undefined;
      if (
        request.method === "POST" &&
        (url.pathname === "/google/fetch" || url.pathname === "/github/fetch")
      ) {
        const provider = url.pathname.startsWith("/github/")
          ? "github"
          : "google";
        target = `${config.apiUrl}/api/managed-agents/connections/${provider}/fetch`;
        upstreamBody = await readBody(request);
      } else if (
        request.method === "POST" &&
        url.pathname === "/opencomputer/fetch"
      ) {
        const raw = await readBody(request);
        let input: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(raw.toString("utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("invalid payload");
          }
          input = parsed as Record<string, unknown>;
        } catch {
          sendJSON(response, 400, {
            error: { message: "Connection control payload must be valid JSON" },
          });
          return;
        }
        if (input.action === "list") {
          target = `${config.apiUrl}/api/managed-agents/connections`;
          upstreamMethod = "GET";
        } else if (input.action === "request") {
          const service = input.service;
          if (
            typeof service !== "string" ||
            !["gmail", "calendar", "drive", "sheets", "github"].includes(
              service,
            )
          ) {
            sendJSON(response, 400, {
              error: {
                message:
                  "Expected one of gmail, calendar, drive, sheets, or github",
              },
            });
            return;
          }
          const requestedLabel =
            typeof input.label === "string" && input.label.trim()
              ? input.label.trim()
              : undefined;
          const label =
            requestedLabel ??
            (input.newAccount === true
              ? `${service}-${randomUUID().slice(0, 8)}`
              : "default");
          target = `${config.apiUrl}/api/managed-agents/connections/link`;
          upstreamMethod = "POST";
          upstreamBody = JSON.stringify({ service, label });
        } else {
          sendJSON(response, 400, {
            error: {
              message: "Expected a list or request connection action",
            },
          });
          return;
        }
      } else if (url.pathname.startsWith("/openrouter/")) {
        target =
          `${config.apiUrl}/api/managed-agents/openrouter` +
          `${url.pathname.slice("/openrouter".length)}${url.search}`;
        upstreamBody =
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : await readBody(request);
      } else {
        response.writeHead(404).end();
        return;
      }
      const upstream = await fetch(target, {
        method: upstreamMethod,
        headers: {
          "content-type": request.headers["content-type"] ?? "application/json",
          "x-api-key": config.apiKey!,
        },
        body: upstreamBody,
        signal: AbortSignal.timeout(60_000),
      });
      response.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    })().catch((error: unknown) => {
      sendJSON(response, 502, {
        error: {
          message:
            error instanceof Error ? error.message : "Gateway request failed",
        },
      });
    });
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not start the local OpenComputer gateway");
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    token,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((done) => server.close(() => done()));
    },
  };
}

function addBundledRuntimeToPath(): void {
  const packagePath = fileURLToPath(
    import.meta.resolve("opencode-ai/package.json"),
  );
  const bin = resolve(dirname(packagePath), "..", ".bin");
  const current = process.env.PATH ?? "";
  if (!current.split(delimiter).includes(bin)) {
    process.env.PATH = current ? `${bin}${delimiter}${current}` : bin;
  }
}

function modelParts(): { providerID: string; modelID: string; full: string } {
  const full =
    process.env.OPENCOMPUTER_MODEL ?? "openrouter/anthropic/claude-sonnet-4.6";
  const separator = full.indexOf("/");
  return {
    providerID: separator === -1 ? "openrouter" : full.slice(0, separator),
    modelID: separator === -1 ? full : full.slice(separator + 1),
    full,
  };
}

async function streamTurn(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
  prompt: string,
  emit: (event: LocalEvent) => void,
): Promise<string> {
  const subscription = await client.event.subscribe({ directory });
  const textParts = new Map<string, string>();
  const reasoningParts = new Map<string, string>();
  const partTypes = new Map<string, "text" | "reasoning">();
  const pendingDeltas = new Map<
    string,
    Array<{ messageID: string; delta: string }>
  >();
  const tools = new Map<string, ToolPart>();
  const toolStates = new Map<string, ToolPart["state"]["status"]>();
  const assistantMessages = new Set<string>();
  const streamedTextParts = new Set<string>();

  const consumePendingDeltas = (partID?: string, messageID?: string): void => {
    for (const [candidatePartID, deltas] of pendingDeltas) {
      if (partID && candidatePartID !== partID) continue;
      const partType = partTypes.get(candidatePartID);
      if (!partType) continue;
      const remaining: typeof deltas = [];
      for (const pending of deltas) {
        if (
          (messageID && pending.messageID !== messageID) ||
          !assistantMessages.has(pending.messageID)
        ) {
          remaining.push(pending);
          continue;
        }
        const parts = partType === "text" ? textParts : reasoningParts;
        parts.set(
          candidatePartID,
          `${parts.get(candidatePartID) ?? ""}${pending.delta}`,
        );
        if (partType === "text" && !streamedTextParts.has(candidatePartID)) {
          if (streamedTextParts.size > 0) {
            emit({
              type: "message.delta",
              data: { text: "\n\n", partId: candidatePartID },
            });
          }
          streamedTextParts.add(candidatePartID);
        }
        emit({
          type: partType === "text" ? "message.delta" : "reasoning.delta",
          data: { text: pending.delta, partId: candidatePartID },
        });
      }
      if (remaining.length) pendingDeltas.set(candidatePartID, remaining);
      else pendingDeltas.delete(candidatePartID);
    }
  };
  const emitTool = (part: ToolPart): void => {
    if (!assistantMessages.has(part.messageID)) return;
    const previous = toolStates.get(part.callID);
    const current = part.state.status;
    if (previous === current) return;
    toolStates.set(part.callID, current);
    if (current === "running") {
      emit({
        type: "tool.started",
        data: {
          callId: part.callID,
          tool: part.tool,
          title: part.state.title,
          input: part.state.input,
        },
      });
    } else if (current === "completed") {
      emit({
        type: "tool.completed",
        data: { callId: part.callID, tool: part.tool, title: part.state.title },
      });
    } else if (current === "error") {
      emit({
        type: "tool.failed",
        data: {
          callId: part.callID,
          tool: part.tool,
          title: "title" in part.state ? part.state.title : undefined,
          message: part.state.error,
        },
      });
    }
  };

  try {
    const firstEvent = subscription.stream.next();
    await Promise.race([
      firstEvent.then(() => undefined),
      new Promise<void>((done) => setTimeout(done, 100)),
    ]);
    const model = modelParts();
    const started = await client.session.promptAsync({
      sessionID,
      directory,
      model: { providerID: model.providerID, modelID: model.modelID },
      // OpenComputer owns the multi-turn UI. The OpenCode question tool waits
      // for a separate client-side reply channel that our CLI and hosted
      // sessions do not expose, so agents must ask follow-up questions in the
      // conversation instead.
      tools: { question: false },
      parts: [{ type: "text", text: prompt }],
    });
    if (started.error) throw new Error(JSON.stringify(started.error));
    async function* events() {
      const first = await firstEvent;
      if (!first.done) yield first.value;
      yield* subscription.stream;
    }
    for await (const event of events()) {
      if (event.type === "message.part.delta") {
        const {
          sessionID: eventSessionID,
          messageID,
          partID,
          field,
          delta,
        } = event.properties;
        if (eventSessionID !== sessionID || field !== "text" || !delta)
          continue;
        const pending = pendingDeltas.get(partID) ?? [];
        pending.push({ messageID, delta });
        pendingDeltas.set(partID, pending);
        consumePendingDeltas(partID, messageID);
        continue;
      }
      if (event.type === "message.updated") {
        const info = event.properties.info;
        if (info.sessionID === sessionID && info.role === "assistant") {
          assistantMessages.add(info.id);
          consumePendingDeltas(undefined, info.id);
          for (const part of tools.values()) {
            if (part.messageID === info.id) emitTool(part);
          }
        }
      } else if (event.type === "message.part.updated") {
        const part = event.properties.part;
        if (part.sessionID !== sessionID) continue;
        if (part.type === "text") {
          partTypes.set(part.id, "text");
          if (
            assistantMessages.has(part.messageID) &&
            part.text.length >= (textParts.get(part.id)?.length ?? 0)
          ) {
            textParts.set(part.id, part.text);
          }
          consumePendingDeltas(part.id, part.messageID);
        } else if (part.type === "reasoning") {
          partTypes.set(part.id, "reasoning");
          if (
            assistantMessages.has(part.messageID) &&
            part.text.length >= (reasoningParts.get(part.id)?.length ?? 0)
          ) {
            reasoningParts.set(part.id, part.text);
          }
          consumePendingDeltas(part.id, part.messageID);
        } else if (part.type === "tool") {
          tools.set(part.callID, part);
          emitTool(part);
        }
      } else if (
        event.type === "session.error" &&
        event.properties.sessionID === sessionID
      ) {
        throw new Error(JSON.stringify(event.properties.error));
      } else if (
        (event.type === "session.idle" &&
          event.properties.sessionID === sessionID) ||
        (event.type === "session.status" &&
          event.properties.sessionID === sessionID &&
          event.properties.status.type === "idle")
      ) {
        break;
      }
    }
  } finally {
    await subscription.stream.return(undefined);
  }

  const reasoning = [...reasoningParts.values()].join("");
  if (reasoning) {
    emit({ type: "reasoning.completed", data: { text: reasoning } });
  }
  const text = [...textParts.values()]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
  emit({ type: "message.completed", data: { text } });
  return text;
}

async function createRuntimeSession(
  client: OpencodeClient,
  directory: string,
): Promise<string> {
  const created = await client.session.create({ directory });
  if (!created.data) throw new Error("The local agent session did not start");
  return created.data.id;
}

function statePath(root: string): string {
  return resolve(root, ".opencomputer", "dev.json");
}

async function readDevState(root: string): Promise<DevState | null> {
  try {
    const state = JSON.parse(
      await readFile(statePath(root), "utf8"),
    ) as DevState;
    if (state.version !== 3 || !state.url || !state.token) return null;
    const response = await fetch(`${state.url}/health`, {
      headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok ? state : null;
  } catch {
    return null;
  }
}

async function startDevService(config: ResolvedConfig): Promise<void> {
  const root = await findAgentRoot();
  if (!root) {
    throw new Error(
      "No OpenComputer agent repository found. Run `opencomputer init <directory>` first.",
    );
  }
  const existing = await readDevState(root);
  if (existing) {
    throw new Error(`OpenComputer dev is already running at ${existing.url}`);
  }
  const directory = await prepareAgent(root);
  const manifest = await readManifest(root);
  const gateway = await startGateway(config);
  addBundledRuntimeToPath();
  const abortController = new AbortController();
  const model = modelParts();
  const previousConnectionsURL = process.env.OPENCOMPUTER_CONNECTIONS_URL;
  const previousConnectionToken = process.env.OPENCOMPUTER_CONNECTION_TOKEN;
  process.env.OPENCOMPUTER_CONNECTIONS_URL = gateway.url;
  process.env.OPENCOMPUTER_CONNECTION_TOKEN = gateway.token;
  let instance: Awaited<ReturnType<typeof createOpencode>>;
  try {
    instance = await createOpencode({
      signal: abortController.signal,
      port: 0,
      timeout: 45_000,
      config: {
        model: model.full,
        enabled_providers: ["openrouter"],
        provider: {
          openrouter: {
            options: { baseURL: `${gateway.url}/openrouter/api/v1` },
          },
        },
        autoupdate: false,
        share: "disabled",
      },
    });
  } finally {
    if (previousConnectionsURL === undefined) {
      delete process.env.OPENCOMPUTER_CONNECTIONS_URL;
    } else {
      process.env.OPENCOMPUTER_CONNECTIONS_URL = previousConnectionsURL;
    }
    if (previousConnectionToken === undefined) {
      delete process.env.OPENCOMPUTER_CONNECTION_TOKEN;
    } else {
      process.env.OPENCOMPUTER_CONNECTION_TOKEN = previousConnectionToken;
    }
  }
  const authenticated = await instance.client.auth.set({
    providerID: "openrouter",
    auth: { type: "api", key: gateway.token },
  });
  if (authenticated.error || authenticated.data !== true) {
    throw new Error("The embedded agent runtime rejected its local credential");
  }

  const token = randomBytes(32).toString("base64url");
  const sessions = new Map<string, LocalSession>();
  const running = new Set<string>();
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") {
        sendJSON(response, 200, {
          service: "OpenComputer local agent",
          agent: { id: manifest.id, name: manifest.name },
          web: "Run npm run dev:web in another terminal",
        });
        return;
      }
      if (!authorized(request, token)) {
        sendJSON(response, 401, { message: "Unauthorized" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        sendJSON(response, 200, {
          ok: true,
          agentId: manifest.id,
          sessions: sessions.size,
        });
        return;
      }

      const streamSession = async (
        session: LocalSession,
        prompt: string,
        created = false,
      ): Promise<void> => {
        if (running.has(session.id)) {
          sendJSON(response, 409, {
            message: "This session is already running",
          });
          return;
        }
        running.add(session.id);
        session.messages.push({ role: "user", text: prompt });
        if (!session.title) session.title = prompt.slice(0, 60);
        session.updatedAt = new Date().toISOString();
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
        });
        const emit = (event: LocalEvent): void => {
          response.write(`${JSON.stringify(event)}\n`);
        };
        if (created) {
          emit({ type: "session.created", data: { sessionId: session.id } });
        }
        try {
          const text = await streamTurn(
            instance.client,
            directory,
            session.id,
            prompt,
            emit,
          );
          session.messages.push({ role: "assistant", text });
          session.updatedAt = new Date().toISOString();
        } catch (error) {
          emit({
            type: "session.failed",
            data: {
              message: error instanceof Error ? error.message : String(error),
            },
          });
        } finally {
          running.delete(session.id);
        }
        response.end();
      };

      if (request.method === "GET" && url.pathname === "/sessions") {
        sendJSON(response, 200, {
          sessions: [...sessions.values()]
            .sort((left, right) =>
              right.updatedAt.localeCompare(left.updatedAt),
            )
            .map(({ id, title, createdAt, updatedAt, messages }) => ({
              id,
              title,
              createdAt,
              updatedAt,
              messageCount: messages.length,
            })),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/sessions") {
        const raw = (await readBody(request)).toString("utf8");
        const body = (raw ? JSON.parse(raw) : {}) as { prompt?: unknown };
        const id = await createRuntimeSession(instance.client, directory);
        const now = new Date().toISOString();
        const session: LocalSession = {
          id,
          title: "",
          createdAt: now,
          updatedAt: now,
          messages: [],
        };
        sessions.set(id, session);
        if (typeof body.prompt === "string" && body.prompt.trim()) {
          response.setHeader("x-opencomputer-session-id", id);
          await streamSession(session, body.prompt.trim(), true);
        } else {
          sendJSON(response, 201, session);
        }
        return;
      }
      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
      if (sessionMatch?.[1]) {
        const id = decodeURIComponent(sessionMatch[1]);
        const session = sessions.get(id);
        if (!session) {
          sendJSON(response, 404, { message: "Session not found" });
          return;
        }
        if (request.method === "GET") {
          sendJSON(response, 200, session);
          return;
        }
        if (request.method === "POST") {
          const body = JSON.parse(
            (await readBody(request)).toString("utf8"),
          ) as {
            prompt?: unknown;
          };
          if (typeof body.prompt !== "string" || !body.prompt.trim()) {
            sendJSON(response, 400, { message: "A prompt is required" });
            return;
          }
          await streamSession(session, body.prompt.trim());
          return;
        }
      }
      if (request.method === "GET" && url.pathname === "/api") {
        sendJSON(response, 200, {
          service: "OpenComputer local agent",
          agentId: manifest.id,
          endpoints: ["GET /sessions", "POST /sessions", "POST /sessions/:id"],
        });
        return;
      }
      sendJSON(response, 404, { message: "Route not found" });
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        sendJSON(response, 500, {
          message: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.end();
      }
    });
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(
      Number(process.env.OPENCOMPUTER_DEV_PORT ?? 0),
      "127.0.0.1",
      done,
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The OpenComputer dev service did not receive a port");
  }
  const state: DevState = {
    version: 3,
    pid: process.pid,
    url: `http://127.0.0.1:${String(address.port)}`,
    token,
    agentRoot: root,
    agentId: manifest.id,
    startedAt: new Date().toISOString(),
  };
  await mkdir(dirname(statePath(root)), { recursive: true, mode: 0o700 });
  await writeFile(statePath(root), `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    `OpenComputer dev service ready\n` +
      `Agent: ${manifest.name} (${manifest.id})\n` +
      `Local API: ${state.url}\n` +
      `React app: npm run dev:web (in another terminal)\n` +
      `Session: opencomputer session\n`,
  );

  await new Promise<void>((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await rm(statePath(root), { force: true });
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  abortController.abort();
  instance.server.close();
  await gateway.close();
}

async function runLocalSession(
  prompt: string,
  state: DevState,
  sessionID?: string,
  onEvent?: (event: LocalEvent) => void,
): Promise<string> {
  const endpoint = sessionID
    ? `${state.url}/sessions/${encodeURIComponent(sessionID)}`
    : `${state.url}/sessions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${state.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `The local agent service returned ${String(response.status)}` +
        (detail ? `: ${detail}` : ""),
    );
  }
  let resolvedSessionID =
    sessionID ?? response.headers.get("x-opencomputer-session-id") ?? undefined;
  const decoder = new TextDecoder();
  let buffered = "";
  let streamedText = false;
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as LocalEvent;
      onEvent?.(event);
      if (event.type === "session.created") {
        resolvedSessionID = String(event.data.sessionId);
        if (!onEvent) process.stderr.write(`Session ${resolvedSessionID}\n`);
      } else if (event.type === "message.delta") {
        streamedText = true;
        if (!onEvent) process.stdout.write(String(event.data.text ?? ""));
      } else if (event.type === "message.completed") {
        if (!onEvent) {
          if (!streamedText)
            process.stdout.write(String(event.data.text ?? ""));
          process.stdout.write("\n");
        }
      } else if (event.type === "tool.started") {
        if (!onEvent) {
          process.stderr.write(
            `⚙ ${String(event.data.tool ?? "tool")} ${JSON.stringify(event.data.input ?? {})}\n`,
          );
        }
      } else if (event.type === "tool.completed") {
        if (!onEvent) {
          process.stderr.write(`✓ ${String(event.data.tool ?? "tool")}\n`);
        }
      } else if (event.type === "tool.failed") {
        if (!onEvent) {
          process.stderr.write(
            `✗ ${String(event.data.tool ?? "tool")}: ${String(event.data.message ?? "failed")}\n`,
          );
        }
      } else if (event.type === "session.failed") {
        throw new Error(String(event.data.message ?? "Local session failed"));
      }
    }
  }
  if (!resolvedSessionID)
    throw new Error("The local session did not return an ID");
  return resolvedSessionID;
}

async function stopOwnedDev(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((done) => child.once("exit", () => done())),
    new Promise<void>((done) => setTimeout(done, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function ensureDevService(
  config: ResolvedConfig,
): Promise<{ state: DevState; owned?: ChildProcess }> {
  const root = await findAgentRoot();
  if (!root) {
    throw new Error(
      "No OpenComputer agent repository found. Run `opencomputer init <directory>` first.",
    );
  }
  const existing = await readDevState(root);
  if (existing) return { state: existing };

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCOMPUTER_API_URL: config.apiUrl,
    OPENCOMPUTER_NO_OPEN: "1",
  };
  if (config.apiKey) environment.OPENCOMPUTER_API_KEY = config.apiKey;
  const child = spawn(process.execPath, [process.argv[1]!, "dev"], {
    cwd: root,
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    errors = `${errors}${chunk.toString("utf8")}`.slice(-8_000);
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await readDevState(root);
    if (state) return { state, owned: child };
    if (child.exitCode !== null) {
      throw new Error(errors.trim() || "The local development service exited");
    }
    await new Promise<void>((done) => setTimeout(done, 100));
  }
  await stopOwnedDev(child);
  throw new Error("Timed out starting the local development service");
}

async function runSessionShell(
  config: ResolvedConfig,
  verbose: boolean,
): Promise<void> {
  const target = await ensureDevService(config);
  try {
    const manifest = await readManifest(target.state.agentRoot);
    await runSessionPrompt({
      agentName: manifest.name,
      verbose,
      send: (prompt, sessionId, emit) =>
        runLocalSession(prompt, target.state, sessionId, emit),
    });
  } finally {
    await stopOwnedDev(target.owned);
  }
}

async function runOneShotSession(
  prompt: string,
  config: ResolvedConfig,
  verbose: boolean,
): Promise<void> {
  const target = await ensureDevService(config);
  try {
    let streamedText = false;
    await runLocalSession(prompt, target.state, undefined, (event) => {
      if (event.type === "message.delta") {
        streamedText = true;
        process.stdout.write(String(event.data.text ?? ""));
      } else if (event.type === "message.completed") {
        if (!streamedText) process.stdout.write(String(event.data.text ?? ""));
      } else if (verbose) {
        const formatted = formatSessionEvent(event);
        if (formatted) process.stderr.write(`${formatted}\n`);
      }
    });
    process.stdout.write("\n");
  } finally {
    await stopOwnedDev(target.owned);
  }
}

export async function runLocalAgent(
  args: string[],
  config: ResolvedConfig,
  options: { verbose?: boolean } = {},
): Promise<void> {
  if (args[0] === "dev") {
    if (args.length > 1)
      throw new Error(`Unexpected local argument: ${args[1]}`);
    await startDevService(config);
    return;
  }
  if (args[0] === "run") {
    const prompt = args.slice(1).join(" ").trim();
    if (!prompt) throw new Error("A prompt is required");
    await runOneShotSession(prompt, config, options.verbose === true);
    return;
  }
  if (args[0] === "shell") {
    if (args.length > 1)
      throw new Error(`Unexpected local argument: ${args[1]}`);
    await runSessionShell(config, options.verbose === true);
    return;
  }
  throw new Error(`Unexpected local argument: ${args[0] ?? "none"}`);
}
