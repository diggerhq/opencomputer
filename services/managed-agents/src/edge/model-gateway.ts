const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_RESPONSES_URL = "https://openrouter.ai/api/v1/responses";
const OPENROUTER_MESSAGES_URL = "https://openrouter.ai/api/v1/messages";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
const CODEX_CLIENT_ORIGINATOR = "opencode";
const CODEX_CLIENT_USER_AGENT = "opencode/0.0.0-next-17055";

import type { ModelGatewayProtocol } from "../protocol.js";

export type { ModelGatewayProtocol } from "../protocol.js";

type GatewayFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ModelGatewayOptions {
  apiKey: string;
  customerId: string;
  fetch?: GatewayFetch;
  protocol: ModelGatewayProtocol;
  upstream: "anthropic" | "openrouter" | "openai_compatible" | "codex";
  upstreamUrl?: string;
  upstreamModel?: string;
  chatGptAccountId?: string;
  codexComputeResidency?: string;
  sessionId?: string;
  observeResponseModel?: (model: string) => void | Promise<void>;
  /** Latency hooks (work 073): upstream headers, then its first complete SSE event when the stream is inspected. */
  timing?: {
    upstreamResponded?(status: number): void;
    firstEvent?(bytes: number): void;
  };
}

const RESPONSE_MODEL_INSPECTION_LIMIT = 64 * 1024;

function responseModel(text: string, contentType: string): string | undefined {
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const value = line.slice("data:".length).trim();
      if (!value || value === "[DONE]") continue;
      try {
        const payload = JSON.parse(value) as {
          model?: unknown;
          response?: { model?: unknown };
        };
        const model = payload.model ?? payload.response?.model;
        if (typeof model === "string" && model.length <= 256) {
          return model;
        }
      } catch {
        // A partial SSE record is completed by a later chunk.
      }
    }
    return undefined;
  }
  const match = /"model"\s*:\s*"([^"\\]{1,256})"/.exec(text);
  return match?.[1];
}

function hasCompleteSseDataEvent(text: string): boolean {
  const completeEvents = text.split(/\r?\n\r?\n/);
  completeEvents.pop();
  return completeEvents.some((event) =>
    event.split(/\r?\n/).some((line) => line.startsWith("data:")),
  );
}

