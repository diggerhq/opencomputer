import { describe, expect, it } from "vitest";
import { WorkspaceArtifactIntegrityError, type WorkspaceArtifactExport } from "./artifacts.js";
import { OpenComputer } from "./client.js";
import { OpenComputerError } from "./errors.js";

interface Call { method: string; path: string; headers: Record<string, string>; body?: unknown }

function fakeApi(routes: Record<string, (call: Call) => Response | Promise<Response>> = {}) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
    const call: Call = { method: init?.method ?? "GET", path: `${url.pathname}${url.search}`, headers };
    if (typeof init?.body === "string") call.body = JSON.parse(init.body) as unknown;
    calls.push(call);
    const route = routes[`${call.method} ${url.pathname}`];
    if (route) return route(call);
    return Response.json({ error: { code: "not_found", message: `no route ${call.method} ${url.pathname}` } }, { status: 404 });
  };
  return { calls, fetch, last: () => calls[calls.length - 1] };
}

const oc = (api: ReturnType<typeof fakeApi>) => new OpenComputer({ apiKey: "osb_test", fetch: api.fetch });

const record: WorkspaceArtifactExport = {
  id: "aexp_1",
  artifactId: null,
  projectId: "prj_1",
  environment: "development",
  agentId: "worker",
  deploymentId: "dep_1",
  sessionId: "ses_1",
  turnId: null,
  toolCallId: null,
  workspacePath: "/workspace/artifacts/capture.json",
  snapshotId: null,
  mediaType: "application/json",
  bytes: null,
  sha256: null,
  state: "queued",
  error: null,
  idempotencyKeyDigest: `sha256:${"b".repeat(64)}`,
  retention: { manifestRetainedUntil: null, snapshotRetainedUntil: null },
  createdAt: "t",
  updatedAt: "t",
  completedAt: null,
};

const content = new TextEncoder().encode("hello, artifact\n");
const contentSha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

function contentResponse(bytes: Uint8Array, headers: Record<string, string> = {}) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 5));
      controller.enqueue(bytes.slice(5));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": String(bytes.byteLength),
      "x-opencomputer-artifact-id": "art_1",
      "x-opencomputer-export-id": "aexp_1",
      ...headers,
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

