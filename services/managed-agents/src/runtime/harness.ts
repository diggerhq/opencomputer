import {
  createOpencode,
  createOpencodeClient,
  type AssistantMessage,
  type OpencodeClient,
  type QuestionInfo,
  type ToolPart,
} from "@opencode-ai/sdk/v2";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  QuestionOption,
  RuntimeEventInput,
  SessionIdentity,
  StructuredAgentInput,
} from "../protocol.js";
import { OpenCode2ReactiveHarness } from "./opencode2-harness.js";

export interface HarnessTurn {
  turnId: string;
  input: string;
  agentInput: StructuredAgentInput;
  /** The runtime's attachment epoch; a result commit from this turn is fenced by it. */
  epoch?: number;
  /** The session's host-assigned identity, as the Session object sent it with the turn. */
  identity?: SessionIdentity;
}

/** An `ask` call that ended a turn, as the runtime sends it with `turn.completed`. */
export interface AskedQuestionInput {
  callId: string;
  text: string;
  options: QuestionOption[];
  context?: string;
}

export interface Harness {
  start(): Promise<void>;
  run(turn: HarnessTurn): AsyncIterable<RuntimeEventInput>;
  /** The question the last run ended with, if it asked; cleared once read. */
  takeQuestion?(): AskedQuestionInput | undefined;
  steer(input: string): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export type HarnessName = "mock" | "opencode" | "opencode2-reactive";

interface PendingQuestion {
  id: string;
  questions: QuestionInfo[];
  messageId?: string;
}

export function formatQuestions(questions: QuestionInfo[]): string {
  return questions
    .map((question) => {
      const options = question.options
        .map((option) => `- ${option.label}: ${option.description}`)
        .join("\n");
      return options ? `${question.question}\n${options}` : question.question;
    })
    .join("\n\n");
}

export function questionAnswers(
  questions: QuestionInfo[],
  input: string,
): string[][] {
  return questions.map(() => [input]);
}

export function promptToolOverrides(config: unknown): Record<string, boolean> {
  const overrides: Record<string, boolean> = {};
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const record = config as Record<string, unknown>;
    if (record.tools && typeof record.tools === "object" && !Array.isArray(record.tools)) {
      for (const [name, enabled] of Object.entries(record.tools)) {
        if (typeof enabled === "boolean") overrides[name] = enabled;
      }
    }
    if (
      record.permission &&
      typeof record.permission === "object" &&
      !Array.isArray(record.permission)
    ) {
      for (const [name, action] of Object.entries(record.permission)) {
        if (action === "deny") overrides[name] = false;
      }
    }
  }
  return overrides;
}

function addBundledOpenCodeToPath(): void {
  const packagePath = fileURLToPath(
    import.meta.resolve("opencode-ai/package.json"),
  );
  const binaryDirectory = resolve(dirname(packagePath), "..", ".bin");
  const currentPath = process.env.PATH ?? "";
  if (!currentPath.split(delimiter).includes(binaryDirectory)) {
    process.env.PATH = currentPath
      ? `${binaryDirectory}${delimiter}${currentPath}`
      : binaryDirectory;
  }
}

export class MockHarness implements Harness {
  async start(): Promise<void> {}

