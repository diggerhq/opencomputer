// The whole managed-agents Worker on a local port, for the SDK's and the surface's tests: the edge,
// Org, SessionLog, Computer and Live, as `wrangler dev` runs them (test/fixtures/stack-worker.ts).
// Callers reach it as the opencomputer edge does, with the API surface header and an asserted
// principal. The computer is a scripted host on protocol 6 (`host`); the platform and the outbound
// network are the `computer` project's fakes. Nothing reaches the network.
//
//   const stack = await startStack()
//   const ada = await stack.member("org_a", "ada")
//   const host = await stack.host("org_a")
//   ...
//   await stack.close()

import { fileURLToPath } from "node:url";

import { SignJWT } from "jose";
import { unstable_startWorker } from "wrangler";
import WebSocket from "ws";

import type { Principal } from "../../src/actor/principal.js";
import { API_SCOPES } from "../../src/computer/api-types.js";
import { hostToken } from "../../src/computer/host-token.js";
import { fakeComputerOutbound, fakeComputerPlatform } from "./computer-fakes.mjs";

const SECRET = "stack-test-assertion-secret";
const HOST_KEY = "stack-test-host-token-key";
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url).href);

/** A caller of the API: its principal, and a fetch and a socket as it. */
export interface Caller {
  principal: Principal;
  /** `path` is the API's, as the SDK's `fetch` is given it: `/feed?after=…`. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** `GET /live`, upgraded. */
  socket(): WebSocket;
  /** The network between a client and the stack, as the test breaks it: a fetch and a `connect` for `createClient`. */
  net(seed?: number): Net;
}

/** A frame socket as the SDK's `Channel` has it: sends made before it opens wait for the open. */
export interface Channel {
  send(frame: unknown): void;
  onFrame(cb: (frame: any) => void): void;
  onState(cb: (state: "open" | "closed") => void): void;
  close(): void;
}

export interface Net {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  connect(): Channel;
  /** No request gets through and every socket closes, until `offline(false)`. */
  offline(on: boolean): void;
  /** Close the open sockets. */
  dropSockets(): void;
  /** What happens to pushed frames (feed, events, deltas): dropped, sent twice, or held until the next one. */
  chaos(c: { drop?: number; duplicate?: number; reorder?: number }): void;
  /** The next `k` writes reach the server, and their replies are lost (answered 503). */
  loseReplies(k: number): void;
  /** Every request: its method, path, body and status (0 when it did not get through). */
  requests: { method: string; path: string; body: unknown; status: number }[];
}

export interface Stack {
  url: string;
  /** A member of `org` by cookie, named `name` (the subject is `usr_<name>`). */
  member(org: string, name: string): Promise<Caller>;
  /** The agent of session `session` in `org`. */
  agent(org: string, session: string): Promise<Caller>;
  /** `org`'s computer: a scripted host, connected and welcomed. */
  host(org: string): Promise<Host>;
  close(): Promise<void>;
}

