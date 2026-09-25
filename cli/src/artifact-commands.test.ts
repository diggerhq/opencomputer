import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { OpenComputerClient, type WorkspaceArtifactExport } from "./api.js";
import {
  artifactExportFailure,
  createArtifactExport,
  downloadArtifactExportToFile,
  parseArtifactExportOptions,
  streamArtifactExport,
  waitForArtifactExport,
} from "./artifact-commands.js";
import { CLIError } from "./errors.js";

const config = { apiUrl: "https://app.opencomputer.dev", apiKey: "test" };

function route(input: string | URL | Request): string {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return `${url.pathname}${url.search}`;
}

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
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
  completedAt: null,
};

const content = Buffer.from("hello, artifact\u0000\u00ff\n", "latin1");
const contentSha256 = createHash("sha256").update(content).digest("hex");

function contentResponse(headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(content.subarray(0, 4)));
      controller.enqueue(new Uint8Array(content.subarray(4)));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": String(content.byteLength),
      "x-opencomputer-artifact-sha256": contentSha256,
      "x-opencomputer-artifact-id": "art_1",
      "x-opencomputer-export-id": "aexp_1",
      ...headers,
    },
  });
}

test("export options are validated before any request", () => {
  const request = parseArtifactExportOptions({
    sessionId: "ses_1",
    path: "/workspace/artifacts/capture.json",
    mediaType: "application/json",
    expectedSha256: "AB".repeat(32),
    expectedBytes: "18422",
    wait: true,
  });
  assert.deepEqual(request, {
    sessionId: "ses_1",
    path: "/workspace/artifacts/capture.json",
    mediaType: "application/json",
    expected: { bytes: 18422, sha256: "ab".repeat(32) },
    wait: true,
  });
  assert.deepEqual(
    parseArtifactExportOptions({ sessionId: "ses_1", path: "/workspace/artifacts/a", wait: false }),
    { sessionId: "ses_1", path: "/workspace/artifacts/a", wait: false },
  );
  assert.throws(() => parseArtifactExportOptions({ path: "/workspace/artifacts/a", wait: false }), /--session/);
  assert.throws(() => parseArtifactExportOptions({ sessionId: "ses_1", wait: false }), /--path/);
  assert.throws(
    () => parseArtifactExportOptions({ sessionId: "ses_1", path: "artifacts/a", wait: false }),
    /absolute/,
  );
  assert.throws(
    () => parseArtifactExportOptions({ sessionId: "ses_1", path: "/workspace/artifacts/a", expectedSha256: "abc", wait: false }),
    /--expected-sha256/,
  );
  assert.throws(
    () => parseArtifactExportOptions({ sessionId: "ses_1", path: "/workspace/artifacts/a", expectedBytes: "-1", wait: false }),
    /--expected-bytes/,
  );
});

test("export sends the documented body with an Idempotency-Key and reports 202 as created", async (context) => {
  const requests: Array<{ path: string; method: string; headers: Headers; body: unknown }> = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      path: route(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Response.json({ export: record }, { status: requests.length === 1 ? 202 : 200 });
  });

  const request = parseArtifactExportOptions({
    sessionId: "ses_1",
    path: "/workspace/artifacts/capture.json",
    expectedBytes: "16",
    wait: false,
  });
  const created = await createArtifactExport(new OpenComputerClient(config), request);
  assert.deepEqual(created, { created: true, export: record });
  assert.equal(requests[0]?.path, "/api/managed-agents/sessions/ses_1/workspace-artifacts/exports");
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0]?.headers.get("x-api-key"), "test");
  assert.match(requests[0]?.headers.get("idempotency-key") ?? "", /^[0-9a-f-]{36}$/);
  assert.deepEqual(requests[0]?.body, { path: "/workspace/artifacts/capture.json", expected: { bytes: 16 } });

  // The CLI-wide --idempotency-key is the project-scoped key the API
  // compares, so it goes on the wire as given: repeating it replays, and
  // reusing it for another session is the API's conflict, not a new export.
  const keyed = new OpenComputerClient(config, "artifact-001");
  const replay = await createArtifactExport(keyed, request);
  assert.equal(replay.created, false);
  assert.equal(requests[1]?.headers.get("idempotency-key"), "artifact-001");
  await createArtifactExport(keyed, { ...request, sessionId: "ses_2" });
  assert.equal(requests[2]?.path, "/api/managed-agents/sessions/ses_2/workspace-artifacts/exports");
  assert.equal(requests[2]?.headers.get("idempotency-key"), "artifact-001");
});

