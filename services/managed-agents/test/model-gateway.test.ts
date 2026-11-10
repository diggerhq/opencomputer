import { describe, expect, it, vi } from "vitest";

import {
  codexAccountId,
  codexComputeResidency,
} from "../src/connections/codex.js";
import { codexUsageLimited, proxyModelRequest } from "../src/edge/model-gateway.js";

describe("runtime model gateway", () => {
  it("replaces the scoped token and preserves the upstream response stream", async () => {
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    let forwarded: RequestInit | undefined;
    const upstreamFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        forwarded = init;
        return new Response(upstreamBody, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "set-cookie": "provider-cookie=secret",
          },
        });
      },
    );
    const request = new Request(
      "https://edge.test/v1/sessions/ses_1/model-gateway/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer scoped-runtime-token",
          "content-type": "application/json",
          cookie: "runtime-cookie=secret",
          "cf-connecting-ip": "192.0.2.1",
        },
        body: JSON.stringify({
          model: "openai/gpt-5.2",
          stream: true,
          user: "runtime-controlled-value",
        }),
      },
    );

    const response = await proxyModelRequest(request, {
      apiKey: "provider-secret",
      customerId: "org_123",
      fetch: upstreamFetch,
      protocol: "chat_completions",
      upstream: "openrouter",
    });

    expect(upstreamFetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.any(Object),
    );
    const headers = new Headers(forwarded?.headers);
    expect(headers.get("authorization")).toBe("Bearer provider-secret");
    expect(headers.get("authorization")).not.toContain("scoped-runtime-token");
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("cf-connecting-ip")).toBe(false);
    expect(JSON.parse(String(forwarded?.body))).toEqual({
      model: "openai/gpt-5.2",
      stream: true,
      user: "org_123",
    });
    expect(response.body).toBe(upstreamBody);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.has("set-cookie")).toBe(false);
    await expect(response.text()).resolves.toBe(
      "data: first\n\ndata: [DONE]\n\n",
    );
  });

  it("observes a routed model from split SSE metadata without changing the stream", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"id":"gen_1","mod',
      'el":"google/gemini-3.1-pro","choices":[]}\n\n',
      "data: [DONE]\n\n",
    ];
    const observed: string[] = [];
    const response = await proxyModelRequest(
      new Request("https://edge.test/model-gateway/api/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "typesafe/jev-router",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        }),
      }),
      {
        apiKey: "managed-openrouter-key",
        customerId: "org_123",
        protocol: "chat_completions",
        upstream: "openrouter",
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const chunk of chunks) {
                  controller.enqueue(encoder.encode(chunk));
                }
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        observeResponseModel(model) {
          observed.push(model);
        },
      },
    );

    expect(observed).toEqual(["google/gemini-3.1-pro"]);
    await expect(response.text()).resolves.toBe(chunks.join(""));
  });

  it("observes a routed model nested in a Responses SSE event", async () => {
    const event =
      'data: {"type":"response.created","response":{"model":"openai/gpt-6-sol"}}\n\n';
    const observed: string[] = [];
    const response = await proxyModelRequest(
      new Request("https://edge.test/model-gateway/api/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "typesafe/jev-router", stream: true }),
      }),
      {
        apiKey: "managed-openrouter-key",
        customerId: "org_123",
        protocol: "responses",
        upstream: "openrouter",
        fetch: async () =>
          new Response(event, {
            headers: { "content-type": "text/event-stream" },
          }),
        observeResponseModel(model) {
          observed.push(model);
        },
      },
    );

    expect(observed).toEqual(["openai/gpt-6-sol"]);
    await expect(response.text()).resolves.toBe(event);
  });

  it("releases an SSE response after its first data event has no model", async () => {
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'),
        );
      },
    });
    const observed: string[] = [];
    const response = await proxyModelRequest(
      new Request("https://edge.test/model-gateway/api/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "typesafe/jev-router", stream: true }),
      }),
      {
        apiKey: "managed-openrouter-key",
        customerId: "org_123",
        protocol: "chat_completions",
        upstream: "openrouter",
        fetch: async () =>
          new Response(upstream, {
            headers: { "content-type": "text/event-stream" },
          }),
        observeResponseModel(model) {
          observed.push(model);
        },
      },
    );

    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("Hello");
    expect(observed).toEqual([]);
    await reader.cancel();
  });

  it("observes a routed model from a JSON response without changing the body", async () => {
    const payload = {
      id: "gen_2",
      model: "anthropic/claude-sonnet-4.6",
      choices: [{ message: { role: "assistant", content: "Hello" } }],
    };
    let observed: string | undefined;
    const response = await proxyModelRequest(
      new Request("https://edge.test/model-gateway/api/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "typesafe/jev-router",
          messages: [{ role: "user", content: "Hello" }],
        }),
      }),
      {
        apiKey: "managed-openrouter-key",
        customerId: "org_123",
        protocol: "chat_completions",
        upstream: "openrouter",
        fetch: async () => Response.json(payload),
        observeResponseModel(model) {
          observed = model;
        },
      },
    );

    expect(observed).toBe("anthropic/claude-sonnet-4.6");
    await expect(response.json()).resolves.toEqual(payload);
  });

  it("uses an OpenAI-native model id for a Codex subscription upstream", async () => {
    let forwarded: RequestInit | undefined;
    const request = new Request(
      "https://edge.test/v1/sessions/ses_1/model-gateway/api/v1/responses",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5",
          input: "Hello",
          stream: true,
          max_output_tokens: 128_000,
        }),
      },
    );

    await proxyModelRequest(request, {
      apiKey: "codex-subscription-token",
      customerId: "org_123",
      protocol: "responses",
      upstream: "codex",
      upstreamUrl: "https://chatgpt.com/backend-api/codex/responses",
      chatGptAccountId: "chatgpt-account-123",
      codexComputeResidency: "us",
      sessionId: "ses_1",
      fetch: async (_input, init) => {
        forwarded = init;
        return new Response(null, { status: 200 });
      },
    });

    expect(JSON.parse(String(forwarded?.body))).toEqual({
      model: "gpt-5",
      input: "Hello",
      stream: true,
    });
    const headers = new Headers(forwarded?.headers);
    expect(headers.get("chatgpt-account-id")).toBe("chatgpt-account-123");
    expect(headers.get("originator")).toBe("opencode");
    expect(headers.get("user-agent")).toBe("opencode/0.0.0-next-17055");
    expect(headers.get("session-id")).toBe("ses_1");
    expect(headers.get("x-openai-internal-codex-residency")).toBe("us");
    expect(headers.has("version")).toBe(false);
    expect(headers.has("x-title")).toBe(false);
  });

  it.each([
    [429, { error: { type: "usage_limit_reached", resets_at: 1792513800, plan_type: "plus" } }, true],
    // A transient rate limit is not the plan's limit: it passes through to the agent.
    [429, { error: { type: "rate_limit_exceeded", code: "rate_limit_exceeded" } }, false],
    [429, "Too Many Requests", false],
    [500, { error: { type: "usage_limit_reached" } }, false],
  ] as const)("reads a Codex %i with %j as the plan's usage limit: %s", async (status, body, limited) => {
    const response = await proxyModelRequest(
      new Request("https://edge.test/model-gateway/api/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hi" }),
      }),
      {
        apiKey: "codex-subscription-token",
        customerId: "acct_1",
        protocol: "responses",
        upstream: "codex",
        upstreamUrl: "https://chatgpt.com/backend-api/codex/responses",
        chatGptAccountId: "workspace-123",
        fetch: async () =>
          new Response(typeof body === "string" ? body : JSON.stringify(body), {
            status,
            headers: { "content-type": typeof body === "string" ? "text/plain" : "application/json" },
          }),
      },
    );
    expect(await codexUsageLimited(response)).toBe(limited);
    // Read from a clone: a response passed through still has its body.
    expect(await response.text()).toBe(typeof body === "string" ? body : JSON.stringify(body));
  });

  it("keeps the OpenRouter catalog slug on managed Responses fallback", async () => {
    let target = "";
    let forwarded: RequestInit | undefined;
    await proxyModelRequest(
      new Request("https://edge.test/model-gateway/api/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5", input: "Hello", stream: true }),
      }),
      {
        apiKey: "managed-openrouter-key",
        customerId: "org_123",
        protocol: "responses",
        upstream: "openrouter",
        upstreamModel: "openai/gpt-5",
        fetch: async (input, init) => {
          target = String(input);
          forwarded = init;
          return new Response(null, { status: 200 });
        },
      },
    );

    expect(target).toBe("https://openrouter.ai/api/v1/responses");
    expect(JSON.parse(String(forwarded?.body))).toEqual({
      model: "openai/gpt-5",
      input: "Hello",
      stream: true,
      user: "org_123",
    });
  });

  it("rewrites the model at the private gateway for an OpenAI-compatible route", async () => {
    let target = "";
    let forwarded: RequestInit | undefined;
    await proxyModelRequest(
      new Request("https://edge.test/model-gateway/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer session-scoped-token",
          cookie: "must-not-leak=true",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          messages: [{ role: "user", content: "Hello" }],
        }),
      }),
      {
        apiKey: "scx-secret-key",
        customerId: "org_123",
        protocol: "chat_completions",
        upstream: "openai_compatible",
        upstreamUrl: "https://api.scx.ai/v1/chat/completions",
        upstreamModel: "GLM-5.3",
        fetch: async (input, init) => {
          target = String(input);
          forwarded = init;
          return new Response(null, { status: 200 });
        },
      },
    );

    expect(target).toBe("https://api.scx.ai/v1/chat/completions");
    expect(JSON.parse(String(forwarded?.body))).toEqual({
      model: "GLM-5.3",
      messages: [{ role: "user", content: "Hello" }],
    });
    const headers = new Headers(forwarded?.headers);
    expect(headers.get("authorization")).toBe("Bearer scx-secret-key");
    expect(headers.get("authorization")).not.toContain("session-scoped-token");
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("http-referer")).toBe(false);
    expect(headers.has("x-title")).toBe(false);
    expect(headers.has("anthropic-version")).toBe(false);
  });

  it("uses the Claude OAuth bearer contract for Anthropic Messages", async () => {
    let target = "";
    let forwarded: RequestInit | undefined;
    await proxyModelRequest(
      new Request("https://edge.test/model-gateway/api/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 64,
          messages: [{ role: "user", content: "Hello" }],
        }),
      }),
      {
        apiKey: "claude-setup-token",
        customerId: "org_123",
        protocol: "anthropic_messages",
        upstream: "anthropic",
        fetch: async (input, init) => {
          target = String(input);
          forwarded = init;
          return new Response(null, { status: 200 });
        },
      },
    );

    expect(target).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(forwarded?.headers);
    expect(headers.get("authorization")).toBe("Bearer claude-setup-token");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
    expect(headers.get("anthropic-beta")).toContain(
      "prompt-caching-2024-07-31",
    );
    expect(JSON.parse(String(forwarded?.body))).not.toHaveProperty("user");
  });

  it("keeps Anthropic Messages shape on managed fallback", async () => {
    let target = "";
    let forwarded: RequestInit | undefined;
    await proxyModelRequest(
      new Request("https://edge.test/model-gateway/api/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 64,
          messages: [{ role: "user", content: "Hello" }],
        }),
      }),
      {
        apiKey: "managed-openrouter-key",
        customerId: "org_123",
        protocol: "anthropic_messages",
        upstream: "openrouter",
        upstreamModel: "anthropic/claude-sonnet-4-6",
        fetch: async (input, init) => {
          target = String(input);
          forwarded = init;
          return new Response(null, { status: 200 });
        },
      },
    );

    expect(target).toBe("https://openrouter.ai/api/v1/messages");
    expect(JSON.parse(String(forwarded?.body))).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      max_tokens: 64,
      messages: [{ role: "user", content: "Hello" }],
    });
  });

  it("extracts the ChatGPT workspace id from the OAuth access token", () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "workspace-123",
        },
      }),
    ).toString("base64url");
    expect(codexAccountId(`header.${payload}.signature`)).toBe("workspace-123");
    expect(codexAccountId("not-a-jwt")).toBeNull();
  });

  it("extracts an advertised ChatGPT compute residency", () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_compute_residency: "us",
        },
      }),
    ).toString("base64url");
    expect(codexComputeResidency(`header.${payload}.signature`)).toBe("us");
    expect(codexComputeResidency("not-a-jwt")).toBeNull();
  });
});
