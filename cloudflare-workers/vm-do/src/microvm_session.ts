// microvm_session.ts — one Durable Object per MicroVM sandbox, holding an open
// agent tunnel so exec is a single round trip from the edge to the guest.
//
// The QEMU sibling in vm_session.ts is HOST-DIALED: a worker process we own
// opens a WebSocket out to the DO. MicroVM has no host process — AWS runs the
// box — so this one dials IN, to the MicroVM's public endpoint, using the same
// port-scoped credential the control plane uses. Everything else about the
// shape is the same: a persistent channel, request/reply over it, and a caller
// that falls back to the control-plane path whenever the channel isn't there.
//
// WHY IT IS WORTH THE MACHINERY (measured on dev, Worker confirmed in IAD):
//
//   edge → control plane (CF tunnel), round trip     ~70ms
//   edge → guest agent, through this tunnel          ~4-5ms
//   opening the tunnel (one-time, off the hot path)  ~30-45ms
//
// Today every exec pays the first line plus the control-plane's own hop to the
// box. This replaces both with the second line.
//
// SCOPE: one-shot Exec only. Streaming, PTY and file transfer stay on the
// control-plane path — they are not implemented here and calls for them should
// never be routed to this DO.

import { H2Grpc, encodeExecRequest, decodeExecResponse, type ExecReq } from "../../shared/h2grpc";

const EXEC_PATH = "/agent.SandboxAgent/Exec";
const AGENT_TUNNEL_PATH = "/osb/agent-grpc"; // must match internal/awsvm.AgentTunnelPath
// Bounded well below the caller's own deadline: a call that outlives it is a
// call the caller has already given up on and re-run through the tunnel.
const DEFAULT_TIMEOUT_MS = 10_000;

// KEEPALIVE — see alarm().
//
// Cloudflare evicts an idle Durable Object after roughly ten seconds, and an
// outbound WebSocket is NOT hibernatable: it dies with the object. That is what
// made the stock-time warm dial worthless in practice — a box sits in stock for
// minutes, the DO is long gone by the time a customer arrives, and the first
// exec pays the full re-dial plus the AWS proxy's guest attach (measured: 632
// -1395ms, against ~26ms on a channel that is already up).
//
// An alarm every 5s keeps the object inside that eviction window, and the ping
// it sends keeps the proxy→guest attachment from going idle too. 5s rather than
// 9s because alarm delivery has jitter and the cost of being wrong is paying the
// whole re-dial on a customer's first exec.
const KEEPALIVE_MS = 5_000;
// How long an attached box is kept warm without being used. Deliberately long:
// stock can sit for a while and the whole point is that the customer never waits
// for a dial. Refreshed by every attach and every exec.
const KEEPALIVE_TTL_MS = 60 * 60 * 1000;
// Consecutive failed keepalives before we stop. A box that has been destroyed
// or whose credential expired will never answer, and pinging it forever would
// leave one alarm loop running per dead sandbox.
const MAX_KEEPALIVE_FAILURES = 5;
const PING_TIMEOUT_MS = 3_000;

interface Creds {
  endpoint: string;
  token: string;
  port: number;
}

export class MicrovmSession {
  private state: DurableObjectState;
  private creds: Creds | null = null;
  private conn: H2Grpc | null = null;
  private ws: WebSocket | null = null;
  private dialing: Promise<H2Grpc> | null = null;
  private failures = 0;
  // In memory only. Persisting it would put a storage write on the exec path to
  // save an alarm loop that costs nothing; an eviction just restarts the clock,
  // and the alarm re-reads the durable deadline set at attach.
  private warmUntil = 0;
  // Requests served by THIS instance. 1 means the object was constructed to
  // serve this request, which is the only way to tell an eviction apart from a
  // live-but-slow channel — and the whole remaining cost of this path is on one
  // side or the other of that line. Reported back in x-mvm-timing.
  private served = 0;
  // Last dial cost, so the exec that triggered a dial can attribute it. Set by
  // dial(), consumed and cleared by exec().
  private lastDialMs = 0;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    this.served++;
    try {
      if (path === "/attach") return await this.attach(req);
      if (path === "/exec") return await this.exec(req);
      if (path === "/status")
        return json({
          attached: this.creds !== null,
          live: this.live(),
          warmUntil: this.warmUntil,
          failures: this.failures,
        });
      if (path === "/detach") return await this.detach();
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
    return json({ error: "not found" }, 404);
  }

  private live(): boolean {
    return this.conn !== null && !this.conn.closed;
  }

