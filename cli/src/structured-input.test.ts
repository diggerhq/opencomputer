import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseSessionCommand } from "./session-command.js";
import {
  parseResultsCommand,
  readPayloadFile,
  readSessionDataFile,
  STRUCTURED_INPUT_LIMIT,
} from "./structured-input.js";

const dir = mkdtempSync(join(tmpdir(), "oc-structured-"));
function file(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

test("session create takes --session-data-file and --payload-file; send takes --payload-file", () => {
  assert.deepEqual(
    parseSessionCommand(["create", "--session-data-file", "ctx.json", "--payload-file=turn.json"]),
    { action: "create", args: [], keep: false, payloadFile: "turn.json", sessionDataFile: "ctx.json" },
  );
  assert.deepEqual(parseSessionCommand(["send", "ses_1", "--payload-file", "turn.json"]), {
    action: "send",
    args: ["ses_1"],
    keep: false,
    payloadFile: "turn.json",
  });
  assert.throws(
    () => parseSessionCommand(["send", "ses_1", "--session-data-file", "ctx.json"]),
    /--session-data-file is only supported when creating a session/,
  );
  assert.throws(
    () => parseSessionCommand(["inspect", "ses_1", "--payload-file", "turn.json"]),
    /--payload-file is only supported when creating a session or sending a turn/,
  );
  assert.throws(() => parseSessionCommand(["create", "--payload-file"]), /--payload-file requires a value/);
});

test("--payload-file reads any non-empty JSON value within the limit", () => {
  const payload = { schema: "example.execution-envelope/v1", generation: 3, inputs: {} };
  assert.deepEqual(readPayloadFile(file("payload.json", JSON.stringify(payload))), payload);
  assert.deepEqual(readPayloadFile(file("list.json", "[1, 2]")), [1, 2]);
  assert.throws(() => readPayloadFile(file("empty.json", "{}")), /payload must not be empty/);
  assert.throws(() => readPayloadFile(file("null.json", "null")), /payload must not be empty/);
  assert.throws(() => readPayloadFile(file("bad.json", "{ not json")), /must name a file holding JSON/);
  assert.throws(() => readPayloadFile(join(dir, "missing.json")), /cannot read/);
  const big = JSON.stringify({ blob: "x".repeat(STRUCTURED_INPUT_LIMIT) });
  assert.throws(() => readPayloadFile(file("big.json", big)), /exceeds 32 KiB/);
});

test("--session-data-file reads a non-empty JSON object", () => {
  const data = { schema: "example.session-context/v1", externalReference: "ref-1" };
  assert.deepEqual(readSessionDataFile(file("ctx.json", JSON.stringify(data))), data);
  assert.throws(() => readSessionDataFile(file("array.json", "[1]")), /must be a JSON object/);
  assert.throws(() => readSessionDataFile(file("string.json", '"x"')), /must be a JSON object/);
  assert.throws(() => readSessionDataFile(file("empty-ctx.json", "{}")), /must not be empty/);
});

test("results list and get parse their arguments", () => {
  assert.deepEqual(parseResultsCommand(["list", "ses_1"]), { action: "list", sessionId: "ses_1" });
  assert.deepEqual(
    parseResultsCommand(["list", "ses_1", "--turn", "turn_2", "--cursor", "c1", "--limit=25"]),
    { action: "list", sessionId: "ses_1", turnId: "turn_2", cursor: "c1", limit: 25 },
  );
  assert.deepEqual(parseResultsCommand(["get", "ses_1", "result_1"]), {
    action: "get",
    sessionId: "ses_1",
    resultId: "result_1",
  });
  assert.throws(() => parseResultsCommand(["list"]), /session ID is required/);
  assert.throws(() => parseResultsCommand(["list", "ses_1", "--limit", "0"]), /--limit must be an integer from 1 to 200/);
  assert.throws(() => parseResultsCommand(["list", "ses_1", "extra"]), /Unexpected argument: extra/);
  assert.throws(() => parseResultsCommand(["get", "ses_1"]), /Usage: opencomputer results get/);
  assert.throws(() => parseResultsCommand(["drop", "ses_1"]), /Usage: opencomputer results list/);
});

test("the client sends sessionData, payload-only turns and reads result history on the documented routes", async (context) => {
  const { OpenComputerClient } = await import("./api.js");
  const requests: Array<{ request: Request; body: unknown }> = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.method === "POST" ? await request.clone().json() : undefined;
    requests.push({ request, body });
    if (request.url.endsWith("/turns")) return Response.json({ turnId: "turn_1", duplicate: false }, { status: 202 });
    if (request.url.includes("/results/")) return Response.json({ resultId: "result_1" });
    if (request.url.includes("/results")) return Response.json({ results: [], nextCursor: null });
    return Response.json({ session: { id: "ses_1", status: "new", sessionDataDigest: "sha256:cc", sessionDataRevision: 1 } }, { status: 201 });
  });
  const client = new OpenComputerClient({ apiUrl: "https://app.opencomputer.dev", apiKey: "test" }, "retry-1");

  const created = await client.createSession("muse@development", { sessionData: { schema: "s/v1", mode: "test" } });
  assert.equal(created.created, true);
  assert.equal(created.session.sessionDataDigest, "sha256:cc");
  assert.deepEqual(requests[0]!.body, { agentId: "muse@development", sessionData: { schema: "s/v1", mode: "test" } });

  await client.createTurn("ses_1", undefined, "turn-key", { generation: 3 });
  assert.deepEqual(requests[1]!.body, { idempotencyKey: "turn-key", payload: { generation: 3 } });
  await client.createTurn("ses_1", "Hello", "turn-key-2");
  assert.deepEqual(requests[2]!.body, { input: "Hello", idempotencyKey: "turn-key-2" });

  await client.results("ses_1", { cursor: "c1", limit: 2 });
  assert.equal(new URL(requests[3]!.request.url).pathname + new URL(requests[3]!.request.url).search, "/api/managed-agents/sessions/ses_1/results?cursor=c1&limit=2");
  await client.results("ses_1", { turnId: "turn_2" });
  assert.equal(new URL(requests[4]!.request.url).pathname, "/api/managed-agents/sessions/ses_1/turns/turn_2/results");
  const result = await client.result("ses_1", "result_1");
  assert.equal(result.resultId, "result_1");
  assert.equal(new URL(requests[5]!.request.url).pathname, "/api/managed-agents/sessions/ses_1/results/result_1");
});
