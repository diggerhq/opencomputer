import { Miniflare } from "miniflare";

/**
 * M1 as far as it goes without the real Memory Durable Object: the bundled
 * runtime (dist/index.js, from `npm run bundle`) runs the real OpenCode loop
 * in Miniflare against a deterministic mocked model; the MEMORY namespace is
 * bound the way production binds it, to another worker's class, except the
 * class is smoke-memory-do.mjs. Proven here: a save from a model step uses
 * the revision recalled for that step and returns the SaveResult verbatim
 * as the tool result; an owner edit during inference conflicts the save
 * and the next step reconciles; the saved event rides the turn stream; a
 * render that does not select memory exposes no memory tools; memory
 * operations start no sandbox. Left for the real object: grants and session
 * closure, freeze, limits, a second session reading the first's save.
 */

const objectName = "account-smoke:project-smoke:development";
const managedSessionId = "managed-session-smoke";
const encode = (value) => Buffer.from(value).toString("base64");

const artifactBundle = new TextEncoder().encode(
  JSON.stringify({
    version: 1,
    files: [
      {
        path: "agent.js",
        content: encode(`
          import { useInput, useMemory } from "./opencomputer-agent.js";
          export default function agent() {
            const input = useInput();
            if (/nomemory/.test(input.text || "")) return "No memory for this request.";
            const notes = useMemory("notes");
            return "Saved notes (JSON string): " + JSON.stringify(notes.text) +
              (notes.writable ? " Use memory_save to keep what the user asks you to remember." : " Notes are read-only.");
          }
        `),
      },
      {
        path: "opencomputer-agent.js",
        content: encode(`
          const hooks = () => globalThis[Symbol.for("opencomputer.agent-hooks")];
          export const useInput = () => hooks().useInput();
          export const useMemory = (memory) => {
            const memoryId = typeof memory === "string" ? memory : memory && memory.id;
            const projection = hooks().useMemory(memoryId);
            if (!projection || typeof projection !== "object" || typeof projection.text !== "string" ||
                !Array.isArray(projection.sources) || typeof projection.writable !== "boolean") {
              throw new Error("Memory " + JSON.stringify(memoryId) + " is not bound to this session; create the session with a memory binding for it");
            }
            return projection;
          };
        `),
      },
      {
        path: ".opencomputer/reactive.json",
        content: encode(
          JSON.stringify({
            version: 2,
            entry: "../agent.js",
            tools: [],
            connections: [],
            mcpServers: [],
            memory: [
              {
                id: "notes",
                description: "Verified requirements and decisions for a workshop, kept for later work.",
                provider: { kind: "document", maxBytes: 8192 },
              },
            ],
          }),
        ),
      },
    ],
  }),
);
const artifactDigest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", artifactBundle))]
  .map((value) => value.toString(16).padStart(2, "0"))
  .join("");
const deployment = {
  id: `memory-smoke:${artifactDigest}`,
  agentId: "memory-smoke",
  alias: "development",
  runtimeMode: "workerd-lazy-sandbox",
  channels: [],
  connections: [],
  httpConnections: [],
  artifact: {
    bucket: "test-artifacts",
    key: artifactDigest,
    digest: artifactDigest,
    size: artifactBundle.byteLength,
  },
  imageArn: "test-image",
  imageVersion: "test",
  createdAt: new Date(0).toISOString(),
};

let sandboxCalls = 0;
let toolCalls = 0;
/**
 * Every model request the mocked provider received: the rendered system
 * text and the tools by name. OpenCode also asks the model for a session
 * title, without context hooks; `rendered` picks out the agent's requests.
 */
const modelRequests = [];
const rendered = (marker) => modelRequests.filter((request) => request.system.includes(marker));
/** When set, runs once inside the next save-producing model request: the owner editing during inference. */
let duringInference = null;

const text = (parts) =>
  typeof parts === "string"
    ? parts
    : Array.isArray(parts)
      ? parts.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("")
      : "";

