// The builder agent's HTTP API inside a MicroVM (work 136; the agent is
// computer/offload/builder/agent.mjs), as the service calls it: through the
// MicroVM's endpoint with `X-aws-proxy-auth`. A session never sees either.
//
// Invariants:
// - Every call times out (10 s; 30 s for a log read) and throws on a non-2xx
//   answer with its status, never with the token.
// - The token is asked for at every call, so a refreshed one is used at once.

export interface AgentStatus {
  id: string;
  state: 'queued' | 'downloading' | 'running' | 'uploading' | 'done' | 'failed' | 'cancelled' | 'timeout';
  exitCode?: number;
  artifactSha256?: string;
  artifactBytes?: number;
  error?: string;
  timings?: Record<string, number>;
}

export const AGENT_TERMINAL: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled', 'timeout']);

export interface AgentJob {
  id: string;
  cmd: string;
  srcUrl: string;
  outUrl: string;
  logUrl: string;
  artifacts: string[];
  timeoutSec: number;
  workdir?: string;
}

export interface Agent {
  info(): Promise<{ ok: boolean; arch?: string; cpus?: number; memGb?: number; agentVersion?: string }>;
  submit(job: AgentJob): Promise<void>;
  status(id: string): Promise<AgentStatus>;
  /** Log bytes from `offset`, and the offset after them. */
  log(id: string, offset: number): Promise<{ data: Buffer; next: number }>;
  cancel(id: string): Promise<void>;
  urls(id: string, u: { outUrl?: string; logUrl?: string }): Promise<void>;
}

/** `endpoint`: RunMicrovm's (a host name; a URL is taken as it is). */
export function agentClient(endpoint: string, token: () => string, f: typeof fetch = fetch): Agent {
  const base = /^https?:\/\//.test(endpoint) ? endpoint.replace(/\/$/, '') : `https://${endpoint}`;
  async function call(method: string, p: string, body?: unknown, timeoutMs = 10_000) {
    const res = await f(`${base}${p}`, {
      method,
      headers: { 'X-aws-proxy-auth': token(), ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`builder agent ${method} ${p.replace(/\?.*/, '')} answered ${res.status}`);
    return res;
  }
  return {
    info: async () => (await call('GET', '/')).json(),
    submit: async (job) => void (await call('POST', '/jobs', job)),
    status: async (id) => (await call('GET', `/jobs/${encodeURIComponent(id)}`)).json(),
    async log(id, offset) {
      const res = await call('GET', `/jobs/${encodeURIComponent(id)}/log?offset=${offset}`, undefined, 30_000);
      const data = Buffer.from(await res.arrayBuffer());
      const next = Number(res.headers.get('x-log-offset'));
      return { data, next: Number.isInteger(next) && next >= offset ? next : offset + data.length };
    },
    cancel: async (id) => void (await call('POST', `/jobs/${encodeURIComponent(id)}/cancel`)),
    urls: async (id, u) => void (await call('PUT', `/jobs/${encodeURIComponent(id)}/urls`, u)),
  };
}
