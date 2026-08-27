// h2grpc.ts — just enough HTTP/2 to make unary gRPC calls over a raw byte
// stream, so a Durable Object can talk straight to a MicroVM's in-guest agent.
//
// WHY THIS EXISTS
//
// A MicroVM's agent speaks gRPC on a guest port, reachable through a public TLS
// endpoint with a port-scoped header credential. Cloudflare's fetch() cannot be
// used for it: Lambda's proxy strips HTTP/2 trailers, and gRPC carries its
// status there, so a direct fetch runs the command and then loses the result.
// The tunnel the control plane uses works because a WebSocket forwards opaque
// frames — trailers included — and inside that tunnel is plain cleartext HTTP/2.
// So to reach the agent from the edge we have to speak HTTP/2 ourselves.
//
// Measured on dev from an IAD Worker: 4-5ms round trip to the guest agent
// through this tunnel, against ~70ms just for the edge→control-plane hop the
// current exec path pays before it even starts talking to the box.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// It never HPACK-DECODES. Encoding our own headers needs only literal-without-
// indexing entries, which are a length-prefixed name and value and nothing else
// — no dynamic table, no Huffman. Decoding the server's headers would need
// both, and we do not need them: a unary response is DATA frames plus an
// END_STREAM flag, all of which live in frame headers we can read directly.
// grpc-status rides in the trailers we skip, so "no DATA arrived" is the only
// failure signal this client reports — and the caller's answer to that is to
// fall back to the tunnel path, which is the same answer it would have for a
// non-zero status. Trading a precise error for ~600 lines of HPACK is the right
// trade while this path handles one-shot Exec only.
//
// Streaming RPCs, PTY and file transfer are NOT supported here on purpose; they
// stay on the control-plane path.

const FRAME_HEADER = 9;

const TYPE_DATA = 0x0;
const TYPE_HEADERS = 0x1;
const TYPE_RST_STREAM = 0x3;
const TYPE_SETTINGS = 0x4;
const TYPE_PING = 0x6;
const TYPE_GOAWAY = 0x7;
const TYPE_WINDOW_UPDATE = 0x8;

const FLAG_ACK = 0x1;
const FLAG_END_STREAM = 0x1;
const FLAG_END_HEADERS = 0x4;

// Big windows so a normal command's output never blocks on flow control and we
// never have to implement incremental WINDOW_UPDATE bookkeeping per stream.
// 8MB is far past anything one-shot Exec should return; larger outputs belong
// on the streaming path, which is not served here.
const WINDOW = 8 * 1024 * 1024;
const SETTINGS_INITIAL_WINDOW_SIZE = 0x4;

const PREFACE = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

/** One in-flight unary call. */
interface Call {
  chunks: Uint8Array[];
  resolve: (body: Uint8Array) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * openTunnel performs the WebSocket upgrade and returns an accepted socket,
 * with a timeout that bounds the HANDSHAKE ONLY.
 *
 * `AbortSignal.timeout(n)` cannot be used for this, and using it was a silent
 * disaster. The signal stays bound to the request for as long as the request
 * exists, and a WebSocket obtained from a fetch IS that request — so the
 * timeout does not expire when the handshake completes, it expires `n`
 * milliseconds later and tears down a perfectly healthy tunnel.
 *
 * Measured on dev 2026-08-25, with a 3000ms timeout on the MicroVM agent
 * tunnel: across 127 observed closures, `dial_duration + tunnel_lifetime` was
 * 3000ms EXACTLY, every time — a 19ms dial lived 2981ms, a 66ms dial lived
 * 2934ms, a 2267ms dial lived 733ms. Every socket died at code 1006 with no
 * Close frame, which reads as "the far end hung up" and is in fact us. The
 * MicrovmSession keepalive runs on a 5s alarm, so it could never once find a
 * live channel: the channel was guaranteed dead two seconds before every tick.
 * 243 dials served 5 execs.
 *
 * An AbortController whose timer is CLEARED on completion is the whole fix:
 * once the handshake resolves nothing can abort the connection any more.
 */
export async function openTunnel(
  url: string,
  headers: Record<string, string>,
  handshakeTimeoutMs: number,
): Promise<{ ws: WebSocket; status: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), handshakeTimeoutMs);
  let resp: Response;
  try {
    resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { Upgrade: "websocket", ...headers },
    });
  } finally {
    // The entire point. Leaving this timer armed is the bug described above.
    clearTimeout(timer);
  }
  const ws = (resp as unknown as { webSocket: WebSocket | null }).webSocket;
  if (!ws) throw new Error(`agent tunnel upgrade failed (http ${resp.status})`);
  ws.accept();
  return { ws, status: resp.status };
}