describe("oc.sessions.artifacts", () => {
  it("creates an export with the Idempotency-Key header and reports 200 as a replay", async () => {
    const api = fakeApi({
      "POST /api/managed-agents/sessions/ses_1/workspace-artifacts/exports": (call) =>
        Response.json({ export: record }, { status: call.headers["idempotency-key"] === "again" ? 200 : 202 }),
    });
    const created = await oc(api).sessions.artifacts.export({
      sessionId: "ses_1",
      path: "/workspace/artifacts/capture.json",
      mediaType: "application/json",
      expected: { bytes: 16, sha256: "AB".repeat(32) },
      idempotencyKey: "export:ses_1:artifact-001",
    });
    expect(created).toEqual({ export: record, created: true });
    expect(api.last()).toMatchObject({
      method: "POST",
      path: "/api/managed-agents/sessions/ses_1/workspace-artifacts/exports",
      headers: { "x-api-key": "osb_test", "content-type": "application/json", "idempotency-key": "export:ses_1:artifact-001" },
      body: { path: "/workspace/artifacts/capture.json", mediaType: "application/json", expected: { bytes: 16, sha256: "AB".repeat(32) } },
    });
    const replay = await oc(api).sessions.artifacts.export({ sessionId: "ses_1", path: "/workspace/artifacts/capture.json", idempotencyKey: "again" });
    expect(replay.created).toBe(false);
    expect(api.last().body).toEqual({ path: "/workspace/artifacts/capture.json" });
  });

  it("refuses an empty or over-long idempotency key before sending", async () => {
    const api = fakeApi();
    for (const idempotencyKey of ["", "k".repeat(256)]) {
      await expect(
        oc(api).sessions.artifacts.export({ sessionId: "ses_1", path: "/workspace/artifacts/a", idempotencyKey }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(api.calls).toHaveLength(0);
  });

  it("surfaces the documented conflict and validation errors with their codes", async () => {
    const api = fakeApi({
      "POST /api/managed-agents/sessions/ses_1/workspace-artifacts/exports": () =>
        Response.json({ error: { code: "export_idempotency_conflict", message: "key reused", retrySafe: false } }, { status: 409 }),
      "GET /api/managed-agents/workspace-artifact-exports/aexp_1/content": () =>
        Response.json({ error: { code: "export_not_ready", message: "not yet", retrySafe: true } }, { status: 409 }),
    });
    const conflict = await oc(api).sessions.artifacts
      .export({ sessionId: "ses_1", path: "/workspace/artifacts/other.json", idempotencyKey: "k" })
      .catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(OpenComputerError);
    expect(conflict).toMatchObject({ status: 409, code: "export_idempotency_conflict", retrySafe: false });
    const notReady = await oc(api).sessions.artifacts.download("aexp_1").catch((e: unknown) => e);
    expect(notReady).toMatchObject({ status: 409, code: "export_not_ready", retrySafe: true });
  });

  it("inspects, lists and cancels on the documented routes", async () => {
    const api = fakeApi({
      "GET /api/managed-agents/workspace-artifact-exports/aexp_1": () => Response.json({ export: record }),
      "GET /api/managed-agents/sessions/ses_1/workspace-artifacts/exports": () => Response.json({ exports: [record, { ...record, id: "aexp_2" }] }),
      "POST /api/managed-agents/workspace-artifact-exports/aexp_1/cancel": () => Response.json({ export: { ...record, state: "cancelled" } }),
    });
    const client = oc(api);
    expect(await client.sessions.artifacts.get("aexp_1")).toEqual(record);
    expect((await client.sessions.artifacts.list("ses_1")).map((e) => e.id)).toEqual(["aexp_1", "aexp_2"]);
    expect((await client.sessions.artifacts.cancel("aexp_1")).state).toBe("cancelled");
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/managed-agents/workspace-artifact-exports/aexp_1",
      "GET /api/managed-agents/sessions/ses_1/workspace-artifacts/exports",
      "POST /api/managed-agents/workspace-artifact-exports/aexp_1/cancel",
    ]);
  });

  it("rejects a record that is not the documented shape", async () => {
    const api = fakeApi({
      "GET /api/managed-agents/workspace-artifact-exports/aexp_1": () => Response.json({ export: { ...record, retention: undefined } }),
    });
    await expect(oc(api).sessions.artifacts.get("aexp_1")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("polls until a terminal state and returns that record", async () => {
    const states = ["queued", "snapshotting", "delivering", "delivered"];
    let n = 0;
    const api = fakeApi({
      "GET /api/managed-agents/workspace-artifact-exports/aexp_1": () => Response.json({ export: { ...record, state: states[n++] } }),
    });
    const done = await oc(api).sessions.artifacts.waitUntilTerminal("aexp_1", { pollIntervalMs: 1 });
    expect(done.state).toBe("delivered");
    expect(api.calls).toHaveLength(4);
  });

  it("stops polling when the signal aborts, and refuses to start when already aborted", async () => {
    const api = fakeApi({
      "GET /api/managed-agents/workspace-artifact-exports/aexp_1": () => Response.json({ export: record }),
    });
    const controller = new AbortController();
    const waiting = oc(api).sessions.artifacts.waitUntilTerminal("aexp_1", { signal: controller.signal, pollIntervalMs: 60_000 });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(api.calls).toHaveLength(1);

    const aborted = AbortSignal.abort();
    await expect(oc(api).sessions.artifacts.waitUntilTerminal("aexp_1", { signal: aborted })).rejects.toMatchObject({ name: "AbortError" });
    expect(api.calls).toHaveLength(1);
  });

  it("downloads the exact bytes with the header metadata and verifies the digest by default", async () => {
    const sha256 = await contentSha256(content);
    const api = fakeApi({
      "GET /api/managed-agents/workspace-artifact-exports/aexp_1/content": () =>
        contentResponse(content, { "x-opencomputer-artifact-sha256": sha256.toUpperCase() }),
    });
    const download = await oc(api).sessions.artifacts.download("aexp_1");
    expect(download).toMatchObject({ bytes: content.byteLength, sha256, mediaType: "application/json", artifactId: "art_1", exportId: "aexp_1" });
    expect(await readAll(download.stream)).toEqual(content);
    expect(api.last().headers.accept).toBe("*/*");
    expect(api.last().headers["x-api-key"]).toBe("osb_test");
  });

  it("fails the stream with a typed error when the bytes do not match the digest", async () => {
    const api = fakeApi({
      "GET /api/managed-agents/workspace-artifact-exports/aexp_1/content": () =>
        contentResponse(content, { "x-opencomputer-artifact-sha256": "0".repeat(64) }),
    });
    const download = await oc(api).sessions.artifacts.download("aexp_1");
    const failure = await readAll(download.stream).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(WorkspaceArtifactIntegrityError);
    expect(failure).toMatchObject({ code: "artifact_digest_mismatch", exportId: "aexp_1", expected: "0".repeat(64) });
  });

  it("fails the stream when fewer bytes arrive than Content-Length announced", async () => {
    const sha256 = await contentSha256(content);
    const api = fakeApi({
      "GET /api/managed-agents/workspace-artifact-exports/aexp_1/content": () =>
        contentResponse(content, { "x-opencomputer-artifact-sha256": sha256, "content-length": String(content.byteLength + 1) }),
    });
    const download = await oc(api).sessions.artifacts.download("aexp_1");
    const failure = await readAll(download.stream).catch((e: unknown) => e);
    expect(failure).toMatchObject({ name: "WorkspaceArtifactIntegrityError", code: "artifact_size_mismatch" });
  });

  it("passes the bytes through unverified when asked", async () => {
    const api = fakeApi({
      "GET /api/managed-agents/workspace-artifact-exports/aexp_1/content": () =>
        contentResponse(content, { "x-opencomputer-artifact-sha256": "0".repeat(64) }),
    });
    const download = await oc(api).sessions.artifacts.download("aexp_1", { verify: false });
    expect(await readAll(download.stream)).toEqual(content);
  });

  it("refuses a content response that lacks the artifact headers, a body, or redirects", async () => {
    const emptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const api = fakeApi({
      "GET /api/managed-agents/workspace-artifact-exports/aexp_1/content": () =>
        new Response(content, { status: 200, headers: { "content-length": String(content.byteLength) } }),
      "GET /api/managed-agents/workspace-artifact-exports/aexp_2/content": () =>
        new Response(null, { status: 302, headers: { location: "https://storage.example/signed" } }),
      "GET /api/managed-agents/workspace-artifact-exports/aexp_3/content": () =>
        new Response(null, {
          status: 200,
          headers: {
            "content-length": "0",
            "x-opencomputer-artifact-sha256": emptySha256,
            "x-opencomputer-artifact-id": "art_3",
            "x-opencomputer-export-id": "aexp_3",
          },
        }),
    });
    await expect(oc(api).sessions.artifacts.download("aexp_1")).rejects.toMatchObject({ code: "invalid_response" });
    await expect(oc(api).sessions.artifacts.download("aexp_2")).rejects.toMatchObject({ code: "redirected" });
    await expect(oc(api).sessions.artifacts.download("aexp_3")).rejects.toMatchObject({
      code: "invalid_response",
      message: expect.stringContaining("no body"),
    });
  });
});
