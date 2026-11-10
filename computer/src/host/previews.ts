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

import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import type { HostToGateway, HostToRunner, PreviewConfig, PreviewResult, RunnerToHost } from '../protocol.js';
import { log } from '../log.js';
import { type Cloudflared, cloudflared } from './cloudflared.js';
import { PREVIEW_PROXY_PORT, previewProxy } from './preview-proxy.js';
import { probePort } from './preview-probe.js';

type Ask = Extract<RunnerToHost, { t: 'preview' | 'unpreview' }>;
type Answer = Extract<HostToRunner, { t: 'previewed' }>;
/** A first `preview` may make the organization's tunnel inline: up to six Cloudflare API calls before the answer. */
const GATEWAY_WAIT_MS = 45_000;

export interface HostPreviews {
  /** A `welcome` (absent: no tunnel yet) or `previews` frame. */
  configure(config: PreviewConfig | undefined): void;
  /** A runner's `preview` or `unpreview`; resolves with the frame to send back, never rejects. */
  request(from: string, m: Ask): Promise<Answer>;
  /** The gateway's `previewed`. */
  answer(m: { id: string; result?: PreviewResult; error?: string }): void;
  stop(): void;
}

/** `ask` sends to the gateway and returns false when it is not connected. */
export function hostPreviews(o: { ask: (m: Extract<HostToGateway, { t: 'preview' | 'unpreview' }>) => boolean; tunnel?: Cloudflared;
  probe?: typeof probePort; proxyPort?: number }): HostPreviews {
  let config: PreviewConfig | undefined;
  let proxy: http.Server | undefined;
  const tunnel = o.tunnel ?? cloudflared();
  const probe = o.probe ?? probePort;
  const waiters = new Map<string, (m: { result?: PreviewResult; error?: string }) => void>();

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
        proxy = previewProxy(() => config);
        // A failed bind (the previous host still holds the port) is retried on the next config, not after a restart.
        proxy.on('error', (e) => (log.error(`preview proxy: ${e.message}`), proxy?.close(), (proxy = undefined)));
        proxy.listen(o.proxyPort ?? PREVIEW_PROXY_PORT, '127.0.0.1');
      }
    },
    async request(from, m) {
      try {
        const result = await gateway(from, m);
        if (m.t === 'unpreview') return { t: 'previewed', id: m.id, result: { ...result, listening: false } };
        return { t: 'previewed', id: m.id, result: { ...result, ...(await probe(result.port, new URL(result.url).host)) } };
      } catch (e) {
        return { t: 'previewed', id: m.id, error: e instanceof Error ? e.message : String(e) };
      }
    },
    answer: (m) => waiters.get(m.id)?.(m),
    stop() {
      tunnel.stop();
      proxy?.close();
    },
  };
}