/**
 * H2Grpc drives one HTTP/2 connection over a WebSocket that carries a raw byte
 * stream. One instance per open tunnel; not safe to share across tunnels.
 */
export class H2Grpc {
  private ws: WebSocket;
  private authority: string;
  private buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private calls = new Map<number, Call>();
  private pings = new Map<string, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private pingSeq = 0;
  private nextStream = 1;
  private dead: Error | null = null;
  // When this tunnel was opened, so kill() can report how long it survived.
  // A channel whose whole purpose is to outlive the gap between requests needs
  // its lifetime stated, not inferred from how often something re-dials.
  private readonly openedAt = Date.now();
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  /**
   * ready settles when the GUEST has spoken — its SETTINGS frame is the first
   * proof the far end exists.
   *
   * This matters more than it looks. The WebSocket 101 comes from the AWS proxy,
   * not from the guest: the proxy only opens its own connection to the guest
   * port when payload first arrives. So an "open" tunnel says nothing about
   * whether the agent is reachable, and the cost of finding out lands on
   * whoever sends first — measured at ~1.1s on a freshly claimed pool box,
   * against ~26ms once the guest is attached. Awaiting this in the warm path
   * spends it while nobody is waiting.
   */
  readonly ready: Promise<void>;

  constructor(ws: WebSocket, authority: string) {
    this.ws = ws;
    this.authority = authority;
    this.ready = new Promise<void>((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
    // Binary, explicitly. The default binaryType is not guaranteed to be
    // "arraybuffer" in every WebSocket implementation, and a Blob here silently
    // yields a zero-length Uint8Array: no frame ever completes, we never ACK the
    // server's SETTINGS, and it closes the connection on us — which presents as
    // "tunnel closed" with no clue as to why.
    try {
      (ws as unknown as { binaryType: string }).binaryType = "arraybuffer";
    } catch {
      /* not settable on this implementation — the guard below still reports it */
    }
    ws.addEventListener("message", (ev: MessageEvent) => {
      const data = ev.data;
      if (typeof data === "string") return; // the agent never sends text
      if (!(data instanceof ArrayBuffer)) {
        console.log(`h2: NON-ARRAYBUFFER message ${Object.prototype.toString.call(data)}`);
        this.kill(new Error("h2grpc: websocket delivered non-binary data"));
        return;
      }
      this.onBytes(new Uint8Array(data));
    });
    // The close CODE and REASON are the only evidence that distinguishes "the
    // Durable Object was evicted and took this socket with it" from "the AWS
    // proxy or the guest hung up on us" — and those two have completely
    // different fixes. Both were being thrown away here, which is why a fleet
    // re-dialling every 5s (measured on dev: 243 dials serving 5 execs) looked
    // like an unexplained latency sawtooth rather than a stated fact.
    ws.addEventListener("close", (ev: CloseEvent) =>
      this.kill(new Error(`h2grpc: tunnel closed code=${ev?.code ?? "?"} reason=${ev?.reason || "(none)"} wasClean=${ev?.wasClean ?? "?"}`)),
    );
    ws.addEventListener("error", () => this.kill(new Error("h2grpc: tunnel error")));

    // Preface, our SETTINGS, and a connection-level window bump, sent eagerly.
    // We deliberately do NOT wait for the server's SETTINGS before issuing the
    // first request: HTTP/2 permits it, and waiting would put an extra round
    // trip on the very call this whole path exists to make fast.
    const hello = concat([
      enc(PREFACE),
      settingsFrame(),
      windowUpdateFrame(0, WINDOW),
    ]);
    ws.send(hello);
  }

  get closed(): boolean {
    return this.dead !== null;
  }

  /**
   * close tears the tunnel down. Callers that dial per request MUST call it:
   * a Worker that opens a WebSocket per exec and never closes it leaks one
   * socket per command, against the box and against the isolate's own limits.
   */
  close(): void {
    this.kill(new Error("h2grpc: closed by caller"));
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }

  private kill(e: Error): void {
    if (this.dead) return;
    this.dead = e;
    // The reason a tunnel died was recorded here and never surfaced. That is
    // how "the keepalive holds one channel open" and "the keepalive rebuilds a
    // channel every 5s" stayed indistinguishable: both look like a working
    // alarm loop from the outside. Age is the discriminator — a socket dying at
    // ~5s is being reclaimed with its object, one dying at its idle timeout is
    // being hung up on by the far end.
    console.log(`h2grpc: KILL ${this.authority} after ${Date.now() - this.openedAt}ms — ${e.message}`);
    if (this.readyReject) {
      this.readyReject(e);
      this.readyReject = null;
      this.readyResolve = null;
    }
    for (const [, call] of this.calls) {
      clearTimeout(call.timer);
      call.reject(e);
    }
    this.calls.clear();
    for (const [, p] of this.pings) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pings.clear();
  }

  /**
   * ping round-trips an HTTP/2 PING and resolves when its ACK comes back.
   *
   * This is the keepalive's liveness proof, and it is stronger than "the
   * WebSocket is still open". The 101 comes from the AWS proxy, which will hold
   * a socket open whether or not it is still attached to the guest; only a frame
   * the GUEST's HTTP/2 stack has to answer proves the whole chain — proxy,
   * guest port, agent server — is intact. PING is the cheapest such frame and,
   * unlike a real RPC, it runs no code inside the sandbox.
   */
  ping(timeoutMs = 5000): Promise<void> {
    if (this.dead) return Promise.reject(this.dead);
    // Opaque 8 bytes, echoed verbatim in the ACK. A counter is enough to pair
    // request with reply — these never leave one connection.
    const payload = new Uint8Array(8);
    new DataView(payload.buffer).setUint32(4, ++this.pingSeq);
    const key = keyOf(payload);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pings.delete(key);
        reject(new Error("h2grpc: ping timeout"));
      }, timeoutMs);
      this.pings.set(key, { resolve, reject, timer });
      try {
        this.ws.send(frame(TYPE_PING, 0, 0, payload));
      } catch (e) {
        clearTimeout(timer);
        this.pings.delete(key);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * unary issues one request and resolves with the response message bytes
   * (gRPC length-prefix already stripped).
   */
  unary(path: string, message: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextStream;
    this.nextStream += 2; // client streams are odd

    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error("h2grpc: call timeout"));
      }, timeoutMs);
      this.calls.set(id, { chunks: [], resolve, reject, timer });