async function observeResponseModel(
  upstream: Response,
  observe: (model: string) => void | Promise<void>,
  firstEvent?: (bytes: number) => void,
): Promise<Response> {
  if (!upstream.ok || !upstream.body) return upstream;
  const reader = upstream.body.getReader();
  const buffered: Uint8Array[] = [];
  const decoder = new TextDecoder();
  const contentType = upstream.headers.get("content-type") ?? "";
  let inspected = "";
  let inspectedBytes = 0;
  let upstreamDone = false;
  let model: string | undefined;

  while (
    !model &&
    !upstreamDone &&
    inspectedBytes < RESPONSE_MODEL_INSPECTION_LIMIT
  ) {
    const next = await reader.read();
    upstreamDone = next.done;
    if (!next.value) continue;
    buffered.push(next.value);
    inspectedBytes += next.value.byteLength;
    inspected += decoder.decode(next.value, { stream: !next.done });
    model = responseModel(inspected, contentType);
    // Router metadata is carried by the first SSE data event. Once that event
    // is complete, stop inspecting even when it names no model so a
    // metadata-free or unfamiliar stream cannot be buffered until EOF.
    if (
      contentType.includes("text/event-stream") &&
      hasCompleteSseDataEvent(inspected)
    ) {
      break;
    }
  }
  firstEvent?.(inspectedBytes);
  if (model) await observe(model);

  let bufferedIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (bufferedIndex < buffered.length) {
        controller.enqueue(buffered[bufferedIndex++]!);
        return;
      }
      if (upstreamDone) {
        controller.close();
        return;
      }
      const next = await reader.read();
      upstreamDone = next.done;
      if (next.done) controller.close();
      else if (next.value) controller.enqueue(next.value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

/**
 * Whether a ChatGPT Codex response is the plan's usage limit
 * (work 086): 429 with `error.type` "usage_limit_reached", the body the Codex CLI
 * reads as its usage limit. Any other 429 (a transient rate limit) or error is
 * not, and reaches the caller as it came. Reads a clone; the body is a small
 * JSON error.
 */
export async function codexUsageLimited(response: Response): Promise<boolean> {
  if (response.status !== 429) return false;
  try {
    const payload = (await response.clone().json()) as { error?: { type?: unknown } };
    return payload.error?.type === "usage_limit_reached";
  } catch {
    return false;
  }
}

/**
 * Proxies one OpenAI-compatible model request without ever forwarding the
 * session-scoped bearer token to the provider. The response body remains a
 * stream so SSE reaches OpenCode as it is produced upstream.
 */
export async function proxyModelRequest(
  request: Request,
  options: ModelGatewayOptions,
): Promise<Response> {
  const input = (await request.json()) as unknown;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return new Response(
      JSON.stringify({ error: { message: "Expected a JSON object" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  const inputBody = input as Record<string, unknown>;
  const codexCompatibleInput = { ...inputBody };
  delete codexCompatibleInput.max_output_tokens;
  const body = JSON.stringify({
    ...(options.upstream === "codex" ? codexCompatibleInput : inputBody),
    ...(options.upstreamModel ? { model: options.upstreamModel } : {}),
    // OpenRouter's `user` field is its stable usage-attribution boundary. Do
    // not add it to the private ChatGPT Codex contract.
    ...(options.upstream === "openrouter" &&
    options.protocol !== "anthropic_messages"
      ? { user: options.customerId }
      : {}),
  });
  const headers = new Headers();
  headers.set("authorization", `Bearer ${options.apiKey}`);
  headers.set(
    "content-type",
    request.headers.get("content-type") ?? "application/json",
  );
  headers.set("accept", request.headers.get("accept") ?? "text/event-stream");
  if (options.upstream === "openrouter") {
    headers.set("http-referer", "https://opencomputer.dev");
    headers.set("x-title", "OpenComputer");
  } else if (options.upstream === "codex") {
    if (!options.chatGptAccountId) {
      return new Response(
        JSON.stringify({ error: { message: "Codex account id is unavailable" } }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
    headers.set("chatgpt-account-id", options.chatGptAccountId);
    // Match OpenCode's dedicated ChatGPT OAuth adapter. A normal OpenAI API
    // request with a ChatGPT access token is not the Codex subscription
    // contract.
    headers.set("originator", CODEX_CLIENT_ORIGINATOR);
    headers.set("user-agent", CODEX_CLIENT_USER_AGENT);
    if (options.sessionId) headers.set("session-id", options.sessionId);
    if (options.codexComputeResidency) {
      headers.set(
        "x-openai-internal-codex-residency",
        options.codexComputeResidency,
      );
    }
    const openAiBeta = request.headers.get("openai-beta");
    if (openAiBeta) headers.set("openai-beta", openAiBeta);
  } else if (options.upstream === "anthropic") {
    headers.set(
      "anthropic-version",
      request.headers.get("anthropic-version") ?? "2023-06-01",
    );
    const requestedBetas = (request.headers.get("anthropic-beta") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    headers.set(
      "anthropic-beta",
      [...new Set([...requestedBetas, ANTHROPIC_OAUTH_BETA])].join(","),
    );
  }
  if (
    options.protocol === "anthropic_messages" &&
    options.upstream === "openrouter"
  ) {
    headers.set(
      "anthropic-version",
      request.headers.get("anthropic-version") ?? "2023-06-01",
    );
    const beta = request.headers.get("anthropic-beta");
    if (beta) headers.set("anthropic-beta", beta);
  }
  const userAgent = request.headers.get("user-agent");
  if (userAgent && options.upstream !== "codex") {
    headers.set("user-agent", userAgent);
  }

  const upstream = await (options.fetch ?? fetch)(
    options.upstreamUrl ??
      (options.upstream === "anthropic"
        ? ANTHROPIC_MESSAGES_URL
        : options.protocol === "responses"
          ? OPENROUTER_RESPONSES_URL
          : options.protocol === "anthropic_messages"
            ? OPENROUTER_MESSAGES_URL
            : OPENROUTER_CHAT_COMPLETIONS_URL),
    {
      method: "POST",
      headers,
      body,
    },
  );
  options.timing?.upstreamResponded?.(upstream.status);
  if (options.upstream === "codex" && !upstream.ok) {
    let errorType: string | undefined;
    let errorCode: string | undefined;
    let errorMessage: string | undefined;
    try {
      const payload = (await upstream.clone().json()) as {
        error?: { type?: unknown; code?: unknown; message?: unknown };
      };
      if (typeof payload.error?.type === "string") errorType = payload.error.type;
      if (typeof payload.error?.code === "string") errorCode = payload.error.code;
      if (typeof payload.error?.message === "string") {
        errorMessage = payload.error.message.slice(0, 240);
      }
    } catch {
      // Non-JSON provider errors are identified by status and content type.
    }
    console.warn("Codex upstream request failed", {
      status: upstream.status,
      contentType: upstream.headers.get("content-type"),
      requestId: upstream.headers.get("x-request-id"),
      errorType,
      errorCode,
      errorMessage,
    });
  }
  if (options.upstream === "anthropic" && !upstream.ok) {
    console.warn("Claude upstream request failed", {
      status: upstream.status,
      contentType: upstream.headers.get("content-type"),
      requestId: upstream.headers.get("request-id"),
    });
  }
  const observed = options.observeResponseModel
    ? await observeResponseModel(
        upstream,
        options.observeResponseModel,
        options.timing?.firstEvent,
      )
    : upstream;
  const responseHeaders = new Headers(observed.headers);
  responseHeaders.delete("set-cookie");
  return new Response(observed.body, {
    status: observed.status,
    statusText: observed.statusText,
    headers: responseHeaders,
  });
}
