// Standalone OpenComputer hosting for a LangGraph.js graph, as a Workers-for-Platforms
// tenant: one Durable Object per session that speaks the OC agent-Worker contract
// (oc-runtimes/agent-worker-hosting) so it rides flue's deploy + dispatch + tailer plane.
// Zero @flue/runtime dependency — the graph runs in the DO with a DO-backed checkpointer.
//
// The dispatch Worker strips `/dispatch/<agt_id>` and forwards BYTE-EXACT, so the tenant
// Worker sees exactly:
//   GET  /health                                   -> 200 (deploy settle probe)
//   POST /agents/<name>/<ses>          {"message"} -> 202 {submissionId, offset}   (admit)
//   GET  /agents/<name>/<ses>?view=updates&offset=<n>&live=long-poll
//                                                  -> 200 ConversationStreamChunk[]  (tail)
//                                                     headers Stream-Next-Offset, Stream-Up-To-Date
//                                                  -> 499 when idle (long-poll expired, up to date)
//   POST /agents/<name>/<ses>/abort                -> 202 (cancel the running turn)
//
// A turn runs from a durable DO ALARM (survives isolate eviction): admit records the
// pending message + arms the alarm and returns the receipt immediately; the alarm streams
// the graph, appending ConversationStreamChunks to an offset-addressed durable log that the
// OC tailer drains via ?view=updates. The chunk stream is derived generically from LangGraph
// `streamEvents(v2)`, so it works for ANY user graph (single node, ReAct, multi-node).

import { DurableObjectSaver, type DOStorage } from "./checkpointer.js";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

// ── ConversationStreamChunk (contract #2; mirrors sessions-api core/flue-tailer.ts) ──
// The tenant emits ASSEMBLY chunks; the OC tailer reduces them into Tier-1 OC events.
export type StreamChunk =
  | { type: "message-started"; messageId: string; submissionId?: string; model?: { provider: string; id: string }; turnId?: string }
  | { type: "message-delta"; messageId: string; kind: "text" | "reasoning"; delta: string }
  | { type: "tool-input"; messageId: string; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-output"; toolCallId: string; output: unknown; durationMs?: number }
  | { type: "tool-output-error"; toolCallId: string; errorText: string; durationMs?: number }
  | { type: "message-completed"; messageId: string; usage?: unknown }
  | { type: "submission-settled"; submissionId: string; outcome: "completed" | "failed" | "aborted"; error?: unknown };

// ── Minimal Cloudflare Durable Object surface (avoids a @cloudflare/workers-types dep) ──
export interface DOStorageWithAlarm extends DOStorage {
  setAlarm(scheduledTime: number): Promise<void>;
  getAlarm(): Promise<number | null>;
}
export interface DurableObjectState {
  storage: DOStorageWithAlarm;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}
export interface DurableObjectId { toString(): string }
export interface DurableObjectStub { fetch(req: Request): Promise<Response> }
export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

/** A compiled LangGraph graph — structurally what `StateGraph.compile()` returns (the bits we use).
 *  We drive off `stream(streamMode:"updates")` — the graph's own per-node output channel — NOT
 *  `streamEvents`: LangChain's callback context (AsyncLocalStorage) does not propagate to the model
 *  call in the Workers runtime, so streamEvents silently drops all on_chat_model_* events. */
export interface CompiledGraph {
  stream(input: unknown, options: Record<string, unknown>): Promise<AsyncIterable<Record<string, unknown>>>;
}

export interface LangGraphRuntimeOptions {
  /** Compile the graph with the runtime-provided durable checkpointer. */
  compile: (checkpointer: BaseCheckpointSaver) => CompiledGraph;
  /** Durable Object binding name in wrangler.jsonc (default "SESSION"). */
  binding?: string;
}

type RuntimeEnv = Record<string, unknown>;

export interface SessionDurableObject { fetch(req: Request): Promise<Response>; alarm(): Promise<void> }
export interface LangGraphRuntime {
  fetch(req: Request, env: RuntimeEnv): Promise<Response>;
  SessionDO: new (state: DurableObjectState, env: RuntimeEnv) => SessionDurableObject;
}

const LONGPOLL_MS = 20_000;             // how long a ?live=long-poll read waits for new chunks
const OFF = (n: number) => `chunk:${String(n).padStart(12, "0")}`;
const rid = (p: string) => `${p}_${Math.random().toString(16).slice(2, 14)}${Math.random().toString(16).slice(2, 6)}`;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

interface Pending { message: string; submissionId: string }

/** Pull the text + reasoning deltas out of a streamed AIMessageChunk's content. */
function deltasOf(content: unknown): { text: string; reasoning: string } {
  if (typeof content === "string") return { text: content, reasoning: "" };
  let text = "", reasoning = "";
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; text?: string; thinking?: string; reasoning?: string };
      if (b.type === "text" && typeof b.text === "string") text += b.text;
      else if ((b.type === "thinking" || b.type === "reasoning") && typeof (b.thinking ?? b.reasoning) === "string") {
        reasoning += (b.thinking ?? b.reasoning) as string;
      }
    }
  }
  return { text, reasoning };
}