      // gRPC frames its message as a 1-byte compression flag plus a 4-byte
      // big-endian length. `te: trailers` is mandatory — servers reject a gRPC
      // request without it.
      const body = new Uint8Array(5 + message.length);
      body[0] = 0;
      new DataView(body.buffer).setUint32(1, message.length);
      body.set(message, 5);

      const headers = hpack([
        [":method", "POST"],
        [":scheme", "http"],
        [":path", path],
        [":authority", this.authority],
        ["content-type", "application/grpc"],
        ["te", "trailers"],
        ["grpc-timeout", `${Math.max(1, Math.floor(timeoutMs))}m`],
      ]);

      try {
        this.ws.send(
          concat([
            frame(TYPE_HEADERS, FLAG_END_HEADERS, id, headers),
            frame(TYPE_DATA, FLAG_END_STREAM, id, body),
          ]),
        );
      } catch (e) {
        clearTimeout(timer);
        this.calls.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private onBytes(chunk: Uint8Array): void {
    this.buf = this.buf.length === 0 ? chunk : concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < FRAME_HEADER) return;
      const len = (this.buf[0] << 16) | (this.buf[1] << 8) | this.buf[2];
      if (this.buf.length < FRAME_HEADER + len) return;
      const type = this.buf[3];
      const flags = this.buf[4];
      const id = new DataView(this.buf.buffer, this.buf.byteOffset + 5, 4).getUint32(0) & 0x7fffffff;
      const payload = this.buf.subarray(FRAME_HEADER, FRAME_HEADER + len);
      this.onFrame(type, flags, id, payload);
      this.buf = this.buf.subarray(FRAME_HEADER + len);
    }
  }

  private onFrame(type: number, flags: number, id: number, payload: Uint8Array): void {
    switch (type) {
      case TYPE_SETTINGS:
        if (!(flags & FLAG_ACK)) this.ws.send(frame(TYPE_SETTINGS, FLAG_ACK, 0, new Uint8Array(0)));
        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = null;
          this.readyReject = null;
        }
        return;
      case TYPE_PING: {
        if (!(flags & FLAG_ACK)) {
          this.ws.send(frame(TYPE_PING, FLAG_ACK, 0, payload.slice()));
          return;
        }
        const p = this.pings.get(keyOf(payload));
        if (p) {
          this.pings.delete(keyOf(payload));
          clearTimeout(p.timer);
          p.resolve();
        }
        return;
      }
      case TYPE_GOAWAY:
        this.kill(new Error("h2grpc: server sent GOAWAY"));
        return;
      case TYPE_WINDOW_UPDATE:
        return;
      case TYPE_RST_STREAM: {
        const call = this.calls.get(id);
        if (call) {
          clearTimeout(call.timer);
          this.calls.delete(id);
          call.reject(new Error("h2grpc: stream reset by server"));
        }
        return;
      }
      case TYPE_DATA: {
        const call = this.calls.get(id);
        if (call) call.chunks.push(payload.slice());
        // Give the window straight back. Cheaper than tracking consumption, and
        // a unary response is never large enough for the extra frames to matter.
        if (payload.length > 0) {
          this.ws.send(
            concat([windowUpdateFrame(0, payload.length), windowUpdateFrame(id, payload.length)]),
          );
        }
        if (flags & FLAG_END_STREAM) this.finish(id);
        return;
      }
      case TYPE_HEADERS:
        // Response headers or trailers. Never decoded — see the file docstring.
        // Only the END_STREAM flag matters, and it is right here in the frame.
        if (flags & FLAG_END_STREAM) this.finish(id);
        return;
      default:
        return;
    }
  }

  private finish(id: number): void {
    const call = this.calls.get(id);
    if (!call) return;
    clearTimeout(call.timer);
    this.calls.delete(id);
    const body = concat(call.chunks);
    if (body.length < 5) {
      // No message came back, so the call failed and the reason is in trailers
      // we do not read. The caller's move either way is the tunnel fallback.
      call.reject(new Error("h2grpc: empty response (see grpc-status in trailers)"));
      return;
    }
    const msgLen = new DataView(body.buffer, body.byteOffset + 1, 4).getUint32(0);
    call.resolve(body.subarray(5, 5 + msgLen));
  }
}

