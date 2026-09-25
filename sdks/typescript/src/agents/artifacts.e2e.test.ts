// Live check of workspace artifact exports against a deployed control plane.
// Skipped unless OPENCOMPUTER_BASE_URL and OPENCOMPUTER_API_KEY are set.
//
//   OPENCOMPUTER_BASE_URL=https://<stack>/api/managed-agents \
//   OPENCOMPUTER_API_KEY=osb_... \
//   OPENCOMPUTER_E2E_AGENT_ID=worker@development \
//   npx vitest run src/agents/artifacts.e2e.test.ts
//
// With OPENCOMPUTER_E2E_AGENT_ID the test starts a session and asks the agent
// to write a file of known content under /workspace/artifacts/, so the digest
// can be checked independently of anything the API reports. Alternatively
// point OPENCOMPUTER_E2E_SESSION_ID and OPENCOMPUTER_E2E_ARTIFACT_PATH at a
// session that already holds the file (and OPENCOMPUTER_E2E_ARTIFACT_SHA256 at
// its digest if you know it). Covers acceptance tests 1, 5 and 6 of the
// artifact export feature request: exact bytes and SHA-256, same-key replay
// is one export, same key with a changed request is a conflict.

import { beforeAll, describe, expect, it } from "vitest";
import { OpenComputer } from "./client.js";
import { OpenComputerError } from "./errors.js";
import type { WorkspaceArtifactExport } from "./artifacts.js";

const env = process.env;
const baseUrl = env.OPENCOMPUTER_BASE_URL;
const apiKey = env.OPENCOMPUTER_API_KEY;
const live = Boolean(baseUrl && apiKey);

const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

interface Fixture {
  sessionId: string;
  path: string;
  /** Known when the test wrote the file itself or the operator supplied it. */
  sha256?: string;
  bytes?: number;
}

async function prepareFixture(oc: OpenComputer): Promise<Fixture> {
  if (env.OPENCOMPUTER_E2E_SESSION_ID && env.OPENCOMPUTER_E2E_ARTIFACT_PATH) {
    return {
      sessionId: env.OPENCOMPUTER_E2E_SESSION_ID,
      path: env.OPENCOMPUTER_E2E_ARTIFACT_PATH,
      sha256: env.OPENCOMPUTER_E2E_ARTIFACT_SHA256?.toLowerCase(),
    };
  }
  const agentId = env.OPENCOMPUTER_E2E_AGENT_ID;
  if (!agentId) {
    throw new Error(
      "Set OPENCOMPUTER_E2E_AGENT_ID (to start a session) or OPENCOMPUTER_E2E_SESSION_ID + OPENCOMPUTER_E2E_ARTIFACT_PATH.",
    );
  }
  const runId = `artifact-e2e-${Date.now().toString(36)}`;
  const text = `artifact export e2e ${runId}\nline two\n`;
  const bytes = new TextEncoder().encode(text);
  const path = `/workspace/artifacts/${runId}.txt`;
  const { session } = await oc.sessions.create(
    { agentId, source: "api", labels: { purpose: "artifact-e2e" } },
    { idempotencyKey: `${runId}/session` },
  );
  const turn = await oc.sessions.turns.send(session.id, {
    input:
      `Create the directory /workspace/artifacts if needed, then write a file at exactly ${path} ` +
      `whose entire content is the following text between the markers, with no other bytes ` +
      `(the text ends with a newline after "line two"):\n<<<\n${text}>>>\n` +
      "Do not add a trailing newline beyond the one shown. Reply with just 'done' when the file is written.",
    idempotencyKey: `${runId}/write`,
  });
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const current = await oc.sessions.get(session.id);
    const status = current.turns.find((t) => t.id === turn.turnId)?.status;
    if (status === "completed") break;
    if (status === "failed" || status === "cancelled") throw new Error(`fixture turn ${status}`);
    if (Date.now() > deadline) throw new Error("fixture turn did not complete in 5 minutes");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return { sessionId: session.id, path, sha256: await sha256Hex(bytes), bytes: bytes.byteLength };
}