  async *run(turn: HarnessTurn): AsyncIterable<RuntimeEventInput> {
    const response = `OpenComputer received: ${turn.input}`;
    for (const token of response.split(/(\s+)/).filter(Boolean)) {
      yield {
        type: "message.delta",
        data: { text: token },
      };
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    yield {
      type: "message.completed",
      data: { text: response },
    };
  }

  async steer(_input: string): Promise<void> {}

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

export class OpenCodeHarness implements Harness {
  private abortController?: AbortController;
  private client?: OpencodeClient;
  private server?: { close(): void };
  private sessionId?: string;
  private promptTools: Record<string, boolean> = {};
  private pendingQuestion?: PendingQuestion;

  constructor(
    private readonly directory: string,
    private readonly model = process.env.BLUE_MODEL ??
      "openrouter/anthropic/claude-sonnet-4.6",
  ) {}

  private log(message: string): void {
    if (process.env.BLUE_RUNTIME_QUIET !== "1") {
      process.stdout.write(message);
    }
  }

  async start(): Promise<void> {
    const startedAt = Date.now();
    try {
      this.promptTools = promptToolOverrides(
        JSON.parse(await readFile(resolve(this.directory, "opencode.json"), "utf8")),
      );
    } catch {
      this.promptTools = {};
    }
    const serverUrl = process.env.BLUE_OPENCODE_URL;
    if (serverUrl) {
      this.log(`opencode: attaching to ${serverUrl}\n`);
      this.client = createOpencodeClient({
        baseUrl: serverUrl,
        directory: this.directory,
      });
      const health = await this.client.global.health();
      if (health.error || !health.data?.healthy) {
        throw new Error(
          `Prestarted OpenCode server is unhealthy: ${JSON.stringify(health.error)}`,
        );
      }
    } else {
      this.log(
        `opencode: starting server from ${process.cwd()}\n`,
      );
      addBundledOpenCodeToPath();
      this.abortController = new AbortController();
      const instance = await createOpencode({
        signal: this.abortController.signal,
        port: 0,
        timeout: 45_000,
        config: {
          model: this.model,
          enabled_providers: ["openrouter"],
          tools: this.promptTools,
          permission: { question: "allow" },
          provider: process.env.BLUE_OPENROUTER_BASE_URL
            ? {
                openrouter: {
                  options: {
                    baseURL: process.env.BLUE_OPENROUTER_BASE_URL,
                  },
                },
              }
            : undefined,
          autoupdate: false,
          share: "disabled",
        },
      });
      this.client = instance.client;
      this.server = instance.server;
    }
    this.log(
      `opencode: server ready in ${String(Date.now() - startedAt)}ms\n`,
    );

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (apiKey) {
      const authenticated = await this.client.auth.set({
        providerID: "openrouter",
        auth: { type: "api", key: apiKey },
      });
      if (authenticated.error || authenticated.data !== true) {
        throw new Error(
          `OpenCode rejected the OpenRouter credential: ${JSON.stringify(authenticated.error)}`,
        );
      }
    }

    const sessionStartedAt = Date.now();
    const sessionStatePath = process.env.BLUE_OPENCODE_SESSION_PATH;
    if (sessionStatePath) {
      try {
        const state = JSON.parse(await readFile(sessionStatePath, "utf8")) as {
          sessionId?: unknown;
        };
        if (typeof state.sessionId === "string") {
          const existing = await this.client.session.get({
            sessionID: state.sessionId,
            directory: this.directory,
          });
          if (existing.data) {
            this.sessionId = state.sessionId;
          }
        }
      } catch {
        // A missing or stale state file falls back to a fresh OpenCode session.
      }
    }

    if (!this.sessionId) {
      const response = await this.client.session.create({
        directory: this.directory,
      });
      if (!response.data) {
        throw new Error("OpenCode did not return a session");
      }
      this.sessionId = response.data.id;
      if (sessionStatePath) {
        await mkdir(dirname(sessionStatePath), { recursive: true });
        await writeFile(
          sessionStatePath,
          `${JSON.stringify({ sessionId: this.sessionId })}\n`,
          { mode: 0o600 },
        );
      }
    }
    this.log(
      `opencode: session ready in ${String(Date.now() - sessionStartedAt)}ms\n`,
    );

    const pending = await this.client.question.list({
      directory: this.directory,
    });
    const request = pending.data?.find(
      (candidate) => candidate.sessionID === this.sessionId,
    );
    if (request) {
      this.pendingQuestion = {
        id: request.id,
        questions: request.questions,
        messageId: request.tool?.messageID,
      };
    }
  }

  async *run(turn: HarnessTurn): AsyncIterable<RuntimeEventInput> {
    if (!this.client || !this.sessionId) {
      throw new Error("OpenCode harness has not started");
    }
    const client = this.client;
    const sessionId = this.sessionId;
    const subscription = await client.event.subscribe({
      directory: this.directory,
    });
    const textParts = new Map<string, string>();
    const reasoningParts = new Map<string, string>();
    const partTypes = new Map<string, "text" | "reasoning">();
    const pendingDeltas = new Map<
      string,
      Array<{ messageId: string; delta: string }>
    >();
    const toolStates = new Map<string, ToolPart["state"]["status"]>();
    const assistantMessageIds = new Set<string>();
    let assistantMessage: AssistantMessage | undefined;

    const consumePendingDeltas = (
      partId?: string,
      messageId?: string,
    ): RuntimeEventInput[] => {
      const output: RuntimeEventInput[] = [];
      for (const [candidatePartId, deltas] of pendingDeltas) {
        if (partId && candidatePartId !== partId) continue;
        const partType = partTypes.get(candidatePartId);
        if (!partType) continue;

        const remaining: typeof deltas = [];
        for (const pending of deltas) {
          if (
            (messageId && pending.messageId !== messageId) ||
            !assistantMessageIds.has(pending.messageId)
          ) {
            remaining.push(pending);
            continue;
          }
          const parts =
            partType === "text" ? textParts : reasoningParts;
          parts.set(
            candidatePartId,
            `${parts.get(candidatePartId) ?? ""}${pending.delta}`,
          );
          output.push({
            type:
              partType === "text"
                ? "message.delta"
                : "reasoning.delta",
            data: { text: pending.delta, partId: candidatePartId },
          });
        }
        if (remaining.length > 0) {
          pendingDeltas.set(candidatePartId, remaining);
        } else {
          pendingDeltas.delete(candidatePartId);
        }
      }
      return output;
    };

    try {
      const firstEvent = subscription.stream.next();
      await Promise.race([
        firstEvent.then(() => undefined),
        new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, 100),
        ),
      ]);
      if (this.pendingQuestion) {
        const pending = this.pendingQuestion;
        this.pendingQuestion = undefined;
        if (pending.messageId) assistantMessageIds.add(pending.messageId);
        const answers = questionAnswers(pending.questions, turn.input);
        const reply = await client.question.reply({
          requestID: pending.id,
          directory: this.directory,
          answers,
        });
        if (reply.error) {
          this.pendingQuestion = pending;
          throw new Error(JSON.stringify(reply.error));
        }
      } else {
        const separator = this.model.indexOf("/");
        const providerID =
          separator === -1 ? "openrouter" : this.model.slice(0, separator);
        const modelID =
          separator === -1 ? this.model : this.model.slice(separator + 1);
        const prompt = await client.session.promptAsync({
          sessionID: sessionId,
          directory: this.directory,
          model: { providerID, modelID },
          tools: this.promptTools,
          parts: [{ type: "text", text: turn.input }],
        });
        if (prompt.error) {
          throw new Error(JSON.stringify(prompt.error));
        }
      }

      async function* events() {
        const first = await firstEvent;
        if (!first.done) yield first.value;
        yield* subscription.stream;
      }
      for await (const event of events()) {
        if (
          (event.type === "question.asked" ||
            event.type === "question.v2.asked") &&
          event.properties.sessionID === sessionId
        ) {
          const questionText = formatQuestions(event.properties.questions);
          this.pendingQuestion = {
            id: event.properties.id,
            questions: event.properties.questions,
            messageId: event.properties.tool?.messageID,
          };
          if (event.properties.tool) {
            yield {
              type: "tool.completed",
              data: {
                callId: event.properties.tool.callID,
                tool: "question",
                title: "Waiting for your reply",
                output: questionText,
              },
            };
          }
          yield { type: "message.delta", data: { text: questionText } };
          textParts.set(`question:${event.properties.id}`, questionText);
          break;
        }
        if (event.type === "message.part.delta") {
          const { sessionID, messageID, partID, field, delta } =
            event.properties;
          if (sessionID !== sessionId || field !== "text" || !delta) {
            continue;
          }
          const pending = pendingDeltas.get(partID) ?? [];
          pending.push({ messageId: messageID, delta });
          pendingDeltas.set(partID, pending);
          for (const runtimeEvent of consumePendingDeltas(partID, messageID)) {
            yield runtimeEvent;
          }
          continue;
        }
        if (event.type === "message.part.updated") {
          const { part } = event.properties;
          if (part.sessionID !== sessionId) {
            continue;
          }
          const isAssistantPart = assistantMessageIds.has(part.messageID);
          if (part.type === "text") {
            partTypes.set(part.id, "text");
            if (
              isAssistantPart &&
              part.text.length >= (textParts.get(part.id)?.length ?? 0)
            ) {
              textParts.set(part.id, part.text);
            }
            for (const runtimeEvent of consumePendingDeltas(
              part.id,
              part.messageID,
            )) {
              yield runtimeEvent;
            }
            continue;
          }
          if (part.type === "reasoning") {
            partTypes.set(part.id, "reasoning");
            if (
              isAssistantPart &&
              part.text.length >=
              (reasoningParts.get(part.id)?.length ?? 0)
            ) {
              reasoningParts.set(part.id, part.text);
            }
            for (const runtimeEvent of consumePendingDeltas(
              part.id,
              part.messageID,
            )) {
              yield runtimeEvent;
            }
            continue;
          }
          if (part.type === "tool") {
            if (!isAssistantPart) continue;
            const previous = toolStates.get(part.callID);
            const current = part.state.status;
            if (previous === current) continue;
            toolStates.set(part.callID, current);
            if (current === "running") {
              yield {
                type: "tool.started",
                data: {
                  callId: part.callID,
                  tool: part.tool,
                  title: part.state.title,
                  input: part.state.input,
                },
              };
            } else if (current === "completed") {
              yield {
                type: "tool.completed",
                data: {
                  callId: part.callID,
                  tool: part.tool,
                  title: part.state.title,
                  output: part.state.output,
                },
              };
            } else if (current === "error") {
              yield {
                type: "tool.failed",
                data: {
                  callId: part.callID,
                  tool: part.tool,
                  message: part.state.error,
                },
              };
            }
          }
          continue;
        }
        if (event.type === "message.updated") {
          const { info } = event.properties;
          if (info.sessionID === sessionId && info.role === "assistant") {
            assistantMessageIds.add(info.id);
            assistantMessage = info;
            for (const runtimeEvent of consumePendingDeltas(
              undefined,
              info.id,
            )) {
              yield runtimeEvent;
            }
          }
          continue;
        }
        if (
          event.type === "session.error" &&
          event.properties.sessionID === sessionId
        ) {
          throw new Error(
            JSON.stringify(event.properties.error ?? "OpenCode session failed"),
          );
        }
        if (
          event.type === "session.idle" &&
          event.properties.sessionID === sessionId
        ) {
          break;
        }
      }
    } finally {
      await subscription.stream.return(undefined);
    }

    if (assistantMessage?.error) {
      throw new Error(JSON.stringify(assistantMessage.error));
    }
    const text = Array.from(textParts.values()).join("");
    const reasoning = Array.from(reasoningParts.values()).join("");
    if (reasoning) {
      yield {
        type: "reasoning.completed",
        data: { text: reasoning },
      };
    }
    yield {
      type: "message.completed",
      data: {
        text,
        source: "opencode",
        opencodeSessionId: sessionId,
      },
    };
    if (assistantMessage) {
      yield {
        type: "usage.recorded",
        data: {
          provider: "openrouter",
          model: `${assistantMessage.providerID}/${assistantMessage.modelID}`,
          inputTokens: assistantMessage.tokens.input,
          outputTokens: assistantMessage.tokens.output,
          reasoningTokens: assistantMessage.tokens.reasoning,
          cachedTokens: assistantMessage.tokens.cache.read,
          cacheWriteTokens: assistantMessage.tokens.cache.write,
          costUsd: assistantMessage.cost,
          payer: "user",
        },
      };
    }
  }