// --- frame helpers ---

function frame(type: number, flags: number, streamID: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER + payload.length);
  out[0] = (payload.length >> 16) & 0xff;
  out[1] = (payload.length >> 8) & 0xff;
  out[2] = payload.length & 0xff;
  out[3] = type;
  out[4] = flags;
  new DataView(out.buffer).setUint32(5, streamID);
  out.set(payload, FRAME_HEADER);
  return out;
}

function settingsFrame(): Uint8Array {
  const p = new Uint8Array(6);
  new DataView(p.buffer).setUint16(0, SETTINGS_INITIAL_WINDOW_SIZE);
  new DataView(p.buffer).setUint32(2, WINDOW);
  return frame(TYPE_SETTINGS, 0, 0, p);
}

function windowUpdateFrame(streamID: number, n: number): Uint8Array {
  const p = new Uint8Array(4);
  new DataView(p.buffer).setUint32(0, n);
  return frame(TYPE_WINDOW_UPDATE, 0, streamID, p);
}

/**
 * hpack encodes headers as literal-without-indexing with literal names — the
 * one HPACK form that needs neither the static/dynamic tables nor Huffman. It
 * is more bytes on the wire than a real encoder would use, and for a handful of
 * short headers that is irrelevant next to not carrying an HPACK implementation.
 */