  /**
   * attach records how to reach this sandbox's box. Called on the create path
   * with the endpoint and token the pool already holds, so nothing here needs
   * to talk to AWS or to the control plane.
   *
   * Deliberately does NOT dial unless asked: create is latency-critical, and the
   * dial can happen on the first exec (~35ms) or be warmed separately.
   *
   * Whether or not it dials, it arms the keepalive — that is what makes the warm
   * dial survive to the customer rather than being evicted a few seconds later.
   */
  private async attach(req: Request): Promise<Response> {
    const c = (await req.json()) as Creds & { dial?: boolean };
    if (!c?.endpoint || !c?.token || !c?.port) return json({ error: "endpoint, token and port required" }, 400);
    this.creds = { endpoint: c.endpoint, token: c.token, port: c.port };
    this.failures = 0;
    this.warmUntil = Date.now() + KEEPALIVE_TTL_MS;
    // Persisted so an evicted DO can re-dial without a round trip back to the
    // control plane. Credentials expire, which is why a dial failure has to be
    // reported plainly rather than retried forever — see exec().
    await this.state.storage.put({ creds: this.creds, warmUntil: this.warmUntil });
    await this.armKeepalive();
    // Opening the tunnel costs ~30-45ms. Doing it here, off the create path,
    // means the first exec — the one time-to-first-command actually measures —
    // finds a live channel instead of paying for it.
    if (c.dial) {
      try {
        await this.dial(this.creds);
      } catch (e) {
        // Not fatal: exec re-dials on demand, and a box that refuses now may
        // simply be mid-resume. The keepalive will retry in KEEPALIVE_MS.
        console.log(`mvm-do: warm dial failed: ${e}`);
      }
    }
    return json({ ok: true, live: this.live() });
  }

  private async detach(): Promise<Response> {
    this.creds = null;
    this.conn = null;
    this.warmUntil = 0;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
    // Deleting the alarm matters as much as dropping the credentials: without
    // it a released box would keep an alarm loop dialing an endpoint that has
    // been handed to a different tenant.
    await this.state.storage.deleteAlarm();
    await this.state.storage.delete(["creds", "warmUntil"]);
    return json({ ok: true });
  }

  private async armKeepalive(): Promise<void> {
    // setAlarm overwrites, so this is also the re-arm. Only skip when one is
    // already due sooner than we would set it — a burst of attaches must not
    // push the next tick further out.
    const due = await this.state.storage.getAlarm();
    const next = Date.now() + KEEPALIVE_MS;
    if (due !== null && due <= next) return;
    await this.state.storage.setAlarm(next);
  }

  /**
   * alarm keeps this object — and the tunnel it owns — alive.
   *
   * Two things decay on their own and both are fixed here. The Durable Object
   * is evicted once it goes idle, taking its non-hibernatable outbound
   * WebSocket with it; and the AWS proxy's attachment to the guest port goes
   * cold if nothing crosses it. Waking on a timer handles the first, and the
   * HTTP/2 PING — which the guest's own stack has to answer — handles the
   * second. The whole point is that this cost is paid on a timer nobody is
   * waiting on, instead of on the customer's first exec.
   *
   * Never throws: a Durable Object alarm that throws is retried on the
   * platform's schedule, not ours, and we would rather re-arm deliberately.
   */
  async alarm(): Promise<void> {
    const creds = await this.loadCreds();
    if (!creds) return; // detached — let the loop end
    if (!this.warmUntil) this.warmUntil = (await this.state.storage.get<number>("warmUntil")) ?? 0;
    if (this.warmUntil && Date.now() > this.warmUntil) {
      // Unused long enough that holding a socket open for it is waste. Exec
      // still works — it just pays for its own dial.
      console.log("mvm-do: keepalive expired, going cold");
      return;
    }
    try {
      const conn = await this.channel();
      await conn.ping(PING_TIMEOUT_MS);
      this.failures = 0;
    } catch (e) {
      this.conn = null;
      this.failures++;
      console.log(`mvm-do: keepalive failed (${this.failures}/${MAX_KEEPALIVE_FAILURES}): ${e}`);
      if (this.failures >= MAX_KEEPALIVE_FAILURES) {
        // Destroyed box, or a credential that has aged out. Either way nothing
        // here can fix it, and a permanent retry loop per dead sandbox is worse
        // than a cold first exec.
        console.log("mvm-do: keepalive giving up");
        return;
      }
    }
    await this.state.storage.setAlarm(Date.now() + KEEPALIVE_MS);
  }

  private async loadCreds(): Promise<Creds | null> {
    if (this.creds) return this.creds;
    this.creds = (await this.state.storage.get<Creds>("creds")) ?? null;
    return this.creds;
  }

