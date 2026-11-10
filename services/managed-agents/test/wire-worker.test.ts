import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { previewKey } from "../src/previews/auth.js";
import { encodeWireScope, signWireAuth } from "../src/wire/auth.js";
import { sha256Hex } from "../src/wire/crypto.js";
import type { WireKeyRecord } from "../src/wire/keys.js";
import { mintTicket } from "../src/wire/ticket.js";
import { type WireEnv, createWireHandler } from "../src/wire/worker.js";

/**
 * Work 084: the wire Worker against a real (local) KV namespace, with the
 * tunnel faked by a fetch stub: what reaches the computer, and the close
 * codes and statuses of every refusal.
 */

const wireEnv = env as unknown as WireEnv & { WIRE_KEYS: KVNamespace; WIRE_TICKET_KEY: string; PREVIEW_PLATFORM_KEY: string };
const NOW = 1_800_000_000_000;
const TUNNEL = "6ff42ae2-765d-4adf-8112-31c55c1551ef";
const ALL = ["sessions:read", "sessions:write", "asks:answer", "secrets:write", "terminals"];
const SESSION = "cs_7f3a9k2m4q8r1t6v";

const record = (keyId: string, extra: Partial<WireKeyRecord> = {}): WireKeyRecord => ({
  org: "org_wire",
  member: "usr_wire",
  computer: "cmp_wire",
  tunnelId: TUNNEL,
  keyId,
  scopes: ALL,
  expiresAt: null,
  kind: "user",
  ...extra,
});

const KEYS = {
  full: { key: "sk_full_0000000000000000", record: record("key_full") },
  expiring: { key: "sk_expiring_000000000000", record: record("key_expiring", { expiresAt: NOW + 86_400_000 }) },
  expired: { key: "sk_expired_0000000000000", record: record("key_expired", { expiresAt: NOW - 1 }) },
  project: { key: "sk_project_0000000000000", record: record("key_project", { kind: "project" }) },
  readOnly: { key: "sk_readonly_000000000000", record: record("key_readonly", { scopes: ["sessions:read"] }) },
  noRead: { key: "sk_noread_00000000000000", record: record("key_noread", { scopes: ["asks:answer"] }) },
};

beforeAll(async () => {
  for (const { key, record } of Object.values(KEYS)) {
    const hash = await sha256Hex(key);
    await wireEnv.WIRE_KEYS.put(`h:${hash}`, JSON.stringify(record));
    await wireEnv.WIRE_KEYS.put(`k:${record.keyId}`, hash);
  }
});

type Call = { url: string; init: RequestInit; headers: Headers };

function harness(answer: (call: Call) => Response | Promise<Response> = () => upgraded()) {
  const calls: Call[] = [];
  const handle = createWireHandler({
    now: () => NOW,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {}, headers: new Headers(init?.headers) };
      calls.push(call);
      return answer(call);
    }) as typeof fetch,
  });
  return { calls, handle: (request: Request) => handle(request, wireEnv) };
}

/** What the relay answers: an accepted socket selecting opc.v1. */
function upgraded(): Response {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  server.accept();
  return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": "opc.v1" } });
}

function dial(headers: Record<string, string> = {}, query = ""): Request {
  return new Request(`https://wire.opencomputer.dev/v1${query}`, {
    headers: { upgrade: "websocket", "sec-websocket-protocol": "opc.v1", ...headers },
  });
}

/** The close an accepted-then-refused upgrade delivers. */
async function closeOf(response: Response): Promise<{ code: number; reason: Record<string, unknown> }> {
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const closed = new Promise<{ code: number; reason: Record<string, unknown> }>((resolve) =>
    ws.addEventListener("close", (event) => resolve({ code: event.code, reason: JSON.parse(event.reason) })),
  );
  ws.accept();
  return closed;
}

const computerKey = () => previewKey(wireEnv.PREVIEW_PLATFORM_KEY, TUNNEL);