export async function startStack(): Promise<Stack> {
  const worker = await unstable_startWorker({
    config: root("wrangler.jsonc"),
    entrypoint: root("test/fixtures/stack-worker.ts"),
    bindings: {
      LIVE: { type: "durable_object_namespace", class_name: "LiveDurableObject" },
      EDGE: { type: "service", service: "blue-edge", entrypoint: "StackCredentials" },
      RUNTIMES: { type: "fetcher", fetcher: fakeComputerPlatform },
      OC_MANAGED_AGENTS_SECRET: { type: "plain_text", value: SECRET },
      COMPUTER_HOST_TOKEN_KEY: { type: "plain_text", value: HOST_KEY },
      COMPUTER_HOST_GATEWAY_URL: { type: "plain_text", value: "wss://managedagents.test" },
      COMPUTER_PUBLIC_ORIGIN: { type: "plain_text", value: "https://app.example" },
      COMPUTER_ANTHROPIC_API_KEY: { type: "plain_text", value: "sk-ant-test" },
    } as never,
    dev: { server: { port: 0 }, inspector: false, persist: false, watch: false, logLevel: "error", outboundService: fakeComputerOutbound } as never,
  });
  await worker.ready;
  const url = String(await worker.url).replace(/\/$/, "");
  const hosts: Host[] = [];

  async function assertion(p: Principal): Promise<string> {
    return new SignJWT({ org_id: p.org, oc_principal: p, ...(p.kind === "agent" ? { user_id: "computer" } : {}) })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("opencomputer-edge")
      .setAudience("managedagents")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
  }

  async function caller(p: Principal): Promise<Caller> {
    const headers = { "x-opencomputer-surface": "api", "x-opencomputer-agent-token": await assertion(p) };
    const base = {
      principal: p,
      fetch(path: string, init: RequestInit = {}) {
        const h = new Headers(init.headers);
        for (const [k, v] of Object.entries(headers)) h.set(k, v);
        if (init.body !== undefined && !h.has("content-type")) h.set("content-type", "application/json");
        return fetch(`${url}/v1/computer${path}`, { ...init, headers: h });
      },
    };
    const self: Caller = {
      ...base,
      socket: () => new WebSocket(`${url.replace(/^http/, "ws")}/v1/computer/live`, ["oc.live.v1"], { headers }),
      net: (seed) => network(self, seed),
    };
    return self;
  }

  return {
    url,
    member(org, name) {
      const subject = `usr_${name}`;
      return caller({
        org, subject, kind: "member", via: "app", scopes: [...API_SCOPES],
        audiences: ["org", `member:${subject}`], admin: false, credential: { id: `ck:${org}:${name}`, expiresAt: null },
      });
    },
    agent(org, session) {
      return caller({
        org, subject: session, kind: "agent", via: "agent", session, scopes: [...API_SCOPES],
        audiences: [], admin: false, credential: { id: `agent:${session}`, expiresAt: null },
      });
    },
    async host(org) {
      const h = await connectHost(url, org, await hostToken(HOST_KEY, org));
      hosts.push(h);
      return h;
    },
    async close() {
      for (const h of hosts) h.close();
      await worker.dispose();
    },
  };
}

// ------------------------------------------------------------------ the network

function network(caller: Caller, seed = 1): Net {
  const requests: Net["requests"] = [];
  const sockets = new Set<WebSocket>();
  let down = false;
  let lose = 0;
  let chaos = { drop: 0, duplicate: 0, reorder: 0 };
  // mulberry32: a seed gives one run.
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    requests,
    async fetch(path, init = {}) {
      const method = init.method ?? "GET";
      const entry = { method, path, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined, status: 0 };
      requests.push(entry);
      if (down) throw new TypeError("fetch failed: offline");
      const res = await caller.fetch(path, init);
      if (method !== "GET" && lose > 0) {
        lose -= 1;
        entry.status = 503;
        return Response.json({ error: { code: "unavailable", message: "reply lost" } }, { status: 503 });
      }
      entry.status = res.status;
      return res;
    },
    connect() {
      const ws = caller.socket();
      sockets.add(ws);
      const waiting: string[] = [];
      let frame: (f: any) => void = () => {};
      let onState: (s: "open" | "closed") => void = () => {};
      let held: any[] = [];
      let closed = false;
      const close = () => {
        sockets.delete(ws);
        if (closed) return;
        closed = true;
        onState("closed");
      };
      const deliver = (f: any) => {
        if (f.t !== "feed" && f.t !== "events" && f.t !== "delta") return frame(f);
        // Three draws a pushed frame, so a seed gives one run whatever the probabilities.
        const [drop, twice, hold] = [random() < chaos.drop, random() < chaos.duplicate, random() < chaos.reorder];
        const late = held;
        held = [];
        if (!drop) {
          if (hold) held.push(f);
          else frame(f);
          if (twice) frame(f);
        }
        for (const h of late) frame(h);
      };
      ws.on("open", () => {
        if (down) return ws.terminate();
        for (const f of waiting.splice(0)) ws.send(f);
        onState("open");
      });
      ws.on("message", (data) => {
        if (closed) return;
        deliver(JSON.parse(String(data)));
      });
      ws.on("close", close);
      ws.on("error", close);
      if (down) queueMicrotask(() => ws.terminate());
      return {
        send(f) {
          const text = JSON.stringify(f);
          if (ws.readyState === WebSocket.OPEN) ws.send(text);
          else if (ws.readyState === WebSocket.CONNECTING) waiting.push(text);
        },
        onFrame: (cb) => void (frame = cb),
        onState: (cb) => void (onState = cb),
        close() {
          ws.close();
          close();
        },
      };
    },
    offline(on) {
      down = on;
      if (on) for (const ws of sockets) ws.terminate();
    },
    dropSockets() {
      for (const ws of sockets) ws.terminate();
    },
    chaos(c) {
      chaos = { drop: 0, duplicate: 0, reorder: 0, ...c };
    },
    loseReplies(k) {
      lose = k;
    },
  };
}

