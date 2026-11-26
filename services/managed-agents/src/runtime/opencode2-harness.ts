import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { ASK_TOOL, parseAskInput, type ValidatedAsk } from "../ask.js";
import type { RuntimeEventInput } from "../protocol.js";
import type { AskedQuestionInput, Harness, HarnessTurn } from "./harness.js";

interface OpenCodeEvent {
  type: string;
  data?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The text of an OpenCode tool result: its text parts joined, or the string it already is. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const entry = record(part);
      return entry.type === "text" && typeof entry.text === "string" ? [entry.text] : [];
    })
    .join("");
}

export class OpenCode2ReactiveHarness implements Harness {
  private sessionId?: string;
  private asked?: AskedQuestionInput;

  constructor(
    private readonly serverUrl: string,
    private readonly directory: string,
    private readonly model: string,
    private readonly sessionStatePath?: string,
    private readonly password = process.env.BLUE_OPENCODE_PASSWORD,
  ) {}

  private headers(): Record<string, string> {
    return this.password
      ? {
          authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`,
        }
      : {};
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.serverUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        ...this.headers(),
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(
        `OpenCode 2 ${init.method ?? "GET"} ${path} returned ${String(response.status)}: ${await response.text()}`,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async *events(signal: AbortSignal): AsyncIterable<OpenCodeEvent> {
    const response = await fetch(
      `${this.serverUrl.replace(/\/$/, "")}/api/event`,
      { signal, headers: this.headers() },
    );
    if (!response.ok || !response.body) {
      throw new Error(`OpenCode 2 event stream returned ${String(response.status)}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const next = await reader.read();
        buffer += decoder.decode(next.value, { stream: !next.done })
          .replaceAll("\r\n", "\n")
          .replaceAll("\r", "\n");
        if (next.done && buffer) buffer += "\n\n";
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) yield JSON.parse(data) as OpenCodeEvent;
          boundary = buffer.indexOf("\n\n");
        }
        if (next.done) return;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async start(): Promise<void> {
    const health = await this.api<{ healthy?: boolean }>("/api/health");
    if (!health.healthy) throw new Error("Prestarted OpenCode 2 is unhealthy");

    const separator = this.model.indexOf("/");
    const providerID =
      separator === -1 ? "openrouter" : this.model.slice(0, separator);
    const modelID =
      separator === -1 ? this.model : this.model.slice(separator + 1);
    if (this.sessionStatePath) {
      try {
        const saved = JSON.parse(
          await readFile(this.sessionStatePath, "utf8"),
        ) as { sessionId?: unknown };
        if (typeof saved.sessionId === "string") {
          const result = await this.api<{ data?: { id?: unknown } }>(
            `/api/session/${encodeURIComponent(saved.sessionId)}`,
          );
          if (result.data?.id !== saved.sessionId) throw new Error("stale session");
          this.sessionId = saved.sessionId;
        }
      } catch {
        // A stale or absent state file starts a new durable OpenCode session.
      }
    }
    if (!this.sessionId) {
      const created = await this.api<{ data?: { id?: unknown } }>("/api/session", {
        method: "POST",
        body: JSON.stringify({
          title: "OpenComputer managed session",
          agent: "build",
          model: { providerID, id: modelID },
          location: { directory: this.directory },
        }),
      });
      const session = created.data;
      if (typeof session?.id !== "string") {
        throw new Error("OpenCode 2 did not return a session");
      }
      this.sessionId = session.id;
      if (this.sessionStatePath) {
        await mkdir(dirname(this.sessionStatePath), { recursive: true });
        await writeFile(
          this.sessionStatePath,
          `${JSON.stringify({ sessionId: session.id })}\n`,
          { mode: 0o600 },
        );
      }
    }
  }