test("export names an idempotency conflict and passes other API errors through", async (context) => {
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const path = route(input);
    if (path.endsWith("/ses_conflict/workspace-artifacts/exports")) {
      return Response.json(
        { error: { code: "export_idempotency_conflict", message: "reused", retrySafe: false } },
        { status: 409 },
      );
    }
    return Response.json(
      { error: { code: "path_outside_workspace", message: "not under /workspace/artifacts", retrySafe: false } },
      { status: 400 },
    );
  });
  const client = new OpenComputerClient(config, "artifact-001");
  await assert.rejects(
    createArtifactExport(client, { sessionId: "ses_conflict", path: "/workspace/artifacts/a", wait: false }),
    (error: unknown) =>
      error instanceof CLIError &&
      error.code === "export_idempotency_conflict" &&
      /new --idempotency-key/.test(error.hint),
  );
  await assert.rejects(
    createArtifactExport(client, { sessionId: "ses_1", path: "/workspace/other", wait: false }),
    (error: unknown) =>
      error instanceof Error && !(error instanceof CLIError) && /not under/.test(error.message),
  );
});

test("waiting polls the manifest until a terminal state", async (context) => {
  const states = ["queued", "snapshotting", "delivering", "delivered"];
  const paths: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    paths.push(route(input));
    return Response.json({ export: { ...record, state: states[paths.length - 1] } });
  });
  const done = await waitForArtifactExport(new OpenComputerClient(config), "aexp_1", { pollIntervalMs: 1 });
  assert.equal(done.state, "delivered");
  assert.deepEqual(paths, Array<string>(4).fill("/api/managed-agents/workspace-artifact-exports/aexp_1"));
});

test("aborting while a poll is in flight rejects without waiting for it", async (context) => {
  const controller = new AbortController();
  context.mock.method(globalThis, "fetch", (_input: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      setTimeout(() => controller.abort(new Error("operator stopped waiting")), 5);
    });
  });
  await assert.rejects(
    waitForArtifactExport(new OpenComputerClient(config), "aexp_1", { signal: controller.signal }),
    /operator stopped waiting/,
  );
});

test("waiting gives up at the deadline with the export it last saw", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({ export: record }));
  await assert.rejects(
    waitForArtifactExport(new OpenComputerClient(config), "aexp_1", { pollIntervalMs: 1, timeoutMs: 0 }),
    (error: unknown) => error instanceof CLIError && error.code === "export_wait_timeout",
  );
});

test("a failed export becomes an error carrying its own code", () => {
  const failed = artifactExportFailure({
    ...record,
    state: "failed",
    error: { code: "artifact_too_large", message: "512 MiB limit", retrySafe: false },
  });
  assert.equal(failed.code, "artifact_too_large");
  assert.match(failed.message, /512 MiB limit/);
  assert.match(failed.hint, /new --idempotency-key/);
  const transient = artifactExportFailure({
    ...record,
    state: "failed",
    error: { code: "destination_unavailable", message: "storage down", retrySafe: true },
  });
  assert.match(transient.hint, /new --idempotency-key/);
  assert.doesNotMatch(transient.hint, /same --idempotency-key is safe/);
  const cancelled = artifactExportFailure({ ...record, state: "cancelled" });
  assert.equal(cancelled.code, "export_cancelled");
});

