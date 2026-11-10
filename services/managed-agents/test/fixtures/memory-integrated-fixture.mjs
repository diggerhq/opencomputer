// Shared by the integrated memory test (runs in workerd) and its vitest
// project configuration (runs in Node): the deployed agent's artifact and
// the scripted model. Plain JavaScript with only web platform APIs, so the
// same module loads in both.

const encode = (value) => btoa(unescape(encodeURIComponent(value)));

/**
 * The deployed agent: one read-write `notes` document projected into the
 * instructions, written back with memory_save. `nomemory` input renders
 * without selecting memory; a payload, when the input carries one, is
 * projected verbatim so the test can read what `useInput()` returned.
 * The agent-side `useMemory` wrapper is the
 * compiled package's shape: the host hook returns the projection or
 * undefined, and the wrapper throws for an unbound id before inference.
 */
export const artifactBundle = new TextEncoder().encode(
  JSON.stringify({
    version: 1,
    files: [
      {
        path: "agent.js",
        content: encode(`
          import { useInput, useMemory, useModel } from "./opencomputer-agent.js";
          export default function agent() {
            useModel("anthropic/claude-sonnet-5");
            const input = useInput();
            const payload = input.payload === undefined ? "" : " Payload: " + JSON.stringify(input.payload);
            if (/nomemory/.test(input.text || "")) return "No memory for this request." + payload;
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
          export const useModel = (model) => hooks().useModel(model);
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
            models: [
              { provider: "openrouter", model: "anthropic/claude-sonnet-5" },
            ],
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
      {
        path: ".opencode/skills/billing/SKILL.md",
        content: encode(`---
name: billing
description: Safely handle billing changes.
---

# Billing

Use the packaged checklist before changing billing.
`),
      },
      {
        path: ".opencode/skills/billing/CHECKLIST.md",
        content: encode(
          "Verify the customer and current plan before making a change.\n",
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
/** Model calls seen per flaky prompt, so the first attempt fails and the retry answers. */
const flakyAttempts = new Map();

/**
 * The scripted model behind the OpenAI-compatible chat completions route.
 * A prompt `save:<text>` makes it call memory_save with that text, then
 * answer with the tool result; a conflict result makes it save once more
 * with the current text appended; anything else is answered directly.
 * Every other outbound request is refused: the test must not reach the
 * network.
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
  if (body.model !== "anthropic/claude-sonnet-5") {
    return Response.json(
      { error: `expected anthropic/claude-sonnet-5, received ${String(body.model)}` },
      { status: 400 },
    );
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const chunk = (delta, finishReason = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-memory-integrated",
      object: "chat.completion.chunk",
      created: 1,
      model: "mock-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  const sse = (frames) =>
    new Response(frames + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  const reply = (content) => sse(chunk({ role: "assistant", content: "" }) + chunk({ content }) + chunk({}, "stop"));
  const callTool = (name, args) => {
    toolCalls += 1;
    return sse(
      chunk({ role: "assistant", content: "" }) +
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `call-memory-integrated-${String(toolCalls)}`,
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
  // Model calls that fail the way providers do, so the loop's retries are
  // exercised: `flaky-internal:` answers 502 to the first attempt and
  // answers on the second; `flaky-stream:` streams one token and then ends
  // the first response without a finish; `flaky-tool:` streams a complete
  // memory_save call and then ends the response without a finish, calls
  // again when the conversation shows that call failed, and answers once
  // a call saved; `malformed:` answers the first attempt with a frame that
  // is not JSON (`malformed: always` answers every attempt so); `rejected:`
  // always answers 401. The scripted prompt may not be the last user
  // message: a continuation after a broken stream appends a synthetic one,
  // so the last user message naming a script is the one in play.
  const flakyPrompt = messages
    .filter((entry) => entry.role === "user")
    .map((entry) => text(entry.content))
    .findLast((entry) => /^(flaky-internal|flaky-stream|flaky-tool|malformed|rejected):/.test(entry));
  const flaky = flakyPrompt ? /^(flaky-internal|flaky-stream|flaky-tool|malformed|rejected):(.*)$/s.exec(flakyPrompt) : null;
  if (flaky) {
    // OpenCode also asks the model for a thread title with the same user
    // text and no tools; only the agent's own request, the one carrying
    // tools, is scripted to fail.
    if (!Array.isArray(body.tools)) return reply("A title");
    const attempts = (flakyAttempts.get(flakyPrompt) ?? 0) + 1;
    flakyAttempts.set(flakyPrompt, attempts);
    if (flaky[1] === "rejected") {
      return Response.json({ error: { message: "scripted rejection" } }, { status: 401 });
    }
    if (flaky[1] === "malformed") {
      if (flaky[2].trim() === "always" || attempts === 1) {
        return new Response("data: {not valid JSON}\n\n", { headers: { "content-type": "text/event-stream" } });
      }
      return reply(`Recovered after ${String(attempts)} calls`);
    }
    if (flaky[1] === "flaky-internal" && attempts === 1) {
      return Response.json({ error: { message: "scripted upstream failure" } }, { status: 502 });
    }
    if (flaky[1] === "flaky-internal" && flaky[2].trim() === "progress then tool") {
      // The retried call answers with progress text and a tool call; the
      // step after the tool answers on its own.
      if (messages.some((entry) => entry.role === "tool")) return reply("Final answer.");
      toolCalls += 1;
      return sse(
        chunk({ role: "assistant", content: "" }) +
          chunk({ content: "Progress before the tool. " }) +
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `call-memory-integrated-${String(toolCalls)}`,
                type: "function",
                function: { name: "memory_save", arguments: JSON.stringify({ text: "saved", summary: "notes" }) },
              },
            ],
          }) +
          chunk({}, "tool_calls"),
      );
    }
    if (flaky[1] === "flaky-stream" && attempts === 1) {
      return new Response(chunk({ role: "assistant", content: "" }) + chunk({ content: "Partial " }), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (flaky[1] === "flaky-tool") {
      const results = messages.filter((entry) => entry.role === "tool").map((entry) => text(entry.content));
      const saved = results.find((result) => /"status":"saved"/.test(result));
      if (saved) return reply(`Saved on attempt ${String(attempts)}: ${saved}`);
      const wanted = { text: flaky[2].trim(), summary: "Workshop requirements." };
      if (results.length > 0) return callTool("memory_save", wanted);
      toolCalls += 1;
      return new Response(
        chunk({ role: "assistant", content: "" }) +
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `call-memory-integrated-${String(toolCalls)}`,
                type: "function",
                function: { name: "memory_save", arguments: JSON.stringify(wanted) },
              },
            ],
          }) +
          chunk({ content: "Saving " }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return reply(`Answered on attempt ${String(attempts)}: ${flaky[2].trim()}`);
  }
  const toolResults = messages.slice(lastUser + 1).filter((entry) => entry.role === "tool");
  if (prompt === "load the billing skill") {
    const available = Array.isArray(body.tools)
      ? body.tools.some((tool) => tool?.function?.name === "load_agent_skill")
      : false;
    if (!available) return reply("The skill loader was not available.");
    if (toolResults.length === 0) {
      return callTool("load_agent_skill", { name: "billing" });
    }
    const last = text(toolResults[toolResults.length - 1].content);
    if (toolResults.length === 1) {
      if (!last.includes("Use the packaged checklist")) {
        return reply(`The skill body was not loaded: ${last}`);
      }
      return callTool("load_agent_skill", {
        name: "billing",
        file: "CHECKLIST.md",
      });
    }
    return reply(`Skill loaded: ${last}`);
  }
  const wanted = /^save:(.*)$/s.exec(prompt)?.[1]?.trim();
  if (wanted === undefined) return reply("No memory used.");
  if (toolResults.length === 0) {
    return callTool("memory_save", { text: wanted, summary: "Workshop requirements." });
  }
  const last = text(toolResults[toolResults.length - 1].content);
  const conflict = /"status":"conflict"/.test(last)
    ? JSON.parse(last.slice(last.indexOf("{"), last.lastIndexOf("}") + 1))
    : null;
  if (toolResults.length === 1 && conflict) {
    return callTool("memory_save", { text: `${conflict.text}\n${wanted}` });
  }
  return reply(`Done: ${last}`);
}
