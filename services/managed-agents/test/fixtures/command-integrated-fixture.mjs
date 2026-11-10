// Shared by the integrated command test (runs in workerd) and its vitest
// project configuration (runs in Node): the deployed agent's artifact, the
// scripted model that calls the command tools, and the fake computer behind
// the SANDBOX binding. Plain JavaScript with only web platform APIs, so the
// same module loads in both.

const encode = (value) => btoa(unescape(encodeURIComponent(value)));

/**
 * The deployed agent: no memory, both command tools enabled. `shell` is
 * OpenCode's built-in tool id, routed to the computer on this runtime;
 * `sandbox_exec` is the runtime's own.
 */
export const artifactBundle = new TextEncoder().encode(
  JSON.stringify({
    version: 1,
    files: [
      {
        path: "agent.js",
        content: encode(`
          import { useModel, useTool } from "./opencomputer-agent.js";
          export default function agent() {
            useModel("anthropic/claude-sonnet-5");
            useTool("shell");
            useTool("sandbox_exec");
            return "You have a computer. Run commands when asked.";
          }
        `),
      },
      {
        path: "opencomputer-agent.js",
        content: encode(`
          const hooks = () => globalThis[Symbol.for("opencomputer.agent-hooks")];
          export const useModel = (model) => hooks().useModel(model);
          export const useTool = (tool) => hooks().useTool(tool);
        `),
      },
      {
        path: ".opencomputer/reactive.json",
        content: encode(
          JSON.stringify({
            version: 2,
            entry: "../agent.js",
            tools: ["shell", "sandbox_exec"],
            connections: [],
            mcpServers: [],
            models: [{ provider: "openrouter", model: "anthropic/claude-sonnet-5" }],
          }),
        ),
      },
    ],
  }),
);

