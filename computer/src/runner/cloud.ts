// The runner's calls to the public API (work 118, section 41): an agent's
// tools that reach the cloud are HTTP calls with the session's own one-hour
// key, so an agent is an API caller like any other. The key comes from the
// runner's token socket, as bin/opencomputer gets it (kind `opencomputer`:
// the host knows the session from which socket is asked, and the key is bound
// to that session).
//
// Invariants: the key is never logged or returned; it is asked again 5 minutes
// before it expires and after a 401; a mutation carries the tool call's id as
// its Idempotency-Key, so a retried tool call lands once.

import net from 'node:net';

/** The public API's prefix on the key's `apiUrl`, the edge's `COMPUTER_API_PREFIX` (spec 34.2). */
const API_PREFIX = '/api/managed-agents/computer';

export interface CloudKey {
  token: string;
  expiresAt: string;
  apiUrl?: string;
}

export interface CloudCall {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** The Idempotency-Key of a write. */
  key?: string;
}

/** An API error: `code` is the API's (`refused`, `not_found`, …), `reason` its reason when it gave one. */
export class CloudError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly reason?: string, readonly body?: any) {
    super(message);
  }
}

export interface CloudApi {
  /** `path` below the edge's `/api/managed-agents/computer` (spec 34.2), e.g. `/sessions`; resolves with the reply's JSON (null for an empty one). */
  call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, o?: CloudCall): Promise<any>;
  /**
   * A GET whose body is bytes, not JSON (an attachment's content, work 126): the Response as the API streamed it, its
   * status unread, so the caller streams the body and reads the error. A 401 asks the key again once. `signal` stands in
   * for the 30 s call timeout: the caller watches the stream's progress.
   */
  stream(path: string, signal?: AbortSignal): Promise<Response>;
}

/** One JSON line to the token socket, one back. */
export function askKey(socket: string): Promise<CloudKey> {
  return new Promise((resolve, reject) => {
    const c = net.connect(socket);
    let buf = '';
    c.setTimeout(20_000, () => c.destroy(new Error('no key from the host within 20 s')));
    c.on('connect', () => c.write(`${JSON.stringify({ kind: 'opencomputer' })}\n`));
    c.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      c.end();
      try {
        const m = JSON.parse(buf.slice(0, i));
        if (typeof m?.token !== 'string') return reject(new Error(m?.error ?? 'the host gave no key'));
        resolve(m);
      } catch {
        reject(new Error('the host gave no key'));
      }
    });
    c.on('error', reject);
    c.on('close', () => reject(new Error('the host gave no key')));
  });
}

export function cloudApi(o: { key: () => Promise<CloudKey>; fetch?: typeof fetch; now?: () => number }): CloudApi {
  const now = o.now ?? Date.now;
  const doFetch = o.fetch ?? fetch;
  let held: Promise<CloudKey> | undefined;
  const key = async () => {
    const k = held && (await held.catch(() => undefined));
    if (k && Date.parse(k.expiresAt) - now() > 5 * 60_000) return k;
    held = o.key();
    return held;
  };
  const once = async (method: string, path: string, c: CloudCall, signal?: AbortSignal) => {
    const k = await key();
    if (!k.apiUrl) throw new Error('the host gave a key without its API URL');
    const url = new URL(`${k.apiUrl.replace(/\/$/, '')}${API_PREFIX}${path}`);
    for (const [name, v] of Object.entries(c.query ?? {})) if (v !== undefined) url.searchParams.set(name, String(v));
    return doFetch(url, {
      method,
      headers: {
        authorization: `Bearer ${k.token}`,
        ...(c.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(c.key ? { 'idempotency-key': c.key } : {}),
      },
      ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
  };
  return {
    async stream(path, signal) {
      let res = await once('GET', path, {}, signal);
      if (res.status === 401) {
        held = undefined;
        await res.body?.cancel().catch(() => {});
        res = await once('GET', path, {}, signal);
      }
      return res;
    },
    async call(method, path, c = {}) {
      let res = await once(method, path, c);
      if (res.status === 401) (held = undefined), (res = await once(method, path, c));
      const text = await res.text();
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // Not the API's answer (a page, a proxy's error): never read as an empty one.
        throw new CloudError(res.status, `http_${res.status}`, `the API answered ${res.status} with a body that is not JSON`);
      }
      if (res.ok) return body;
      const e = body?.error;
      const code = typeof e === 'string' ? e : (e?.code ?? `http_${res.status}`);
      throw new CloudError(res.status, code, (typeof e === 'object' && e?.message) || code, typeof e === 'object' ? e?.reason : undefined, body);
    },
  };
}