describe.skipIf(!live)("workspace artifact exports (live)", () => {
  const runKey = `artifact-e2e-${Date.now().toString(36)}`;
  let oc: OpenComputer;
  let fixture: Fixture;
  let delivered: WorkspaceArtifactExport;

  beforeAll(() => {
    oc = new OpenComputer({ apiKey: apiKey ?? "", baseUrl });
  });

  it("exports a known file and the downloaded bytes match their SHA-256 independently", async () => {
    fixture = await prepareFixture(oc);
    const first = await oc.sessions.artifacts.export({
      sessionId: fixture.sessionId,
      path: fixture.path,
      mediaType: "text/plain",
      idempotencyKey: runKey,
    });
    expect(first.created).toBe(true);
    expect(first.export.sessionId).toBe(fixture.sessionId);
    expect(first.export.workspacePath).toBe(fixture.path);
    expect(first.export.turnId).toBeNull();
    expect(first.export.toolCallId).toBeNull();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5 * 60_000);
    try {
      delivered = await oc.sessions.artifacts.waitUntilTerminal(first.export.id, {
        signal: controller.signal,
        pollIntervalMs: 1_000,
      });
    } finally {
      clearTimeout(timer);
    }
    expect(delivered.state, JSON.stringify(delivered.error)).toBe("delivered");
    expect(delivered.artifactId).toBeTypeOf("string");
    expect(delivered.sha256).toMatch(/^[0-9a-f]{64}$/);

    const download = await oc.sessions.artifacts.download(delivered.id);
    const bytes = await collect(download.stream);
    const digest = await sha256Hex(bytes);
    expect(bytes.byteLength).toBe(download.bytes);
    expect(download.bytes).toBe(delivered.bytes);
    expect(digest).toBe(download.sha256);
    expect(digest).toBe(delivered.sha256);
    expect(download.artifactId).toBe(delivered.artifactId);
    expect(download.exportId).toBe(delivered.id);
    expect(download.mediaType).toBe("text/plain");
    if (fixture.sha256) expect(digest).toBe(fixture.sha256);
    if (fixture.bytes !== undefined) expect(bytes.byteLength).toBe(fixture.bytes);

    const listed = await oc.sessions.artifacts.list(fixture.sessionId);
    expect(listed.map((e) => e.id)).toContain(delivered.id);
    const inspected = await oc.sessions.artifacts.get(delivered.id);
    expect(inspected).toEqual(delivered);
  }, 15 * 60_000);

  it("replays the same key and request as the same export", async () => {
    const replay = await oc.sessions.artifacts.export({
      sessionId: fixture.sessionId,
      path: fixture.path,
      mediaType: "text/plain",
      idempotencyKey: runKey,
    });
    expect(replay.created).toBe(false);
    expect(replay.export.id).toBe(delivered.id);
    expect(replay.export.idempotencyKeyDigest).toBe(delivered.idempotencyKeyDigest);
    const listed = await oc.sessions.artifacts.list(fixture.sessionId);
    expect(listed.filter((e) => e.idempotencyKeyDigest === delivered.idempotencyKeyDigest)).toHaveLength(1);
  }, 60_000);

  it("rejects the same key with a changed path or digest as export_idempotency_conflict", async () => {
    for (const changed of [
      { path: `${fixture.path}.other` },
      { expected: { sha256: "0".repeat(64) } },
      { mediaType: "application/octet-stream" },
    ]) {
      await expect(
        oc.sessions.artifacts.export({
          sessionId: fixture.sessionId,
          path: fixture.path,
          mediaType: "text/plain",
          idempotencyKey: runKey,
          ...changed,
        }),
      ).rejects.toMatchObject({ status: 409, code: "export_idempotency_conflict" } satisfies Partial<OpenComputerError>);
    }
  }, 60_000);

  it("leaves a terminal export unchanged when cancelled", async () => {
    const cancelled = await oc.sessions.artifacts.cancel(delivered.id);
    expect(cancelled.state).toBe("delivered");
    expect(cancelled.completedAt).toBe(delivered.completedAt);
  }, 60_000);
});