const mockModel = async (request) => {
  const body = JSON.parse(await request.text());
  const messages = Array.isArray(body.messages) ? body.messages : [];
  modelRequests.push({
    system: messages.filter((entry) => entry.role === "system").map((entry) => text(entry.content)).join("\n"),
    tools: Object.fromEntries(
      (body.tools ?? []).map((tool) => [tool.function?.name ?? tool.name, tool.function?.description ?? tool.description]),
    ),
  });
  const chunk = (delta, finishReason = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-memory-smoke",
      object: "chat.completion.chunk",
      created: 1,
      model: "smoke-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  const reply = (content) =>
    new Response(
      chunk({ role: "assistant", content: "" }) + chunk({ content }) + chunk({}, "stop") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  const callTool = (name, args) => {
    toolCalls += 1;
    return new Response(
      chunk({ role: "assistant", content: "" }) +
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `call-memory-smoke-${String(toolCalls)}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        }) +
        chunk({}, "tool_calls") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  };

  const lastUser = messages.findLastIndex((entry) => entry.role === "user");
  const prompt = text(messages[lastUser]?.content);
  const toolResults = messages.slice(lastUser + 1).filter((entry) => entry.role === "tool");
  if (/^stall:/.test(prompt)) {
    // A slow model: the turn is live on the host until it answers or is
    // interrupted.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return reply("Stalled reply.");
  }
  const wanted = /^save:(.*)$/s.exec(prompt)?.[1]?.trim();
  if (wanted === undefined) return reply("No memory used.");
  if (toolResults.length === 0) {
    if (duringInference) {
      const edit = duringInference;
      duringInference = null;
      await edit();
    }
    return callTool("memory_save", { text: wanted, summary: "Workshop requirements." });
  }
  const last = text(toolResults[toolResults.length - 1].content);
  const conflict = /"status":"conflict"/.test(last) ? JSON.parse(last.slice(last.indexOf("{"), last.lastIndexOf("}") + 1)) : null;
  if (toolResults.length === 1 && conflict) {
    return callTool("memory_save", { text: `${conflict.text}\n${wanted}` });
  }
  return reply(`Done: ${last}`);
};

const here = new URL(".", import.meta.url).pathname;
const miniflare = new Miniflare({
  workers: [
    {
      name: "runtime",
      compatibilityDate: "2026-07-24",
      compatibilityFlags: ["nodejs_compat"],
      modules: true,
      scriptPath: `${here}dist/index.js`,
      durableObjects: {
        OPENCODE_SESSIONS: { className: "OpenCodeSessionDurableObject", useSQLite: true },
        MEMORY: { className: "FakeMemoryDurableObject", scriptName: "memory", useSQLite: true },
      },
      bindings: { OPENROUTER_API_KEY: "local-smoke-test-only", SANDBOX_IDLE_GRACE_MS: "200" },
      workerLoaders: { AGENT_LOADER: {} },
      serviceBindings: {
        ARTIFACTS: async () => new Response(artifactBundle),
        SANDBOX: async () => {
          sandboxCalls += 1;
          return Response.json({ error: "memory operations must not reach the sandbox" }, { status: 500 });
        },
      },
      outboundService: mockModel,
    },
    {
      name: "memory",
      compatibilityDate: "2026-07-24",
      modules: true,
      scriptPath: `${here}smoke-memory-do.mjs`,
      durableObjects: {
        MEMORY: { className: "FakeMemoryDurableObject", useSQLite: true },
      },
    },
  ],
});

const fail = (message) => {
  throw new Error(message);
};

/** Parses a turn's SSE body into events. */
const events = (body) =>
  body
    .split("\n\n")
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data: ")))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(6)));

/** True when any string inside the value contains `needle`. */
const mentions = (value, needle) =>
  typeof value === "string"
    ? value.includes(needle)
    : value && typeof value === "object"
      ? Object.values(value).some((entry) => mentions(entry, needle))
      : false;

try {
  const memory = await miniflare.getWorker("memory");
  const owner = async (method, body, query = "") => {
    const response = await memory.fetch(
      `http://memory.local/documents?object=${encodeURIComponent(objectName)}${query}`,
      {
        method,
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    if (!response.ok) fail(`Owner ${method} failed (${response.status}): ${await response.text()}`);
    return response.json();
  };
  const document = () => owner("GET", undefined, "&resource=notes&id=workshop");
  const calls = async () =>
    (await memory.fetch(`http://memory.local/calls?object=${encodeURIComponent(objectName)}`)).json();

  const seeded = await owner("POST", {
    resource: "notes",
    id: "workshop",
    title: "Workshop requirements",
    text: "",
  });

  const created = await miniflare.dispatchFetch("http://runtime.local/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deployment,
      memory: {
        objectName,
        sessionId: managedSessionId,
        bindings: [{ resource: "notes", scope: "document", id: "workshop", access: "read-write" }],
      },
    }),
  });
  if (created.status !== 201) fail(`Session creation failed (${created.status}): ${await created.text()}`);
  const session = await created.json();
  const runtimeSession = created.headers.get("x-opencomputer-session");
  const turn = async (prompt) => {
    const response = await miniflare.dispatchFetch(
      `http://runtime.local/sessions/${runtimeSession}/turn`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionID: session.id, text: prompt }),
      },
    );
    if (!response.ok) fail(`Turn failed (${response.status}): ${await response.text()}`);
    const parsed = events(await response.text());
    if (!parsed.some((event) => event.type === "session.execution.succeeded")) {
      fail(`Turn did not complete: ${JSON.stringify(parsed.map((event) => event.type))}`);
    }
    return parsed;
  };

  // Step one: the model saves; the save uses the revision recalled for this step.
  const first = await turn("save:Exercises must run on Node.js 22 and need no paid services.");
  const firstSaved = first.filter((event) => event.type === "opencomputer.memory.saved");
  if (firstSaved.length !== 1) fail(`Expected one saved event, got ${JSON.stringify(firstSaved)}`);
  if (!first.some((event) => event.type !== "opencomputer.memory.saved" && mentions(event, '"status":"saved"'))) {
    fail("The tool result did not carry the SaveResult");
  }
  let stored = await document();
  if (stored.text !== "Exercises must run on Node.js 22 and need no paid services.") {
    fail(`Unexpected stored text after step one: ${JSON.stringify(stored)}`);
  }
  if (stored.summary !== "Workshop requirements." || stored.writer?.sessionId !== managedSessionId) {
    fail(`Unexpected document metadata after step one: ${JSON.stringify(stored)}`);
  }
  const firstEvent = firstSaved[0].data;
  if (
    firstEvent.resource !== "notes" ||
    firstEvent.documentId !== "workshop" ||
    firstEvent.revision !== stored.revision ||
    typeof firstEvent.bytes !== "number"
  ) {
    fail(`Unexpected saved event: ${JSON.stringify(firstEvent)}`);
  }
  let memoryCalls = await calls();
  const firstSave = memoryCalls.find((call) => call.op === "save");
  if (!firstSave || firstSave.expectedRevision !== seeded.revision || firstSave.sessionId !== managedSessionId) {
    fail(`The first save did not use the recalled revision: ${JSON.stringify(firstSave)}`);
  }
  const firstTools = rendered("Saved notes (JSON string)")[0]?.tools ?? fail("No rendered model request");
  if (!("memory_save" in firstTools) || "memory_read" in firstTools || "memory_list" in firstTools || "sandbox_exec" in firstTools) {
    fail(`Unexpected tools on the first request: ${JSON.stringify(Object.keys(firstTools))}`);
  }
  if (
    !firstTools.memory_save.includes("Verified requirements and decisions for a workshop") ||
    !firstTools.memory_save.includes('may be omitted; it defaults to "notes"')
  ) {
    fail(`Unexpected memory_save description: ${firstTools.memory_save}`);
  }

  // Step two: the owner edits during inference; the save conflicts with the
  // current text in the result and the next step reconciles against the
  // fresh revision.
  duringInference = () => owner("PUT", { resource: "notes", id: "workshop", text: "Budget approved by the owner." });
  const second = await turn("save:Speakers confirmed for both days.");
  const conflictResult = second.find(
    (event) => event.type !== "opencomputer.memory.saved" && mentions(event, '"status":"conflict"'),
  );
  if (!conflictResult || !mentions(conflictResult, "Budget approved by the owner.")) {
    fail("The conflicting save did not return the owner's current text");
  }
  const secondSaved = second.filter((event) => event.type === "opencomputer.memory.saved");
  if (secondSaved.length !== 1) fail(`Expected one saved event in step two, got ${String(secondSaved.length)}`);
  if (second.filter((event) => event.type === "opencomputer.agent.rendered").length !== 3) {
    fail("Step two should render three times: the conflicting request, the reconciling one and the answer");
  }
  stored = await document();
  if (stored.text !== "Budget approved by the owner.\nSpeakers confirmed for both days.") {
    fail(`Reconciliation did not land: ${JSON.stringify(stored)}`);
  }
  memoryCalls = await calls();
  const saves = memoryCalls.filter((call) => call.op === "save");
  if (
    saves.length !== 3 ||
    saves[1].result.status !== "conflict" ||
    saves[2].result.status !== "saved" ||
    saves[1].expectedRevision === saves[2].expectedRevision
  ) {
    fail(`Unexpected save sequence: ${JSON.stringify(saves)}`);
  }

  // Step three: a render that does not select memory exposes no memory tools,
  // and the recall still happens for every binding.
  const recallsBefore = memoryCalls.filter((call) => call.op === "recall").length;
  await turn("nomemory: say hello");
  const thirdTools = rendered("No memory for this request.")[0]?.tools ?? fail("The third step did not render");
  if (Object.keys(thirdTools).some((name) => name.startsWith("memory_"))) {
    fail(`Memory tools leaked into a render that selected none: ${JSON.stringify(Object.keys(thirdTools))}`);
  }
  memoryCalls = await calls();
  if (memoryCalls.filter((call) => call.op === "recall").length !== recallsBefore + 1) {
    fail("The third step did not recall the bound resource");
  }

  const metrics = await miniflare
    .dispatchFetch(`http://runtime.local/sessions/${runtimeSession}/metrics`)
    .then((response) => response.json());
  // Snapshots: two model requests in step one, three in step two, one in step three.
  if (metrics.memory?.bindings !== 1 || metrics.memory?.snapshots !== 6 || metrics.memory?.saved !== 2) {
    fail(`Unexpected memory metrics: ${JSON.stringify(metrics)}`);
  }
  if (sandboxCalls !== 0 || metrics.sandboxLease !== null || metrics.capabilityFaults !== 0) {
    fail(`Memory operations touched the sandbox: ${JSON.stringify({ sandboxCalls, metrics })}`);
  }

  // Step four: the execution fence on the real host. While a turn is live
  // (its lease is claimed before the prompt is admitted), a second /turn is
  // refused with the live turn id instead of steering into it; /interrupt
  // ends the live execution and acknowledges; a /turn after that runs.
  const stalled = await miniflare.dispatchFetch(`http://runtime.local/sessions/${runtimeSession}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionID: session.id, text: "stall: keep the model busy", turnId: "turn-stalled" }),
  });
  if (stalled.status !== 200) fail(`Stalled turn was not admitted (${stalled.status}): ${await stalled.text()}`);
  const reader = stalled.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const readUntil = async (predicate) => {
    for (;;) {
      if (predicate(buffered)) return;
      const { value, done } = await reader.read();
      if (done) fail(`Stalled stream ended before: ${buffered}`);
      buffered += decoder.decode(value, { stream: true });
    }
  };
  await readUntil((text) => text.includes('"turn.admitted"'));
  const refused = await miniflare.dispatchFetch(`http://runtime.local/sessions/${runtimeSession}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionID: session.id, text: "nomemory: too early", turnId: "turn-too-early" }),
  });
  const refusal = await refused.json();
  if (refused.status !== 409 || refusal.error !== "turn_in_progress" || refusal.turnId !== "turn-stalled") {
    fail(`A second turn was not fenced: ${refused.status} ${JSON.stringify(refusal)}`);
  }
  const interrupted = await miniflare.dispatchFetch(`http://runtime.local/sessions/${runtimeSession}/interrupt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionID: session.id, turnId: "turn-stalled" }),
  });
  const acknowledgement = await interrupted.json();
  if (interrupted.status !== 200 || acknowledgement.interrupted !== true || acknowledgement.turnId !== "turn-stalled" || acknowledgement.active !== false) {
    fail(`Interrupt did not acknowledge: ${interrupted.status} ${JSON.stringify(acknowledgement)}`);
  }
  await readUntil((text) => text.includes('"session.execution.interrupted"'));
  const afterwards = await turn("nomemory: after the interrupt");
  if (!afterwards.some((event) => event.type === "session.execution.succeeded")) fail("The turn after the interrupt did not run");
  const again = await miniflare.dispatchFetch(`http://runtime.local/sessions/${runtimeSession}/interrupt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionID: session.id }),
  });
  const idle = await again.json();
  if (again.status !== 200 || idle.interrupted !== false || idle.turnId !== null) {
    fail(`An idle interrupt should acknowledge with nothing to stop: ${JSON.stringify(idle)}`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      fence: { refused: refusal, acknowledgement },
      openCodeSessionID: session.id,
      modelRequests: modelRequests.length,
      saves: saves.map((call) => call.result.status),
      savedEvents: firstSaved.length + secondSaved.length,
      snapshots: metrics.memory.snapshots,
      sandboxCalls,
    }),
  );
} finally {
  await miniflare.dispose();
}