// ------------------------------------------------------------------ the scripted host

/** What the host was asked to do with a session's turn. */
export interface HostTurn {
  sessionId: string;
  turnId: string;
  input: string;
}

/**
 * `org`'s computer as a script: it starts every session it is sent, records each turn it is given
 * (`message.received`, running, `turn.started`), and does nothing more until a test says what the
 * agent does. Answers, dismissals and interrupts end as the real host ends them.
 */
export interface Host {
  /** Every frame received. */
  frames: any[];
  /** The next turn of `sessionId` not yet taken, once it has arrived. */
  turn(sessionId: string): Promise<HostTurn>;
  /** The agent's text, as one completed message. */
  say(sessionId: string, text: string): void;
  /** The agent's text streamed in deltas of `chunk` characters of one block, then completed. */
  stream(sessionId: string, text: string, chunk: number): void;
  /** One tool call, started and ended. */
  tool(sessionId: string, title: string, o?: { fail?: boolean }): void;
  /** An ask: `question` or `approval`. Its id. */
  ask(sessionId: string, ask: { kind: "question" | "approval"; question?: unknown; approval?: unknown }): string;
  /** The turn ends: completed, or failed with `failed` as its error. */
  end(sessionId: string, o?: { failed?: string }): void;
  close(): void;
}

interface Journal {
  epoch: number;
  seq: number;
  status: string;
  turn: string | null;
  turns: HostTurn[];
  waiting: ((t: HostTurn) => void)[];
}

