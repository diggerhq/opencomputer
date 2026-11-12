// Preview URLs on the host (work 074): the config from the gateway, the
// cloudflared child, the preview proxy, and the `preview`/`unpreview` tools'
// round trip (runner → host → gateway `preview` → `previewed` → probe →
// runner).
//
// Invariants: the config (tunnel token, signing key, allow-list) is in memory
// only and replaced whole by each `welcome` and `previews` frame; the gateway
// sends `previews` before the `previewed` it causes, so the allow-list already
// has a port when its URL reaches the model. The proxy starts with the first
// config, so a laptop host never binds its port.
//
// On a host whose sessions run in containers (work 103, C9; `sandbox` is
// passed) a session's port is not the host's: each previewed `(sandbox, port)`
// has a virtual port (sandbox/preview-ports.ts). The gateway, the Worker and
// the proxy's allow-list see only the virtual number; the proxy and the probe
// reach the session through its runner's preview socket (preview-dial.ts
// `sandboxDialer`), and the runner is answered with its own port. There the
// host's loopback is never dialed: a request that names no sandbox is
// refused, and a port outside the table is "port not previewed". A name is
// its sandbox's: `unpreview` is answered only for a name the table holds under
// the caller's id, and a sandbox that is removed has its names unpreviewed at
// the gateway by the host (`forget`).

import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import type { HostToGateway, HostToRunner, PreviewConfig, PreviewResult, RunnerToHost } from '../protocol.js';
import { log } from '../log.js';
import { type Cloudflared, cloudflared } from './cloudflared.js';
import type { RunRoot } from '../ipc.js';
import { type Dialer, nothingListens, sandboxDialer } from './preview-dial.js';
import { HOST_PORTS, PREVIEW_PROXY_PORT, previewProxy } from './preview-proxy.js';
import type { PreviewPorts } from './sandbox/preview-ports.js';
import { probePort } from './preview-probe.js';

type Ask = Extract<RunnerToHost, { t: 'preview' | 'unpreview' }>;
type Answer = Extract<HostToRunner, { t: 'previewed' }>;
/** A first `preview` may make the organization's tunnel inline: up to six Cloudflare API calls before the answer. */
const GATEWAY_WAIT_MS = 45_000;

export interface HostPreviews {
  /** A `welcome` (absent: no tunnel yet) or `previews` frame. */
  configure(config: PreviewConfig | undefined): void;
  /** A runner's `preview` or `unpreview`; resolves with the frame to send back, never rejects. `sandboxId`: the runner's, when it runs in a container. */
  request(from: string, m: Ask, sandboxId?: string): Promise<Answer>;
  /** Work 103: a sandbox was removed and `name` was its preview: tell the gateway, so the public name does not outlive the container. Never throws; a failure is logged. */
  forget(name: string, from: string): void;
  /** The gateway's `previewed`. */
  answer(m: { id: string; result?: PreviewResult; error?: string }): void;
  stop(): void;
}

/** `ask` sends to the gateway and returns false when it is not connected. */
export function hostPreviews(o: { ask: (m: Extract<HostToGateway, { t: 'preview' | 'unpreview' }>) => boolean; tunnel?: Cloudflared;
  probe?: typeof probePort; proxyPort?: number;
  /** Set on a host whose sessions run in containers: the virtual port table, each sandbox's run root, and the user its preview socket must belong to. */
  sandbox?: { ports: PreviewPorts; run(id: string): RunRoot; uid?: number } }): HostPreviews {
  let config: PreviewConfig | undefined;
  let proxy: http.Server | undefined;
  const tunnel = o.tunnel ?? cloudflared();
  const probe = o.probe ?? probePort;
  const waiters = new Map<string, (m: { result?: PreviewResult; error?: string }) => void>();
  const sb = o.sandbox;
  /** A virtual port's session, through its runner; a number the table lost meanwhile is a closed port. */
  const dialVirtual: Dialer = (virtual) => {
    const e = sb?.ports.get(virtual);
    return sb && e ? sandboxDialer(sb.run(e.id), e.id, { uid: sb.uid })(e.port) : nothingListens(virtual);
  };

  /** `preview` and `unpreview` of a runner in a container. */
  async function sandboxed(ports: PreviewPorts, from: string, m: Ask, id: string): Promise<Answer['result']> {
    if (m.t === 'unpreview') {
      // A name is its sandbox's: another session's, or nobody's, is not asked of the gateway.
      const e = ports.byName(m.req.name);
      if (e?.id !== id) throw new Error(`no preview named ${m.req.name} in this session`);
      const result = await gateway(from, m);
      ports.release(e.virtual);
      return { ...result, listening: false };
    }
    const { entry, fresh } = ports.assign(id, m.req.port);
    let result: PreviewResult;
    try {
      result = await gateway(from, { ...m, req: { ...m.req, port: entry.virtual } });
    } catch (e) {
      if (fresh) ports.release(entry.virtual); // the gateway never heard of it, or refused it
      throw e;
    }
    ports.setName(entry.virtual, result.name);
    return { ...result, port: m.req.port, ...(await probe(entry.virtual, new URL(result.url).host, undefined, dialVirtual)) };
  }

  function gateway(from: string, m: Ask): Promise<PreviewResult> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (waiters.delete(id), reject(new Error('no answer from the gateway within 45 s'))), GATEWAY_WAIT_MS);
      waiters.set(id, (a) => {
        clearTimeout(timer);
        waiters.delete(id);
        a.result ? resolve(a.result) : reject(new Error(a.error ?? 'no answer'));
      });
      const sent = m.t === 'preview' ? o.ask({ t: 'preview', id, from, req: m.req }) : o.ask({ t: 'unpreview', id, from, req: m.req });
      if (!sent) waiters.get(id)?.({ error: 'gateway not connected' });
    });
  }

  return {
    configure(next) {
      config = next;
      tunnel.set(next?.tunnelToken);
      if (next && !proxy) {
        proxy = sb ? previewProxy(() => config, HOST_PORTS, dialVirtual, (port) => !!sb.ports.get(port)) : previewProxy(() => config);
        // A failed bind (the previous host still holds the port) is retried on the next config, not after a restart.
        proxy.on('error', (e) => (log.error(`preview proxy: ${e.message}`), proxy?.close(), (proxy = undefined)));
        proxy.listen(o.proxyPort ?? PREVIEW_PROXY_PORT, '127.0.0.1');
      }
    },
    async request(from, m, sandboxId) {
      try {
        if (sb) {
          if (!sandboxId) throw new Error('this computer previews only sessions that run in a container');
          return { t: 'previewed', id: m.id, result: await sandboxed(sb.ports, from, m, sandboxId) };
        }
        const result = await gateway(from, m);
        if (m.t === 'unpreview') return { t: 'previewed', id: m.id, result: { ...result, listening: false } };
        return { t: 'previewed', id: m.id, result: { ...result, ...(await probe(result.port, new URL(result.url).host)) } };
      } catch (e) {
        return { t: 'previewed', id: m.id, error: e instanceof Error ? e.message : String(e) };
      }
    },
    forget: (name, from) => void gateway(from, { t: 'unpreview', id: '', req: { name } }).catch((e) => log.warn(`preview ${name} of a removed sandbox not unpreviewed: ${e?.message ?? e}`)),
    answer: (m) => waiters.get(m.id)?.(m),
    stop() {
      tunnel.stop();
      proxy?.close();
    },
  };
}