describe("the wire Worker's upgrade", () => {
  it("forwards a key's upgrade to the tunnel signed, without the key, and hands the 101 back as it came", async () => {
    const { calls, handle } = harness();
    const request = dial({ authorization: `Bearer ${KEYS.expiring.key}`, "user-agent": "opc/0.1.0", cookie: "a=b" }, "?attach=cs_7f3a9k2m4q8r1t6v&after=1180");
    const response = await handle(request);
    expect(response.status).toBe(101);
    expect(response.headers.get("sec-websocket-protocol")).toBe("opc.v1");
    expect(calls).toHaveLength(1);
    const [call] = calls as [Call];
    expect(call.url).toBe(`https://${TUNNEL}.w.opencomputer.test/connect?attach=cs_7f3a9k2m4q8r1t6v&after=1180`);
    const expected = await signWireAuth(await computerKey(), {
      member: "usr_wire",
      keyId: "key_expiring",
      client: "opc/0.1.0",
      scope: { scopes: ALL, until: NOW + 86_400_000 },
      exp: NOW + 30_000,
    });
    expect(Object.fromEntries(call.headers)).toEqual({ upgrade: "websocket", "sec-websocket-protocol": "opc.v1", ...expected });
    const sent = JSON.stringify([...call.headers]);
    expect(sent).not.toContain(KEYS.expiring.key);
    expect(sent).not.toContain("cookie");
    response.webSocket!.accept();
  });

  it("takes x-api-key too, and sends no client for a User-Agent that is not opc's", async () => {
    const { calls, handle } = harness();
    await handle(dial({ "x-api-key": KEYS.full.key, "user-agent": "curl/8.0" }));
    expect(calls[0]!.headers.get("x-wire-client")).toBe("");
    expect(calls[0]!.headers.get("x-wire-scope")).toBe(encodeWireScope({ scopes: ALL }));
    expect(calls[0]!.headers.get("x-wire-key")).toBe("key_full");
  });

  it("forwards a ticket's upgrade with its sessions, read-only, its client and an hour, and never the ticket", async () => {
    const { calls, handle } = harness();
    const token = await mintTicket(
      wireEnv.WIRE_TICKET_KEY,
      { org: "org_wire", member: "usr_wire", computer: "cmp_wire", tunnelId: TUNNEL, keyId: "key_full", client: "acme-portal/2.0", scope: { sessionIds: [SESSION], readOnly: true } },
      NOW - 60_000,
    );
    const response = await handle(dial({ "sec-websocket-protocol": `opc.v1, opc.ticket.${token}` }));
    expect(response.status).toBe(101);
    const headers = calls[0]!.headers;
    expect(headers.get("sec-websocket-protocol")).toBe("opc.v1");
    expect(headers.get("x-wire-client")).toBe("acme-portal/2.0");
    expect(headers.get("x-wire-scope")).toBe(encodeWireScope({ scopes: ALL, sessionIds: [SESSION], readOnly: true, until: NOW + 3_600_000 }));
    expect(JSON.stringify([...headers])).not.toContain(token);
    response.webSocket!.accept();
  });

  it("closes 4001 for no, an unknown or an expired key, a bad or stale ticket, or a ticket of a revoked key", async () => {
    const { calls, handle } = harness();
    const ticket = (keyId: string, at = NOW) =>
      mintTicket(wireEnv.WIRE_TICKET_KEY, { org: "org_wire", member: "usr_wire", computer: "cmp_wire", tunnelId: TUNNEL, keyId, client: "", scope: {} }, at);
    const refused = [
      dial(),
      dial({ authorization: "Bearer sk_unknown" }),
      dial({ "x-api-key": KEYS.expired.key }),
      dial({ authorization: `Bearer ${KEYS.full.key}`, "x-api-key": KEYS.readOnly.key }),
      dial({ "sec-websocket-protocol": `opc.v1, opc.ticket.${(await ticket("key_full")).slice(0, -2)}AA` }),
      dial({ "sec-websocket-protocol": `opc.v1, opc.ticket.${await ticket("key_full", NOW - 600_000)}` }),
      dial({ "sec-websocket-protocol": `opc.v1, opc.ticket.${await ticket("key_revoked")}` }),
    ];
    for (const request of refused) expect(await closeOf(await handle(request))).toEqual({ code: 4001, reason: { code: "unauthenticated" } });
    expect(calls).toHaveLength(0);
  });

  it("closes 4003 for a key and a ticket together, and 4001 for a ticket naming another computer or tunnel", async () => {
    const { calls, handle } = harness();
    const ticket = (extra: { computer?: string; tunnelId?: string } = {}) =>
      mintTicket(
        wireEnv.WIRE_TICKET_KEY,
        { org: "org_wire", member: "usr_wire", computer: "cmp_wire", tunnelId: TUNNEL, keyId: "key_full", client: "", scope: { readOnly: true }, ...extra },
        NOW,
      );
    const both = dial({ authorization: `Bearer ${KEYS.full.key}`, "sec-websocket-protocol": `opc.v1, opc.ticket.${await ticket()}` });
    expect(await closeOf(await handle(both))).toEqual({ code: 4003, reason: { code: "forbidden", reason: "ticket_and_key" } });
    for (const extra of [{ computer: "cmp_other" }, { tunnelId: "0ff42ae2-765d-4adf-8112-31c55c1551ef" }]) {
      const request = dial({ "sec-websocket-protocol": `opc.v1, opc.ticket.${await ticket(extra)}` });
      expect(await closeOf(await handle(request))).toEqual({ code: 4001, reason: { code: "unauthenticated" } });
    }
    expect(calls).toHaveLength(0);
  });

  it("closes 4003 for a project key or one without sessions:read", async () => {
    const { calls, handle } = harness();
    expect(await closeOf(await handle(dial({ "x-api-key": KEYS.project.key })))).toEqual({ code: 4003, reason: { code: "forbidden", reason: "project_key" } });
    expect(await closeOf(await handle(dial({ "x-api-key": KEYS.noRead.key })))).toEqual({
      code: 4003,
      reason: { code: "forbidden", reason: "missing_scope", scope: "sessions:read" },
    });
    expect(calls).toHaveLength(0);
  });

  it("closes 4400 without selecting a protocol when opc.v1 is not offered", async () => {
    const { calls, handle } = harness();
    const response = await handle(dial({ "x-api-key": KEYS.full.key, "sec-websocket-protocol": "opc.v2" }));
    expect(response.headers.get("sec-websocket-protocol")).toBeNull();
    expect((await closeOf(response)).code).toBe(4400);
    expect(calls).toHaveLength(0);
  });

  it("closes 4503 with retryAfterMs when the tunnel is down or the fetch fails", async () => {
    for (const answer of [() => new Response("tunnel down", { status: 530 }), () => new Response("bad gateway", { status: 502 }), () => Promise.reject(new Error("network"))]) {
      const { handle } = harness(answer);
      expect(await closeOf(await handle(dial({ "x-api-key": KEYS.full.key })))).toEqual({ code: 4503, reason: { retryAfterMs: 1000 } });
    }
  });
});