async function connectHost(url: string, org: string, token: string): Promise<Host> {
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/v1/computer/host?organizationId=${encodeURIComponent(org)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const frames: any[] = [];
  const journals = new Map<string, Journal>();
  let asks = 0;
  const send = (frame: unknown) => ws.send(JSON.stringify(frame));

  const journal = (sessionId: string, at?: { epoch: number; lastSeq: number }): Journal => {
    let j = journals.get(sessionId);
    if (!j) journals.set(sessionId, (j = { epoch: at?.epoch ?? 1, seq: at?.lastSeq ?? 0, status: "idle", turn: null, turns: [], waiting: [] }));
    else if (at && at.epoch > j.epoch) Object.assign(j, { epoch: at.epoch, seq: Math.max(j.seq, at.lastSeq) });
    return j;
  };

  function append(sessionId: string, type: string, data: unknown, o: { turnId?: string | null; actor?: unknown } = {}): void {
    const j = journal(sessionId);
    j.seq += 1;
    const event = {
      id: `ev_${sessionId}_${j.epoch}_${j.seq}`,
      seq: j.seq,
      createdAt: new Date().toISOString(),
      sessionId,
      turnId: o.turnId ?? null,
      type,
      actor: o.actor ?? null,
      data,
    };
    send({ t: "journal", sessionId, epoch: j.epoch, events: [event] });
  }

  function status(sessionId: string, to: string): void {
    const j = journal(sessionId);
    if (j.status === to) return;
    append(sessionId, "session.status_changed", { from: j.status, to });
    j.status = to;
  }

  function end(sessionId: string, type: "turn.completed" | "turn.failed" | "turn.cancelled", data: unknown): void {
    const j = journal(sessionId);
    if (!j.turn) return;
    append(sessionId, type, data, { turnId: j.turn });
    j.turn = null;
    status(sessionId, "idle");
  }

  function api(frame: any): unknown {
    const p = frame.params ?? {};
    const sessionId: string = frame.sessionId;
    const j = journal(sessionId, frame);
    switch (frame.method) {
      case "turns.send": {
        const t: HostTurn = { sessionId, turnId: p.turnId, input: p.input };
        append(sessionId, "message.received", { input: p.input, ifBusy: p.ifBusy ?? "queue", delivery: "queued", interruptedTurnIds: [], declinedAskIds: [] }, { turnId: p.turnId, actor: frame.actor });
        if (!j.turn) {
          status(sessionId, "running");
          append(sessionId, "turn.started", { turn: { trigger: "message" } }, { turnId: p.turnId });
          j.turn = p.turnId;
        }
        const waiter = j.waiting.shift();
        if (waiter) waiter(t);
        else j.turns.push(t);
        return { turnId: p.turnId };
      }
      case "asks.answer":
      case "asks.dismiss": {
        const answered = frame.method === "asks.answer";
        append(sessionId, "ask.closed", { ask: { id: p.askId, status: answered ? "answered" : "dismissed", answer: answered ? (p.answer ?? null) : null, closedBy: frame.actor } }, { turnId: j.turn, actor: frame.actor });
        if (j.status === "waiting") status(sessionId, "running");
        return { askId: p.askId };
      }
      case "sessions.interrupt":
        end(sessionId, "turn.cancelled", { reason: "interrupted", forced: false });
        return {};
      default:
        return {};
    }
  }

  ws.on("message", (data) => {
    const frame = JSON.parse(String(data));
    frames.push(frame);
    if (frame.t === "start") {
      journal(frame.session.sessionId, frame);
      send({ t: "started", id: frame.id, sessionId: frame.session.sessionId, status: "idle" });
    } else if (frame.t === "api") send({ t: "api-result", id: frame.id, result: api(frame) });
    else if (frame.t === "epoch") journal(frame.sessionId, frame);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  send({ t: "hello", protocol: 6, hostId: org, version: "stack-test", sessions: [] });
  await until(() => frames.some((f) => f.t === "welcome"), "welcome");

  return {
    frames,
    turn(sessionId) {
      const j = journal(sessionId);
      const t = j.turns.shift();
      return t ? Promise.resolve(t) : new Promise((resolve) => j.waiting.push(resolve));
    },
    say(sessionId, text) {
      append(sessionId, "message.completed", { text }, { turnId: journal(sessionId).turn });
    },
    stream(sessionId, text, chunk) {
      const j = journal(sessionId);
      const blockId = `blk_${j.seq + 1}`;
      const deltas = [];
      for (let offset = 0; offset < text.length; offset += chunk) {
        deltas.push({ type: "message.delta", turnId: j.turn, data: { blockId, text: text.slice(offset, offset + chunk) }, offset });
      }
      send({ t: "delta", sessionId, epoch: j.epoch, deltas });
      append(sessionId, "message.completed", { text }, { turnId: j.turn });
    },
    tool(sessionId, title, o = {}) {
      const turnId = journal(sessionId).turn;
      const data = { callId: `call_${Math.random().toString(36).slice(2, 10)}`, toolName: "bash", title };
      append(sessionId, "tool.started", data, { turnId });
      append(sessionId, o.fail ? "tool.failed" : "tool.completed", o.fail ? { ...data, error: { message: "exit 1" } } : data, { turnId });
    },
    ask(sessionId, ask) {
      const j = journal(sessionId);
      const id = `ask_${(++asks).toString().padStart(4, "0")}${Math.random().toString(36).slice(2, 10)}`;
      append(sessionId, "ask.opened", { ask: { id, status: "open", ...ask } }, { turnId: j.turn });
      status(sessionId, "waiting");
      return id;
    },
    end(sessionId, o = {}) {
      if (o.failed) end(sessionId, "turn.failed", { error: { code: "agent_failed", message: o.failed } });
      else end(sessionId, "turn.completed", {});
    },
    close() {
      ws.close();
    },
  };
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 250; i += 1) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${what} not reached`);
}