  async steer(_input: string): Promise<void> {
    throw new Error("This runtime does not support steering active work");
  }

  async interrupt(): Promise<void> {
    if (!this.client || !this.sessionId) return;
    const aborted = await this.client.session.abort({
      sessionID: this.sessionId,
      directory: this.directory,
    });
    if (aborted.error) throw new Error(JSON.stringify(aborted.error));
  }

  async close(): Promise<void> {
    if (this.client && process.env.OPENROUTER_API_KEY) {
      await this.client.auth
        .remove({ providerID: "openrouter" })
        .catch(() => undefined);
    }
    this.abortController?.abort();
    this.server?.close();
  }
}

export function createHarness(
  name: HarnessName,
  directory: string,
  model?: string,
): Harness {
  if (name === "opencode2-reactive") {
    const serverUrl = process.env.BLUE_OPENCODE_URL;
    if (!serverUrl) {
      throw new Error("The reactive harness requires a prestarted OpenCode 2 server");
    }
    return new OpenCode2ReactiveHarness(
      serverUrl,
      directory,
      model ?? "openrouter/anthropic/claude-sonnet-4.6",
      process.env.BLUE_OPENCODE_SESSION_PATH,
    );
  }
  return name === "opencode"
    ? new OpenCodeHarness(directory, model)
    : new MockHarness();
}