function hpack(headers: Array<[string, string]>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, value] of headers) {
    const n = enc(name);
    const v = enc(value);
    parts.push(new Uint8Array([0x00]), lenPrefixed(n), lenPrefixed(v));
  }
  return concat(parts);
}

/** HPACK string literal: 7-bit length prefix, Huffman bit clear, then bytes. */
function lenPrefixed(b: Uint8Array): Uint8Array {
  if (b.length < 127) {
    const out = new Uint8Array(1 + b.length);
    out[0] = b.length;
    out.set(b, 1);
    return out;
  }
  // Lengths ≥127 use a continuation varint. Only :path can realistically get
  // there, and not for the RPCs served here, but truncating silently would be
  // a nasty bug so it is handled rather than assumed away.
  const varint: number[] = [127];
  let rest = b.length - 127;
  while (rest >= 128) {
    varint.push((rest & 0x7f) | 0x80);
    rest >>= 7;
  }
  varint.push(rest);
  const out = new Uint8Array(varint.length + b.length);
  out.set(varint, 0);
  out.set(b, varint.length);
  return out;
}

/** Map key for a PING payload — 8 opaque bytes as hex. */
function keyOf(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// --- protobuf for agent.SandboxAgent/Exec ---
//
// Hand-rolled rather than generated: two messages with six scalar fields
// between them, against pulling a protobuf runtime into a Worker bundle that
// has to stay small and cold-start fast.

export interface ExecReq {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutSeconds?: number;
  runAsRoot?: boolean;
}

export interface ExecRes {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function encodeExecRequest(r: ExecReq): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(pbString(1, r.command));
  for (const a of r.args ?? []) parts.push(pbString(2, a));
  for (const [k, v] of Object.entries(r.env ?? {})) {
    // map<string,string> is a repeated message of {1: key, 2: value}.
    parts.push(pbBytes(3, concat([pbString(1, k), pbString(2, v)])));
  }
  if (r.cwd) parts.push(pbString(4, r.cwd));
  if (r.timeoutSeconds) parts.push(pbVarint(5, r.timeoutSeconds));
  if (r.runAsRoot) parts.push(pbVarint(6, 1));
  return concat(parts);
}

export function decodeExecResponse(b: Uint8Array): ExecRes {
  const out: ExecRes = { exitCode: 0, stdout: "", stderr: "" };
  const dec = new TextDecoder();
  let i = 0;
  while (i < b.length) {
    const [tag, n1] = varint(b, i);
    i = n1;
    const field = tag >>> 3;
    const wire = tag & 0x7;
    if (wire === 0) {
      const [v, n2] = varint(b, i);
      i = n2;
      if (field === 1) out.exitCode = v | 0;
    } else if (wire === 2) {
      const [len, n2] = varint(b, i);
      const s = dec.decode(b.subarray(n2, n2 + len));
      i = n2 + len;
      if (field === 2) out.stdout = s;
      else if (field === 3) out.stderr = s;
    } else {
      break; // unknown wire type — nothing safe left to read
    }
  }
  return out;
}

function pbString(field: number, s: string): Uint8Array {
  return pbBytes(field, enc(s));
}

function pbBytes(field: number, b: Uint8Array): Uint8Array {
  return concat([uvarint((field << 3) | 2), uvarint(b.length), b]);
}

function pbVarint(field: number, v: number): Uint8Array {
  return concat([uvarint(field << 3), uvarint(v)]);
}

function uvarint(v: number): Uint8Array {
  const out: number[] = [];
  let x = v;
  while (x >= 128) {
    out.push((x & 0x7f) | 0x80);
    x >>>= 7;
  }
  out.push(x);
  return new Uint8Array(out);
}

function varint(b: Uint8Array, i: number): [number, number] {
  let v = 0;
  let shift = 0;
  let j = i;
  for (; j < b.length; j++) {
    v |= (b[j] & 0x7f) << shift;
    if ((b[j] & 0x80) === 0) return [v >>> 0, j + 1];
    shift += 7;
  }
  return [v >>> 0, j];
}
