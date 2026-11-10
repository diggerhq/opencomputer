// The readiness probe behind the `preview` tool (work 074): once the gateway
// registered a name, the host waits up to 10 s for the port to answer HTTP,
// so the URL the model pastes does not land on "nothing is listening yet".
// The probe carries the preview's Host, as a visitor's request will, so a dev
// server that refuses unknown hosts shows it here, and the answer carries the
// one config line that fixes it. Next.js serves the page to any host and
// refuses only its HMR endpoint to another origin, so a Next server gets a
// second request there, with the preview's Origin.
//
// `listening` means some HTTP response came back, whatever its status. A
// server that accepted the connection but is still compiling its first page
// when the wait ends counts as listening too: it is up, only slow.

import http from 'node:http';

export const PROBE_WAIT_MS = 10_000;
const RETRY_MS = 250;
const BODY_LIMIT = 64 * 1024;

/** The config line a framework's host check needs, from a 403 it answered. */
export function frameworkHint(status: number, body: string): string | undefined {
  if (status !== 403) return undefined;
  if (/allowedDevOrigins|Blocked cross-origin request/i.test(body))
    return "Next.js blocks this host: add `allowedDevOrigins: ['*.opencomputer.app']` to next.config, then restart the dev server.";
  if (/Invalid Host header/i.test(body))
    return "webpack-dev-server blocks this host: add `allowedHosts: ['.opencomputer.app']` to devServer, then restart the dev server.";
  if (/Blocked request\. This host .* is not allowed|server\.allowedHosts/i.test(body))
    return "Vite blocks this host: add `server: { allowedHosts: ['.opencomputer.app'] }` to vite.config, then restart the dev server.";
  return undefined;
}

/** Next's HMR endpoint (webpack and Turbopack alike), refused with a 403 to an origin not in allowedDevOrigins. */
const NEXT_HMR_PATH = '/_next/webpack-hmr';
const NEXT_CHECK_WAIT_MS = 2_000;

type Attempt = { status: number; body: string; next: boolean } | 'refused' | 'connected';

function attempt(port: number, host: string, waitMs: number, path = '/', extra: http.OutgoingHttpHeaders = {}): Promise<Attempt> {
  return new Promise((resolve) => {
    let connected = false;
    const req = http.get({ host: '127.0.0.1', port, path, headers: { host, 'x-forwarded-host': host, 'x-forwarded-proto': 'https', ...extra },
      agent: false }, (res) => {
      let body = '';
      const done = () => resolve({ status: res.statusCode ?? 0, body, next: /next\.js/i.test(String(res.headers['x-powered-by'] ?? '')) });
      res.setEncoding('utf8');
      res.on('data', (d: string) => {
        if (res.statusCode !== 403) return res.destroy(), done();
        body += d;
        if (body.length > BODY_LIMIT) res.destroy(), done();
      });
      res.on('end', done);
      res.on('error', done);
    });
    req.on('socket', (s) => s.once('connect', () => (connected = true)));
    const timer = setTimeout(() => (req.destroy(), resolve(connected ? 'connected' : 'refused')), waitMs);
    req.on('error', () => resolve(connected ? 'connected' : 'refused'));
    req.on('close', () => clearTimeout(timer));
  });
}

/** Wait for `port` to answer `GET /` with `Host: host`; at most `waitMs`. */
export async function probePort(port: number, host: string, waitMs = PROBE_WAIT_MS): Promise<{ listening: boolean; hint?: string }> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const left = deadline - Date.now();
    const a = await attempt(port, host, Math.max(1, left));
    if (typeof a === 'object') {
      const hint = frameworkHint(a.status, a.body) ?? (a.next && a.status !== 403 ? await nextHint(port, host) : undefined);
      return { listening: true, ...(hint && { hint }) };
    }
    if (a === 'connected') return { listening: true };
    if (Date.now() + RETRY_MS >= deadline) return { listening: false };
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}

/** Whether a Next dev server refuses its HMR to the preview's origin; the page itself loads either way. */
async function nextHint(port: number, host: string): Promise<string | undefined> {
  const a = await attempt(port, host, NEXT_CHECK_WAIT_MS, NEXT_HMR_PATH, { origin: `https://${host}` });
  return typeof a === 'object' && a.status === 403 ? frameworkHint(403, 'allowedDevOrigins') : undefined;
}