test("download writes the exact bytes to the file only after the digest checks out", async (context) => {
  const paths: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    paths.push(route(input));
    assert.equal(new Headers(init?.headers).get("x-api-key"), "test");
    return contentResponse();
  });
  const directory = await mkdtemp(join(tmpdir(), "opencomputer-artifact-"));
  try {
    const output = join(directory, "capture.json");
    const result = await downloadArtifactExportToFile(new OpenComputerClient(config), "aexp_1", output);
    assert.deepEqual(result, {
      exportId: "aexp_1",
      artifactId: "art_1",
      mediaType: "application/json",
      bytes: content.byteLength,
      sha256: contentSha256,
    });
    assert.deepEqual(await readFile(output), content);
    assert.deepEqual(await readdir(directory), ["capture.json"]);
    assert.deepEqual(paths, ["/api/managed-agents/workspace-artifact-exports/aexp_1/content"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("download leaves no file behind when the digest or size does not match", async (context) => {
  let response: Response = contentResponse({ "x-opencomputer-artifact-sha256": "0".repeat(64) });
  context.mock.method(globalThis, "fetch", async () => response);
  const directory = await mkdtemp(join(tmpdir(), "opencomputer-artifact-"));
  try {
    const output = join(directory, "capture.json");
    // Someone else's leftover is not this download's to remove.
    await writeFile(`${output}.part`, "earlier attempt");
    await assert.rejects(
      downloadArtifactExportToFile(new OpenComputerClient(config), "aexp_1", output),
      (error: unknown) => error instanceof CLIError && error.code === "artifact_digest_mismatch",
    );
    await assert.rejects(access(output));
    assert.deepEqual(await readdir(directory), ["capture.json.part"]);
    assert.equal(await readFile(`${output}.part`, "utf8"), "earlier attempt");
    await rm(`${output}.part`);

    response = contentResponse({ "content-length": String(content.byteLength + 3) });
    await assert.rejects(
      downloadArtifactExportToFile(new OpenComputerClient(config), "aexp_1", output),
      (error: unknown) => error instanceof CLIError && error.code === "artifact_size_mismatch",
    );
    await assert.rejects(access(output));
    assert.deepEqual(await readdir(directory), []);

    // A missing output directory is an ordinary rejection, even when the
    // content response takes longer to arrive than the file takes to fail
    // to open.
    response = contentResponse();
    context.mock.method(
      globalThis,
      "fetch",
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(response), 20)),
    );
    await assert.rejects(
      downloadArtifactExportToFile(new OpenComputerClient(config), "aexp_1", join(directory, "missing", "capture.json")),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("download refuses a content response without the artifact headers, a redirect, or a not-ready export", async (context) => {
  let response: Response = new Response(content, {
    status: 200,
    headers: { "content-length": String(content.byteLength) },
  });
  context.mock.method(globalThis, "fetch", async () => response);
  const client = new OpenComputerClient(config);
  await assert.rejects(streamArtifactExport(client, "aexp_1", new PassThrough()), /x-opencomputer-artifact-sha256/);

  response = new Response(null, { status: 302, headers: { location: "https://storage.example/signed" } });
  await assert.rejects(streamArtifactExport(client, "aexp_1", new PassThrough()), /302/);

  response = Response.json(
    { error: { code: "export_not_ready", message: "still snapshotting", retrySafe: true } },
    { status: 409 },
  );
  await assert.rejects(
    streamArtifactExport(client, "aexp_1", new PassThrough()),
    (error: unknown) => error instanceof Error && /still snapshotting/.test(error.message),
  );
});

test("streaming to a sink that stays open hashes the bytes and does not end it", async (context) => {
  context.mock.method(globalThis, "fetch", async () => contentResponse());
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on("data", (chunk: Buffer) => chunks.push(chunk));
  const result = await streamArtifactExport(new OpenComputerClient(config), "aexp_1", sink, { end: false });
  assert.equal(result.sha256, contentSha256);
  assert.deepEqual(Buffer.concat(chunks), content);
  assert.equal(sink.writableEnded, false);
});