/** Map LangChain usage_metadata → the Flue PromptUsage shape the tailer's normalizer reads. */
function usageOf(output: unknown): unknown {
  const u = (output as { usage_metadata?: Record<string, unknown> } | undefined)?.usage_metadata;
  if (!u) return undefined;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const d = (u.input_token_details ?? {}) as Record<string, unknown>;
  return {
    input: num(u.input_tokens), output: num(u.output_tokens),
    cacheRead: num(d.cache_read), cacheWrite: num(d.cache_creation),
    totalTokens: num(u.total_tokens),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** A LangChain message → OC ConversationStreamChunks. Graph-agnostic, whole-message granularity
 *  (streamMode "updates" gives completed messages, not tokens). `emitted` dedupes across updates. */
function messageToChunks(m: unknown, submissionId: string, emitted: Set<string>): StreamChunk[] {
  const msg = m as {
    id?: unknown; content?: unknown; tool_call_id?: unknown; usage_metadata?: unknown;
    tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>;
    response_metadata?: Record<string, unknown>;
    _getType?: () => string; getType?: () => string; type?: string; role?: string;
  };
  const kind = messageKind(msg);
  if (kind === "tool") {
    const toolCallId = typeof msg.tool_call_id === "string" ? msg.tool_call_id : rid("tool");
    return [{ type: "tool-output", toolCallId, output: msg.content }];
  }
  if (kind !== "ai") return [];
  const messageId = (typeof msg.id === "string" && msg.id) || rid("msg");
  if (emitted.has(messageId)) return [];
  emitted.add(messageId);
  const out: StreamChunk[] = [];
  const model = modelOf(msg.response_metadata);
  out.push({ type: "message-started", messageId, submissionId, ...(model ? { model } : {}) });
  const { text, reasoning } = deltasOf(msg.content);
  if (reasoning) out.push({ type: "message-delta", messageId, kind: "reasoning", delta: reasoning });
  if (text) out.push({ type: "message-delta", messageId, kind: "text", delta: text });
  for (const tc of msg.tool_calls ?? []) {
    out.push({ type: "tool-input", messageId, toolCallId: tc.id ?? rid("tool"), toolName: tc.name ?? "tool", input: tc.args });
  }
  out.push({ type: "message-completed", messageId, usage: usageOf(msg) });
  return out;
}

function messageKind(m: { _getType?: () => string; getType?: () => string; type?: string; role?: string }): "ai" | "tool" | "other" {
  const t = (typeof m._getType === "function" ? m._getType() : undefined)
    ?? (typeof m.getType === "function" ? m.getType() : undefined)
    ?? m.type ?? m.role ?? "";
  if (t === "ai" || t === "assistant" || t === "AIMessage" || t === "AIMessageChunk") return "ai";
  if (t === "tool" || t === "ToolMessage") return "tool";
  return "other";
}

function modelOf(meta: Record<string, unknown> | undefined): { provider: string; id: string } | undefined {
  const id = str(meta?.model) || str(meta?.model_name);
  return id ? { provider: "anthropic", id } : undefined;
}

export function createLangGraphRuntime(opts: LangGraphRuntimeOptions): LangGraphRuntime {
  const binding = opts.binding ?? "SESSION";

  class SessionDO implements SessionDurableObject {
    private graph: CompiledGraph;
    private nextOffset = 0;
    private ready: Promise<void>;
    private waiters: Array<() => void> = [];
    private aborter: AbortController | null = null;
    private session = "default";

    constructor(private state: DurableObjectState, private env: RuntimeEnv) {
      this.graph = opts.compile(new DurableObjectSaver(state.storage));
      this.ready = state.blockConcurrencyWhile(async () => {
        this.nextOffset = (await state.storage.get<number>("meta:nextOffset")) ?? 0;
      });
    }

    async fetch(req: Request): Promise<Response> {
      await this.ready;
      const url = new URL(req.url);
      const m = url.pathname.match(/^\/agents\/([^/]+)\/([^/]+?)(\/abort)?\/?$/);
      if (!m) return json({ error: { type: "not_found" } }, 404);
      this.session = decodeURIComponent(m[2]);

      if (req.method === "POST" && m[3] === "/abort") {
        this.aborter?.abort(new Error("aborted by control plane"));
        return json({ ok: true }, 202);
      }
      if (req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { message?: unknown };
        const message = typeof body.message === "string" ? body.message : "";
        return this.admit(message);
      }
      if (req.method === "GET" && url.searchParams.get("view") === "updates") {
        const offset = Number.parseInt(url.searchParams.get("offset") ?? "-1", 10);
        const longPoll = url.searchParams.get("live") === "long-poll";
        return this.tail(Number.isFinite(offset) ? offset : -1, longPoll);
      }
      return json({ error: { type: "not_found" } }, 404);
    }

    /** Admit a turn: durably record it, arm the alarm, return the receipt immediately. */
    private async admit(message: string): Promise<Response> {
      const submissionId = rid("sub");
      const pending: Pending = { message, submissionId };
      await this.state.storage.put("meta:pending", pending);
      await this.state.storage.put("meta:activeSubmission", submissionId);
      await this.state.storage.setAlarm(Date.now());
      // offset = last-written index (readers fetch index > offset), so this turn's first chunk
      // is included. Fresh session (nextOffset 0) → "-1" = read from the very start.
      return json({ submissionId, offset: String(this.nextOffset - 1) }, 202);
    }

    /** Durable background turn runner — fires ~immediately after admit; survives eviction. */
    async alarm(): Promise<void> {
      await this.ready;
      const pending = await this.state.storage.get<Pending>("meta:pending");
      if (!pending) return;
      await this.state.storage.delete("meta:pending");
      await this.runTurn(pending);
    }

    private async runTurn(pending: Pending): Promise<void> {
      const { message, submissionId } = pending;
      const aborter = new AbortController();
      this.aborter = aborter;
      const emitted = new Set<string>();   // message ids already turned into chunks (dedupe)
      try {
        const stream = await this.graph.stream(
          { messages: [{ role: "user", content: message }] },
          { streamMode: "updates", signal: aborter.signal, configurable: { thread_id: this.session, env: this.env } },
        );
        for await (const update of stream) {
          if (aborter.signal.aborted) throw new Error("aborted");
          // streamMode "updates" yields { <nodeName>: <the node's returned state delta> }.
          // For a MessagesAnnotation graph the delta is { messages: [...new messages] }.
          for (const nodeOut of Object.values(update ?? {})) {
            const msgs = (nodeOut as { messages?: unknown } | null)?.messages;
            if (!Array.isArray(msgs)) continue;
            for (const m of msgs) {
              for (const chunk of messageToChunks(m, submissionId, emitted)) await this.append(chunk);
            }
          }
        }
        await this.append({ type: "submission-settled", submissionId, outcome: "completed" });
      } catch (err) {
        const aborted = aborter.signal.aborted;
        await this.append({
          type: "submission-settled", submissionId,
          outcome: aborted ? "aborted" : "failed",
          ...(aborted ? {} : { error: { message: err instanceof Error ? err.message : String(err) } }),
        });
      } finally {
        if (this.aborter === aborter) this.aborter = null;
        await this.state.storage.delete("meta:activeSubmission");
      }
    }

    /** Append one chunk to the durable offset log + wake any long-poll readers. */
    private async append(chunk: StreamChunk): Promise<void> {
      const idx = this.nextOffset;
      await this.state.storage.put(OFF(idx), chunk);
      this.nextOffset = idx + 1;
      await this.state.storage.put("meta:nextOffset", this.nextOffset);
      const wake = this.waiters;
      this.waiters = [];
      for (const w of wake) w();
    }

    private async readAfter(offset: number): Promise<{ chunks: StreamChunk[]; last: number }> {
      const map = await this.state.storage.list<StreamChunk>({ prefix: "chunk:" });
      const items: Array<[number, StreamChunk]> = [];
      for (const [key, chunk] of map) {
        const i = Number.parseInt(key.slice("chunk:".length), 10);
        if (i > offset) items.push([i, chunk]);
      }
      items.sort((a, b) => a[0] - b[0]);
      return { chunks: items.map((x) => x[1]), last: items.length ? items[items.length - 1][0] : offset };
    }

    /** Serve ?view=updates: return chunks after `offset`, or long-poll then 499 when idle. */
    private async tail(offset: number, longPoll: boolean): Promise<Response> {
      let { chunks, last } = await this.readAfter(offset);
      if (chunks.length === 0 && longPoll) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, LONGPOLL_MS);
          this.waiters.push(() => { clearTimeout(t); resolve(); });
        });
        ({ chunks, last } = await this.readAfter(offset));
      }
      if (chunks.length === 0) return new Response(null, { status: 499 });
      return json(chunks, 200, { "Stream-Next-Offset": String(last), "Stream-Up-To-Date": "true" });
    }
  }

  async function fetchHandler(req: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health" || url.pathname === "/healthz") return json({ status: "ok" });
    const m = url.pathname.match(/^\/agents\/([^/]+)\/([^/]+?)(?:\/abort)?\/?$/);
    if (!m) return json({ error: { type: "not_found" } }, 404);
    const ns = env[binding] as DurableObjectNamespace | undefined;
    if (!ns) return json({ error: { type: "misconfigured", message: `missing Durable Object binding "${binding}"` } }, 500);
    const session = decodeURIComponent(m[2]);
    return ns.get(ns.idFromName(session)).fetch(req);
  }

  return { fetch: fetchHandler, SessionDO };
}

function str(v: unknown): string { return typeof v === "string" ? v : ""; }