  async *run(turn: HarnessTurn): AsyncIterable<RuntimeEventInput> {
    if (!this.sessionId) throw new Error("OpenCode 2 harness has not started");
    const sessionId = this.sessionId;
    if (process.env.OPENCOMPUTER_REACTIVE_SESSION_PATH) {
      const bindingPath = process.env.OPENCOMPUTER_REACTIVE_SESSION_PATH;
      const binding = JSON.parse(await readFile(bindingPath, "utf8")) as object;
      // The plugin reads the turn and epoch back when the result tool
      // commits, so a call is attributed to the turn that made it.
      await writeFile(
        bindingPath,
        `${JSON.stringify({
          ...binding,
          responseId: randomUUID(),
          currentInput: turn.agentInput,
          turnId: turn.turnId,
          runtimeEpoch: turn.epoch,
          identity: turn.identity,
        })}\n`,
        { mode: 0o600 },
      );
    }
    const streamAbort = new AbortController();
    const stream = this.events(streamAbort.signal)[Symbol.asyncIterator]();
    const firstEvent = stream.next();
    await Promise.race([
      firstEvent.then(() => undefined),
      new Promise<void>((done) => setTimeout(done, 100)),
    ]);
    await this.api(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: turn.input, delivery: "queue" }),
    });

    let text = "";
    let reasoning = "";
    this.asked = undefined;
    const toolNames = new Map<string, string>();
    // Each `ask` call's validated input, from its `session.tool.called`.
    const askInputs = new Map<string, ValidatedAsk>();
    // The assistant message each call belongs to, from OpenCode; the host
    // identity of the call's events is completed from it.
    const toolMessages = new Map<string, string>();
    const toolMessage = (id: string): string => {
      const known = toolMessages.get(id);
      if (known) return known;
      const reported = typeof data.assistantMessageID === "string" ? data.assistantMessageID : "";
      if (reported) toolMessages.set(id, reported);
      return reported;
    };
    let data: Record<string, unknown> = {};
    let first: IteratorResult<OpenCodeEvent> | undefined = await firstEvent;
    try {
      for (;;) {
        const next = first ?? (await stream.next());
        first = undefined;
        if (next.done) break;
        const event = next.value;
        data = record(event.data);
        if (data.sessionID !== sessionId) continue;
        if (event.type === "session.text.delta") {
          const delta = String(data.delta ?? "");
          text += delta;
          yield { type: "message.delta", data: { text: delta } };
        } else if (event.type === "session.reasoning.delta") {
          const delta = String(data.delta ?? "");
          reasoning += delta;
          yield { type: "reasoning.delta", data: { text: delta } };
        } else if (event.type === "session.tool.input.started") {
          // OpenCode names the tool here and carries the input on
          // `session.tool.called`; the public start is the call itself.
          const id = String(data.id ?? "");
          toolNames.set(id, String(data.name ?? "tool"));
          toolMessage(id);
        } else if (event.type === "session.tool.called") {
          const id = String(data.id ?? "");
          const name = toolNames.get(id) ?? "tool";
          if (name === ASK_TOOL) {
            const parsed = parseAskInput(data.input);
            if (parsed.ok) askInputs.set(id, parsed.input);
          }
          yield {
            type: "tool.started",
            data: {
              callId: id,
              tool: name,
              title: name,
              input: record(data.input),
              messageId: toolMessage(id),
            },
          };
        } else if (event.type === "session.tool.progress") {
          const id = String(data.id ?? "");
          yield {
            type: "tool.progress",
            data: {
              ...record(data.metadata),
              callId: id,
              tool: toolNames.get(id) ?? "tool",
              messageId: toolMessage(id),
            },
          };
        } else if (event.type === "session.tool.success") {
          const id = String(data.id ?? "");
          const name = toolNames.get(id) ?? "tool";
          yield {
            type: "tool.completed",
            data: {
              callId: id,
              tool: name,
              title: name,
              output: contentText(data.content),
              messageId: toolMessage(id),
            },
          };
          const ask = askInputs.get(id);
          if (name === ASK_TOOL && ask && !this.asked) {
            // The turn ends with its question: stop the loop before the
            // next step reaches the model. OpenCode then reports
            // `session.execution.interrupted`, which ends this run.
            this.asked = { callId: id, ...ask };
            await this.interrupt().catch((error: unknown) => {
              process.stderr.write(
                `${JSON.stringify({
                  level: "error",
                  event: "opencode2.ask_interrupt_failed",
                  callId: id,
                  message: error instanceof Error ? error.message : String(error),
                })}\n`,
              );
            });
          }
        } else if (event.type === "session.tool.failed") {
          const id = String(data.id ?? "");
          const name = toolNames.get(id) ?? "tool";
          const error = record(data.error);
          yield {
            type: "tool.failed",
            data: {
              callId: id,
              tool: name,
              title: name,
              messageId: toolMessage(id),
              message:
                typeof error.message === "string" ? error.message : "The tool call failed",
            },
          };
        } else if (event.type === "session.step.ended") {
          const tokens = record(data.tokens);
          const cache = record(tokens.cache);
          yield {
            type: "usage.recorded",
            data: {
              provider: "openrouter",
              model: this.model,
              inputTokens: Number(tokens.input ?? 0),
              outputTokens: Number(tokens.output ?? 0),
              reasoningTokens: Number(tokens.reasoning ?? 0),
              cachedTokens: Number(cache.read ?? 0),
              cacheWriteTokens: Number(cache.write ?? 0),
              costUsd: Number(data.cost ?? 0),
              payer: "user",
            },
          };
        } else if (event.type === "session.execution.failed") {
          throw new Error(JSON.stringify(data.error));
        } else if (
          event.type === "session.idle" ||
          event.type === "session.execution.succeeded" ||
          // After an interrupt (an `ask`, or the session cancelling the
          // turn) OpenCode sends neither of the above.
          event.type === "session.execution.interrupted"
        ) {
          break;
        }
      }
    } finally {
      streamAbort.abort();
      await stream.return?.();
    }
    if (reasoning) {
      yield { type: "reasoning.completed", data: { text: reasoning } };
    }
    yield {
      type: "message.completed",
      data: { text, source: "opencode2", opencodeSessionId: sessionId },
    };
  }

  takeQuestion(): AskedQuestionInput | undefined {
    const asked = this.asked;
    this.asked = undefined;
    return asked;
  }

  async steer(input: string): Promise<void> {
    if (!this.sessionId) throw new Error("OpenCode 2 harness has not started");
    await this.api(`/api/session/${encodeURIComponent(this.sessionId)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: input, delivery: "steer" }),
    });
  }

  async interrupt(): Promise<void> {
    if (!this.sessionId) return;
    await this.api(
      `/api/session/${encodeURIComponent(this.sessionId)}/interrupt`,
      { method: "POST" },
    );
  }

  async close(): Promise<void> {}
}