  /**
   * dial opens the agent tunnel and wraps it in an HTTP/2 client.
   *
   * Single-flighted: a burst of execs arriving at a cold DO must produce one
   * tunnel, not one per request. Without this the first exec after eviction
   * would open N sockets against the box and leak all but one.
   */
  private dial(creds: Creds): Promise<H2Grpc> {
    if (this.dialing) return this.dialing;
    const p = (async (): Promise<H2Grpc> => {
      const tDial = Date.now();
      const host = creds.endpoint.replace(/^https?:\/\//, "").split("/")[0];
      const resp = await fetch(`https://${host}${AGENT_TUNNEL_PATH}`, {
        signal: AbortSignal.timeout(3000),
        headers: {
          Upgrade: "websocket",
          "X-aws-proxy-auth": creds.token,
          "X-aws-proxy-port": String(creds.port),
        },
      });
      const ws = (resp as unknown as { webSocket: WebSocket | null }).webSocket;
      if (!ws) throw new Error(`agent tunnel upgrade failed (http ${resp.status})`);
      ws.accept();
      this.ws = ws;
      const conn = new H2Grpc(ws, host);
      this.conn = conn;
      // Wait for the guest, not just the proxy — see H2Grpc.ready.
      await Promise.race([
        conn.ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error("guest did not answer")), 8000)),
      ]);
      // Logged rather than dropped: a dial here is the ~1.1s guest-attach the
      // keepalive exists to keep off the customer's path, so a run of them is
      // the signal that the keepalive is not holding.
      this.lastDialMs = Date.now() - tDial;
      console.log(`mvm-do: dial+ready in ${this.lastDialMs}ms`);
      return conn;
    })();
    this.dialing = p;
    p.catch(() => undefined).then(() => {
      if (this.dialing === p) this.dialing = null;
    });
    return p;
  }

  private async channel(): Promise<H2Grpc> {
    const creds = await this.loadCreds();
    if (!creds) throw new Error("not attached");
    if (this.conn && !this.conn.closed) return this.conn;
    this.conn = null;
    return this.dial(creds);
  }

  // Colo self-identification, resolved once per isolate and reported on every
  // exec. Placement is decided at FIRST TOUCH and is permanent, and the first
  // touch for these objects is warmMicrovmBox running inside a PoolStock shard
  // — so they inherit the shards' placement, which was measured scattered
  // across ATL/IAD/EWR/MIA/ORD. locationHint cannot fix this: it is
  // jurisdiction-level ("enam" covers all of those) and only consulted at
  // creation. This number is here to prove or kill that theory: if mvmdo
  // latency tracks colo, placement is the remaining tail.
  private colo = "?";
  private coloResolved = false;

  private resolveColo(): void {
    if (this.coloResolved) return;
    this.coloResolved = true;
    void fetch("https://www.cloudflare.com/cdn-cgi/trace")
      .then(async (r) => {
        this.colo = ((await r.text()).match(/^colo=(\w+)/m) ?? [])[1] ?? "?";
      })
      .catch(() => {});
  }

  private async exec(req: Request): Promise<Response> {
    // Everything the caller cannot see from outside. do;dur on the edge is one
    // opaque number covering the hop to this object, this object's cold start,
    // a dial if the channel was gone, and the RPC itself — and the four have
    // completely different fixes. Measured here and handed back so the edge can
    // publish the split.
    const tEnter = Date.now();
    this.resolveColo();
    this.lastDialMs = 0;
    const wasLive = this.live();
    const coldStart = this.served === 1;

    const body = (await req.json()) as ExecReq & { timeoutMs?: number };
    if (!body?.command) return json({ error: "command required" }, 400);

    let conn: H2Grpc;
    try {
      conn = await this.channel();
    } catch (e) {
      // 409 is the caller's cue to use the control-plane path. Every reason we
      // can't reach the box lands here — never attached, DO evicted with stale
      // credentials, box suspended, tunnel refused — and the answer to all of
      // them is the same, so they deliberately are not distinguished.
      return json({ error: `channel unavailable: ${e}`, fallback: true }, 409);
    }

    const timeoutMs = body.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const tU = Date.now();
      const res = await conn.unary(EXEC_PATH, encodeExecRequest(body), timeoutMs);
      const unaryMs = Date.now() - tU;
      // Kept deliberately. This is the only number that separates transport
      // from the guest actually running the command: everything else the edge
      // can see lumps them together, which is how ~700ms of shell startup spent
      // a whole session being mistaken for a slow tunnel.
      console.log(`mvm-do: unary ${unaryMs}ms`);
      // Being used is the strongest signal the box is worth keeping warm, so
      // each exec pushes the deadline out and restarts the loop if it had
      // lapsed (TTL expiry, or a run of failures while the box was resuming).
      this.warmUntil = Date.now() + KEEPALIVE_TTL_MS;
      this.failures = 0;
      await this.state.storage.put("warmUntil", this.warmUntil);
      await this.armKeepalive();
      return json(decodeExecResponse(res), 200, {
        // live=1 means the channel survived from the last request or the
        // keepalive — the state this whole design is trying to be in.
        "x-mvm-timing": `live=${wasLive ? 1 : 0},cold=${coldStart ? 1 : 0},dial=${this.lastDialMs},unary=${unaryMs},inside=${Date.now() - tEnter}`,
        "x-mvm-colo": this.colo,
      });
    } catch (e) {
      // The channel is suspect once a call fails on it: drop it so the next
      // exec re-dials rather than inheriting a half-dead connection.
      this.conn = null;
      return json({ error: `exec failed: ${e}`, fallback: true }, 409);
    }
  }
}

function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(extra ?? {}) },
  });
}
