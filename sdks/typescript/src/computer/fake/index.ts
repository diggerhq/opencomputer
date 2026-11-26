// The fake server: Org, the session logs, Live and scripted agents in one process (api.ts).

import type { Principal, RowKind, RowOf } from "../types.js";
import { Agents } from "./agent.js";
import type { Chaos, CreateFakeServer, FakeOptions, FakeServer } from "./api.js";
import { clone, mulberry, type Ctx } from "./ctx.js";
import { crockfordId } from "../ids.js";
import { route } from "./http.js";
import { Live } from "./live.js";
import { Log } from "./log.js";
import { Mutations } from "./mutations.js";
import { Org } from "./org.js";
import { seedDemo, seedEmpty } from "./seed.js";

export type { Chaos, CreateFakeServer, FakeAgent, FakeOptions, FakeServer } from "./api.js";

export const createFakeServer: CreateFakeServer = (o: FakeOptions = {}): FakeServer => {
  const principal: Principal = o.principal ?? { org: "org_demo", subject: "usr_igor" };
  const clock = o.now ?? (() => Date.now());
  const rand = mulberry(o.chaos?.seed ?? 1);
  let offset = 0;
  let offline = false;
  let chaos: Chaos = {};

  // What `idle()` waits for: timers, scripts and requests in flight.
  let busy = 0;
  let waiters: (() => void)[] = [];
  const settle = () => {
    if (--busy > 0) return;
    const w = waiters;
    waiters = [];
    for (const fn of w) fn();
  };
  const later = (fn: () => void, ms: number) => {
    busy++;
    setTimeout(() => {
      try {
        fn();
      } finally {
        settle();
      }
    }, ms);
  };
  const job = (p: Promise<unknown>) => {
    busy++;
    void p.then(settle, settle);
  };

  const ctx = {
    principal,
    now: () => clock() + offset,
    iso: (ms?: number) => new Date(ms ?? clock() + offset).toISOString(),
    rand,
    id: (prefix: string, n = 16) => crockfordId(prefix, n, rand),
    later,
    sleep: (ms: number) => new Promise<void>((resolve) => later(resolve, ms)),
    job,
    pace: o.pace ?? 0,
    auto: o.autoAgent ?? true,
  } as Ctx;
  ctx.org = new Org(ctx);
  ctx.log = new Log(ctx);
  ctx.live = new Live(ctx);
  ctx.mutations = new Mutations(ctx);
  ctx.agents = new Agents(ctx);
  const { org, log, live } = ctx;

  const setChaos = (c: Chaos) => {
    chaos = c;
    live.setChaos(c);
  };
  setChaos(o.chaos ?? {});
  if ((o.seed ?? "demo") === "demo") seedDemo(ctx);
  else seedEmpty(ctx);

  const requests: FakeServer["requests"] = [];

  const serve = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const entry = { method, path, idem: headers.get("idempotency-key"), status: 0 };
    requests.push(entry);
    const unreachable = () => new TypeError("Failed to fetch");
    if (offline) throw unreachable();
    if (o.latency) await ctx.sleep(o.latency);
    else await ctx.sleep(0);
    if (offline) throw unreachable();
    const unavailable = () => {
      entry.status = 503;
      return new Response(JSON.stringify({ error: { code: "unavailable", message: "chaos" } }), { status: 503, headers: { "content-type": "application/json" } });
    };
    // Two draws a request, whatever the probabilities.
    const before = live.chance(chaos.failBefore);
    const after = live.chance(chaos.failAfter);
    if (before) return unavailable();
    let body: Record<string, unknown> = {};
    if (typeof init.body === "string" && init.body) {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        entry.status = 400;
        return new Response(JSON.stringify({ error: { code: "invalid_request", message: "the body is not JSON" } }), { status: 400 });
      }
    }
    const reply = await route(ctx, method, new URL(path, "http://fake.local"), headers, body ?? {});
    if (after) return unavailable();
    entry.status = reply.status;
    if (reply.text != null) return new Response(reply.text, { status: reply.status, headers: reply.headers });
    if (reply.body === undefined) return new Response(null, { status: reply.status, headers: reply.headers });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json", ...reply.headers } });
  };

  return {
    principal,
    fetch(path, init) {
      const p = serve(path, init);
      job(p.catch(() => undefined));
      return p;
    },
    connect: () => live.connect(),
    agent: ctx.agents.api,
    rows: <K extends RowKind>(kind: K): RowOf<K>[] => clone(org.all(kind)),
    row: (kind, id) => clone(org.get(kind, id)),
    events: (sid) => log.events(sid),
    requests,
    chaos: setChaos,
    setOffline(v) {
      offline = v;
      live.offline = v;
      if (v) live.dropAll();
    },
    dropSockets: () => live.dropAll(),
    loseTail: (sid, keepSeq) => log.loseTail(sid, keepSeq),
    raiseFloor() {
      org.floor = org.version;
      org.gone = [];
    },
    corrupt(kind, id) {
      const row = org.get(kind, id);
      if (row) row.version -= 1;
    },
    age(ms) {
      offset += ms;
      org.age();
    },
    idle: () => (busy === 0 ? new Promise<void>((resolve) => setTimeout(() => (busy === 0 ? resolve() : waiters.push(resolve)), 0)) : new Promise<void>((resolve) => waiters.push(resolve))),
  };
};