export async function artifactDigest() {
  const digest = await crypto.subtle.digest("SHA-256", artifactBundle);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

const text = (parts) =>
  typeof parts === "string"
    ? parts
    : Array.isArray(parts)
      ? parts.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("")
      : "";

let toolCalls = 0;

/**
 * The scripted model behind the OpenAI-compatible chat completions route.
 * A prompt `run:<json>` calls the tool named in the json (`tool`, default
 * `sandbox_exec`) with the remaining fields as its input, then answers with
 * `Result: <tool output>`; anything else is answered directly. Every other
 * outbound request is refused: the test must not reach the network.
 */
export async function mockModel(request) {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/models/resolve")) {
    const input = JSON.parse(await request.text());
    return Response.json({ model: input.model });
  }
  if (!url.pathname.endsWith("/chat/completions")) {
    return Response.json({ error: `unexpected outbound request to ${url.origin}${url.pathname}` }, { status: 404 });
  }
  const body = JSON.parse(await request.text());
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const chunk = (delta, finishReason = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-command-integrated",
      object: "chat.completion.chunk",
      created: 1,
      model: "mock-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  const sse = (frames) =>
    new Response(frames + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  const reply = (content) => sse(chunk({ role: "assistant", content: "" }) + chunk({ content }) + chunk({}, "stop"));
  const callTool = (name, args, providerCallId) => {
    toolCalls += 1;
    return sse(
      chunk({ role: "assistant", content: "" }) +
        chunk({
          tool_calls: [
            {
              index: 0,
              id: providerCallId ?? `call-command-${String(toolCalls)}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        }) +
        chunk({}, "tool_calls"),
    );
  };

  const lastUser = messages.findLastIndex((entry) => entry.role === "user");
  const prompt = text(messages[lastUser]?.content);
  const toolResults = messages.slice(lastUser + 1).filter((entry) => entry.role === "tool");
  const wanted = /^run:(.*)$/s.exec(prompt)?.[1]?.trim();
  if (wanted === undefined) return reply("No command run.");
  if (toolResults.length === 0) {
    const { tool = "sandbox_exec", _providerCallId, ...input } = JSON.parse(wanted);
    return callTool(tool, input, _providerCallId);
  }
  return reply(`Result: ${text(toolResults[toolResults.length - 1].content)}`);
}

// The fake computer. One process, so its state outlives every Durable
// Object eviction; commands are interpreted, not run: `sleep N` takes N
// fake seconds and times out when N exceeds the timeout, `hang` never
// reports, anything else completes at once with its text as stdout.
//
// The log spans the whole test file, and a session of an earlier test
// keeps working after that test returned (its idle alarm terminates the
// computer it left behind), so every entry records the session it belongs
// to and a test reads the log scoped to its own session.

const sandboxes = new Map();
const operations = new Map();
const log = { ensures: [], executes: [], statuses: [], cancels: [], terminates: [], probes: [] };
// `isolation` is what the fake supervisor reports for a terminated unit:
// `cgroup` with verified containment, or `process_session` without it.
// `forgetOperations` makes every cancel answer as a supervisor that never
// heard of the operation (a restart between the start and the cancel).
// `holdCancels` holds the next N cancel requests (the supervisor answering
// late) until `cancelsReleased` is set, so a host handler can be paused
// mid-settlement while the caller times out and retries. `malformedStatuses`
// makes the next N status replies HTTP 200 with a body that is not JSON (a
// proxy or supervisor answering with a truncated document). `honorStatusWait`
// makes status requests hold like the real supervisor's long poll — until
// new progress or a terminal status, or `statusWaitCapMs` at most, short
// here so tests do not wait out the real hold; false answers at once like a
// supervisor image from before the long poll. `supervisor`
// is the image a computer launched from now runs: `current`, or `f19dcad`,
// the supervisor from before the command contract, whose replies are
// reproduced below from `git show f19dcad:src/microvm/supervisor.ts`. A
// computer keeps the supervisor it launched with; promoting the image
// changes only what later launches get.
let control = {
  lifetimeMs: 3_600_000,
  failTerminate: 0,
  failEnsures: 0,
  probeAlive: true,
  cancelUnreachable: false,
  isolation: "cgroup",
  forgetOperations: false,
  holdCancels: 0,
  cancelsReleased: false,
  malformedStatuses: 0,
  honorStatusWait: true,
  statusWaitCapMs: 250,
  supervisor: "current",
};

/**
 * The pre-contract supervisor's replies, verbatim in shape. `/tool-exec`
 * answered 202 `{ operationId, status }`; `/tool-exec/status` answered
 * `{ operationId, status, progress, result?, error? }` with no boot id;
 * a command it killed at its fixed two-minute cutoff resolved as
 * `completed` with `result.timedOut: true` (executeToolCommand resolved on
 * exit, whatever ended the child) and no `terminated`, `isolation` or
 * `contained`; there was no `/tool-exec/cancel` route, so a cancel fell
 * through to `404 { message: "Hook not found" }`; `/health` reported
 * `{ status, runtime, opencode, sessionId, toolSandbox }` with no
 * generation and no boot id.
 */
const f19dcad = {
  start: (toolCallID, operation) => Response.json({ operationId: toolCallID, status: operation.status }, { status: 202 }),
  status: (toolCallID, operation, after) =>
    Response.json({
      operationId: toolCallID,
      status: operation.status,
      progress: operation.progress.filter((entry) => entry.seq > after),
      ...(operation.result ? { result: operation.result } : {}),
      ...(operation.error ? { error: operation.error } : {}),
    }),
  cancel: () => Response.json({ message: "Hook not found" }, { status: 404 }),
  health: (sessionID) => ({ status: "ok", runtime: "running", opencode: "running", sessionId: sessionID, toolSandbox: "ready" }),
  timedOutResult: (command, timeoutSeconds) => ({
    stdout: "partial output before the cutoff\n",
    stderr: "",
    exitCode: null,
    signal: "SIGKILL",
    timedOut: true,
    truncated: false,
  }),
};
let launched = 0;
const bootId = "supervisor-boot-fake";

function operationKey(input) {
  return `${input.sessionID}:${String(input.generation)}:${input.toolCallID}`;
}

function settleCommand(operation, command, timeoutSeconds, supervisor) {
  const sleep = /^sleep (\d+)$/.exec(command);
  if (/\bhang\b/.test(command)) return;
  const durationSeconds = sleep ? Number(sleep[1]) : 0;
  setTimeout(() => {
    if (operation.status !== "running") return;
    if (durationSeconds > timeoutSeconds && supervisor === "f19dcad") {
      operation.status = "completed";
      operation.result = f19dcad.timedOutResult(command, timeoutSeconds);
    } else if (durationSeconds > timeoutSeconds) {
      // The unit was terminated at the cutoff under the configured
      // isolation; containment is verified only under a cgroup.
      operation.status = "failed";
      operation.error = `timed out after ${String(timeoutSeconds)} seconds; the command's process unit was terminated (${control.isolation})`;
      operation.result = {
        stdout: "partial output before the cutoff\n",
        stderr: "",
        exitCode: null,
        signal: "SIGKILL",
        timedOut: true,
        terminated: true,
        truncated: false,
        durationMs: timeoutSeconds * 1000,
        isolation: control.isolation,
        contained: control.isolation === "cgroup",
        orphansTerminated: control.isolation === "cgroup" ? 0 : -1,
      };
    } else {
      operation.status = "completed";
      operation.result = {
        stdout: sleep ? "" : `${command}\n`,
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        terminated: false,
        truncated: false,
        durationMs: durationSeconds * 1000,
        isolation: "cgroup",
        orphansTerminated: 0,
      };
    }
    operation.progress.push({ seq: operation.progress.length + 1, timestamp: new Date().toISOString(), data: { stage: operation.status } });
  }, 50);
}

function reply(operation, toolCallID, after) {
  return Response.json({
    operationId: toolCallID,
    status: operation.status,
    bootId,
    ...(after === undefined ? {} : { progress: operation.progress.filter((entry) => entry.seq > after) }),
    ...(operation.result ? { result: operation.result } : {}),
    ...(operation.error ? { error: operation.error } : {}),
  });
}

export async function fakeSandbox(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/v1/sandboxes/inspect") {
    return Response.json({
      ...log,
      sandboxes: [...sandboxes.values()],
      operations: [...operations.entries()].map(([key, operation]) => ({ key, status: operation.status })),
    });
  }
  if (path === "/v1/sandboxes/test-control") {
    control = { ...control, ...(await request.json()) };
    return Response.json(control);
  }
  const input = await request.json();
  if (path === "/v1/sandboxes/ensure") {
    launched += 1;
    if (control.failEnsures > 0) {
      // The platform answering 5xx on a launch — the transient provisioning
      // failure a first ensure can hit. The host must retry, not poison the
      // session.
      control.failEnsures -= 1;
      log.ensures.push({ sessionID: input.sessionID, generation: input.generation, sandboxId: `sb-${String(launched)}` });
      return Response.json({ message: "injected ensure failure" }, { status: 500 });
    }
    const sandbox = {
      sandboxId: `sb-${String(launched)}`,
      sessionID: input.sessionID,
      generation: input.generation,
      state: "running",
      expiresAtMs: Date.now() + control.lifetimeMs,
      supervisor: control.supervisor,
    };
    sandboxes.set(sandbox.sandboxId, sandbox);
    log.ensures.push({ sessionID: input.sessionID, generation: input.generation, sandboxId: sandbox.sandboxId });
    return Response.json(
      { sandboxId: sandbox.sandboxId, accessPointId: "ap-fake", maximumDurationSeconds: control.lifetimeMs / 1000, expiresAtMs: sandbox.expiresAtMs },
      { status: 201 },
    );
  }
  const sandbox = sandboxes.get(input.sandboxId);
  if (path === "/v1/sandboxes/terminate") {
    log.terminates.push({ sessionID: input.sessionID, sandboxId: input.sandboxId ?? null, generation: input.generation, preserve: input.preserve === true });
    if (control.failTerminate > 0) {
      control.failTerminate -= 1;
      return Response.json({ message: "injected termination failure" }, { status: 500 });
    }
    if (sandbox) {
      sandbox.state = "terminated";
      for (const [key, operation] of operations) {
        if (key.startsWith(`${input.sessionID}:${String(input.generation)}:`) && operation.status === "running") {
          operation.status = "cancelled";
          operation.error = "computer terminated";
        }
      }
    }
    return Response.json({ sandboxId: input.sandboxId ?? null, generation: input.generation, state: sandbox ? "terminated" : "not_found" });
  }
  if (path === "/v1/sandboxes/probe") {
    log.probes.push({ sessionID: input.sessionID, sandboxId: input.sandboxId, generation: input.generation });
    if (control.probeAlive && sandbox?.state === "running" && sandbox.supervisor === "f19dcad") {
      // What the platform answers for the recorded pre-contract health
      // reply (sandbox-adapter.test.ts pins the rule on the same body).
      const health = f19dcad.health(input.sessionID);
      return Response.json({
        alive: false,
        sandboxId: input.sandboxId,
        generation: input.generation,
        reason: `supervisor does not report its generation (health: ${JSON.stringify(Object.keys(health))})`,
        supervisor: "unverifiable",
      });
    }
    const alive = control.probeAlive && sandbox?.state === "running" && sandbox.generation === input.generation;
    return Response.json({ alive, sandboxId: input.sandboxId, generation: input.generation, ...(alive ? { bootId } : { reason: "unreachable" }) });
  }
  if (!sandbox || sandbox.state !== "running") {
    return Response.json({ message: "The sandbox MicroVM is unavailable" }, { status: 503 });
  }
  const key = operationKey(input);
  if (path === "/v1/sandboxes/execute") {
    log.executes.push({
      sessionID: input.sessionID,
      sandboxId: input.sandboxId,
      generation: input.generation,
      toolCallID: input.toolCallID,
      capability: input.capability,
      request: input.request,
    });
    let operation = operations.get(key);
    if (!operation) {
      if (
        input.capability !== "exec" ||
        !Number.isInteger(input.request.timeoutSeconds) ||
        input.request.timeoutSeconds < 1 ||
        input.request.timeoutSeconds > 1800
      ) {
        return Response.json({ message: "Invalid tool execution request" }, { status: 400 });
      }
      operation = { status: "running", progress: [{ seq: 1, timestamp: new Date().toISOString(), data: { stage: "started" } }] };
      operations.set(key, operation);
      settleCommand(operation, input.request.command, input.request.timeoutSeconds, sandbox.supervisor);
    }
    if (sandbox.supervisor === "f19dcad") return f19dcad.start(input.toolCallID, operation);
    return reply(operation, input.toolCallID, 0);
  }
  if (path === "/v1/sandboxes/execute/status") {
    log.statuses.push({ sessionID: input.sessionID, sandboxId: input.sandboxId, generation: input.generation, toolCallID: input.toolCallID, after: input.after, waitMs: input.waitMs });
    const operation = operations.get(key);
    if (!operation) return Response.json({ message: "Tool operation was not found", bootId }, { status: 404 });
    if (control.malformedStatuses > 0) {
      control.malformedStatuses -= 1;
      return new Response(`{"operationId":${JSON.stringify(input.toolCallID)},"status":"running","progress":[`, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (sandbox.supervisor === "f19dcad") return f19dcad.status(input.toolCallID, operation, input.after);
    if (
      control.honorStatusWait &&
      Number.isInteger(input.waitMs) &&
      input.waitMs > 0 &&
      operation.status === "running" &&
      !operation.progress.some((entry) => entry.seq > input.after)
    ) {
      // The long poll: hold until the operation reports something new
      // past the requested seq, or the capped wait expires.
      const deadline = Date.now() + Math.min(input.waitMs, control.statusWaitCapMs);
      while (
        Date.now() < deadline &&
        operation.status === "running" &&
        !operation.progress.some((entry) => entry.seq > input.after)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return reply(operation, input.toolCallID, input.after);
  }
  if (path === "/v1/sandboxes/execute/cancel") {
    log.cancels.push({ sessionID: input.sessionID, sandboxId: input.sandboxId, generation: input.generation, toolCallID: input.toolCallID, reason: input.reason });
    if (sandbox.supervisor === "f19dcad") return f19dcad.cancel();
    if (control.holdCancels > 0) {
      control.holdCancels -= 1;
      const deadline = Date.now() + 30_000;
      while (!control.cancelsReleased && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (control.cancelUnreachable) {
      // The supervisor does not answer: a lost supervisor with the command
      // still running.
      return Response.json({ message: "The sandbox MicroVM is unavailable" }, { status: 503 });
    }
    let operation = control.forgetOperations ? undefined : operations.get(key);
    let found = true;
    if (!operation) {
      found = false;
      operation = { status: "cancelled", progress: [], error: `cancelled before it started (${input.reason})` };
      if (!control.forgetOperations) operations.set(key, operation);
    } else if (operation.status === "running") {
      operation.status = "cancelled";
      operation.error = `cancelled (${input.reason}); the command's process unit was terminated (${control.isolation})`;
      operation.result = {
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: "SIGKILL",
        timedOut: false,
        terminated: true,
        terminationReason: input.reason,
        truncated: false,
        durationMs: 10,
        isolation: control.isolation,
        contained: control.isolation === "cgroup",
        orphansTerminated: control.isolation === "cgroup" ? 0 : -1,
      };
    }
    const body = await reply(operation, input.toolCallID).json();
    return Response.json({ ...body, found, cancellable: true, contained: operation.result?.contained === true });
  }
  return Response.json({ message: "Route not found" }, { status: 404 });
}
