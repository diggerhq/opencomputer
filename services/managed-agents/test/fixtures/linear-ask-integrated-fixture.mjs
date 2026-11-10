// Shared by the Linear `ask` integrated test (runs in workerd) and its vitest
// project configuration (runs in Node): the deployed agent's artifact and the
// scripted model. Plain JavaScript with only web platform APIs, so the same
// module loads in both.

const encode = (value) => btoa(unescape(encodeURIComponent(value)));

export const LINEAR_ASK_MODEL = "anthropic/claude-sonnet-5";

/**
 * The deployed agent: a turn that is not an answer selects only `ask` (the
 * read-only intake of design 018); a turn that answers selects nothing and
 * says what it received, so the test can read `answer` and `steering` back
 * from the model's own reply.
 */
export const artifactBundle = new TextEncoder().encode(
  JSON.stringify({
    version: 1,
    files: [
      {
        path: "agent.js",
        content: encode(`
          import { useInput, useModel, useTool } from "./opencomputer-agent.js";
          export default function agent() {
            useModel("${LINEAR_ASK_MODEL}");
            const input = useInput();
            if (input.answer) {
              return "Answer received: " + JSON.stringify(input.answer) +
                " Steering: " + JSON.stringify(input.steering || []);
            }
            useTool("ask");
            return "Read the issue, then ask the person how to proceed. Never act before they answer.";
          }
        `),
      },
      {
        path: "opencomputer-agent.js",
        content: encode(`
          const hooks = () => globalThis[Symbol.for("opencomputer.agent-hooks")];
          export const useInput = () => hooks().useInput();
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
            tools: [],
            connections: [],
            mcpServers: [],
            models: [{ provider: "openrouter", model: LINEAR_ASK_MODEL }],
            memory: [],
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

/** Every chat completion the model saw, in order, for assertions. */
const seen = [];

/**
 * The scripted model behind the OpenAI-compatible chat completions route.
 * With `ask` among the offered tools it calls `ask` once with two options;
 * otherwise it answers with the system instructions' first sentence, which
 * carries what the render received. `GET /__test/model-calls` returns what
 * it saw. Every other outbound request is refused.
 */
export async function mockModel(request) {
  const url = new URL(request.url);
  if (url.pathname === "/__test/model-calls") return Response.json({ calls: seen });
  if (url.pathname.endsWith("/models/resolve")) {
    const input = JSON.parse(await request.text());
    return Response.json({ model: input.model });
  }
  if (!url.pathname.endsWith("/chat/completions")) {
    return Response.json({ error: `unexpected outbound request to ${url.origin}${url.pathname}` }, { status: 404 });
  }
  const body = JSON.parse(await request.text());
  if (body.model !== LINEAR_ASK_MODEL) {
    return Response.json({ error: `expected ${LINEAR_ASK_MODEL}, received ${String(body.model)}` }, { status: 400 });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools.map((tool) => tool?.function?.name) : [];
  const system = messages.filter((entry) => entry.role === "system").map((entry) => text(entry.content)).join("\n");
  const lastUser = messages.findLastIndex((entry) => entry.role === "user");
  const toolResults = messages.slice(lastUser + 1).filter((entry) => entry.role === "tool");
  seen.push({ tools, prompt: text(messages[lastUser]?.content), toolResults: toolResults.length });
  const chunk = (delta, finishReason = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-linear-ask",
      object: "chat.completion.chunk",
      created: 1,
      model: "mock-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  const sse = (frames) =>
    new Response(frames + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  const reply = (content) => sse(chunk({ role: "assistant", content: "" }) + chunk({ content }) + chunk({}, "stop"));
  // OpenCode also asks for a thread title, with no tools.
  if (!Array.isArray(body.tools)) return reply("A title");
  if (tools.includes("ask") && toolResults.length === 0) {
    return sse(
      chunk({ role: "assistant", content: "" }) +
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call-linear-ask",
              type: "function",
              function: {
                name: "ask",
                arguments: JSON.stringify({
                  text: "Ship it as described, or plan first?",
                  options: [
                    { label: "Go", value: "go" },
                    { label: "Plan first", value: "plan" },
                  ],
                }),
              },
            },
          ],
        }) +
        chunk({}, "tool_calls"),
    );
  }
  if (toolResults.length > 0) return reply("The model wrote after ask; the host should have ended the turn.");
  const received = /Answer received: .*/.exec(system)?.[0] ?? "No answer in the instructions.";
  return reply(received);
}