describe("the wire Worker's workspace files", () => {
  const url = (op: string, query = "", id = SESSION) => `https://wire.opencomputer.dev/v1/sessions/${id}/workspace/${op}${query}`;

  it("streams an upload to the relay and its answer back, with the passthrough headers and a request id", async () => {
    const { calls, handle } = harness(async (call) => {
      // The relay reads the body as a stream: it was never buffered by the Worker.
      expect(call.init.body).toBeInstanceOf(ReadableStream);
      const received = await new Response(call.init.body).text();
      return Response.json({ upload: { path: "billing", files: 1, bytes: received.length, replaced: null }, seq: 7 }, { headers: { "x-relay": "1" } });
    });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("tar-"));
        controller.enqueue(new TextEncoder().encode("bytes"));
        controller.close();
      },
    });
    const response = await handle(
      new Request(url("archive", "?path=billing"), {
        method: "PUT",
        body,
        headers: { "x-api-key": KEYS.full.key, "content-type": "application/x-tar", "content-encoding": "zstd", "idempotency-key": "idem-1", cookie: "no" },
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ upload: { path: "billing", files: 1, bytes: 9, replaced: null }, seq: 7 });
    expect(response.headers.get("x-relay")).toBe("1");
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toMatch(/^req_[0-9a-z]{12}$/);
    const [call] = calls as [Call];
    expect(call.url).toBe(`https://${TUNNEL}.w.opencomputer.test/files/${SESSION}/archive?path=billing`);
    expect(call.init.method).toBe("PUT");
    expect(call.headers.get("content-type")).toBe("application/x-tar");
    expect(call.headers.get("content-encoding")).toBe("zstd");
    expect(call.headers.get("idempotency-key")).toBe("idem-1");
    expect(call.headers.get("x-request-id")).toBe(requestId);
    expect(call.headers.get("x-wire-member")).toBe("usr_wire");
    expect(call.headers.get("x-wire-auth")).toMatch(/^1800000030000\.[A-Za-z0-9_-]{43}$/);
    expect(call.headers.has("cookie")).toBe(false);
    expect(JSON.stringify([...call.headers])).not.toContain(KEYS.full.key);
  });

  it("reads a file, passing If-None-Match and the caller's request id, and the relay's status through", async () => {
    const { calls, handle } = harness(() => new Response(null, { status: 304, headers: { etag: '"abc"' } }));
    const response = await handle(new Request(url("file", "?path=a.txt"), { headers: { authorization: `Bearer ${KEYS.readOnly.key}`, "if-none-match": '"abc"', "x-request-id": "req_mine" } }));
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"abc"');
    expect(response.headers.get("x-request-id")).toBe("req_mine");
    expect(calls[0]!.url).toBe(`https://${TUNNEL}.w.opencomputer.test/files/${SESSION}/file?path=a.txt`);
    expect(calls[0]!.headers.get("if-none-match")).toBe('"abc"');
    expect(calls[0]!.init.body).toBeNull();
  });

  it("needs sessions:read to read and sessions:write to upload, a user key, and no ticket", async () => {
    const { calls, handle } = harness(() => Response.json({ entries: [] }));
    const error = async (request: Request) => {
      const response = await handle(request);
      return { status: response.status, error: ((await response.json()) as { error: Record<string, unknown> }).error };
    };
    expect(await error(new Request(url("archive"), { method: "PUT", body: "x", headers: { "x-api-key": KEYS.readOnly.key } }))).toEqual({
      status: 403,
      error: { code: "forbidden", reason: "missing_scope", scope: "sessions:write", message: expect.any(String), requestId: expect.stringMatching(/^req_/), retryable: false },
    });
    expect(await error(new Request(url("files"), { headers: { "x-api-key": KEYS.noRead.key } }))).toMatchObject({ status: 403, error: { reason: "missing_scope", scope: "sessions:read" } });
    expect(await error(new Request(url("files"), { headers: { "x-api-key": KEYS.project.key } }))).toMatchObject({ status: 403, error: { reason: "project_key" } });
    expect(await error(new Request(url("files")))).toMatchObject({ status: 401, error: { code: "unauthenticated" } });
    expect(await error(new Request(url("files"), { headers: { "x-api-key": KEYS.expired.key } }))).toMatchObject({ status: 401, error: { code: "unauthenticated" } });
    expect(await error(new Request(url("files"), { headers: { authorization: `Bearer ${KEYS.full.key}`, "x-api-key": KEYS.readOnly.key } }))).toMatchObject({
      status: 401,
      error: { code: "unauthenticated" },
    });
    expect(await error(new Request(url("files"), { headers: { authorization: "Bearer tk_abc.def" } }))).toMatchObject({ status: 403, error: { code: "forbidden", reason: "ticket" } });
    expect(await error(new Request(url("files", "", "cs_BAD"), { headers: { "x-api-key": KEYS.full.key } }))).toMatchObject({ status: 404, error: { code: "session_not_found" } });
    expect(await error(new Request(url("file"), { method: "PUT", body: "x", headers: { "x-api-key": KEYS.full.key } }))).toMatchObject({ status: 404, error: { code: "not_found" } });
    expect(calls).toHaveLength(0);
    expect((await handle(new Request(url("files", "?limit=5"), { headers: { "x-api-key": KEYS.readOnly.key } }))).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("answers 503 computer_unavailable when the tunnel is down", async () => {
    const { handle } = harness(() => new Response("down", { status: 530 }));
    const response = await handle(new Request(url("files"), { headers: { "x-api-key": KEYS.full.key } }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(((await response.json()) as { error: unknown }).error).toMatchObject({ code: "computer_unavailable", retryAfterMs: 1000, retryable: true });
  });
});

describe("the wire Worker", () => {
  it("answers anything else with 404 in the API's error shape", async () => {
    const { SELF } = await import("cloudflare:test");
    for (const path of ["/", "/v1", "/v2", "/v1/sessions"]) {
      const response = await SELF.fetch(`https://wire.opencomputer.dev${path}`);
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_found");
      expect(response.headers.get("x-request-id")).toMatch(/^req_/);
    }
  });
});

describe("the wire Worker's telemetry (work 084): one wireworker.request per request", () => {
  function telemetered(on = true) {
    const lines: Array<Record<string, any>> = [];
    const posts: string[] = [];
    const pending: Promise<unknown>[] = [];
    const handle = createWireHandler({
      now: () => NOW,
      fetch: (async () => upgraded()) as typeof fetch,
      telemetryFetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        posts.push(String(input));
        for (const l of String(init?.body).split("\n")) lines.push(JSON.parse(l));
        return new Response(null, { status: 202 });
      }) as typeof fetch,
    });
    const env = on ? { ...wireEnv, TINYBIRD_API_URL: "https://tb.test", TINYBIRD_APPEND_TOKEN: "p.append" } : wireEnv;
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
    return { lines, posts, handle: (r: Request) => handle(r, env, ctx), settle: () => Promise.all(pending.splice(0)) };
  }

  it("an accepted upgrade and a refused one: kind, via, result, reason, key id; never the key", async () => {
    const t = telemetered();
    await t.handle(dial({ authorization: `Bearer ${KEYS.full.key}` }));
    await closeOf(await t.handle(dial({ authorization: "Bearer sk_unknown" })));
    await t.settle();
    expect(t.lines.map((l) => [l.event_name, l.outcome])).toEqual([
      ["wireworker.request", "completed"],
      ["wireworker.request", "failed"],
    ]);
    expect(t.lines[0]).toMatchObject({ surface: "cli", org_id: "org_wire" });
    expect(JSON.parse(t.lines[0]!.data)).toMatchObject({ kind: "upgrade", via: "key", result: "accepted", key_id: "key_full", code: 101 });
    expect(JSON.parse(t.lines[1]!.data)).toMatchObject({ kind: "upgrade", result: "refused", reason: "unauthenticated", code: 4001 });
    const text = JSON.stringify(t.lines);
    expect(text).not.toContain(KEYS.full.key);
    expect(text).not.toContain("sk_unknown");
  });

  it("sends nothing without the Tinybird settings", async () => {
    const t = telemetered(false);
    await t.handle(dial({ authorization: `Bearer ${KEYS.full.key}` }));
    await t.handle(new Request("https://wire.opencomputer.dev/nope"));
    await t.settle();
    expect(t.posts).toHaveLength(0);
  });
});
