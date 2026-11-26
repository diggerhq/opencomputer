// Times every frontend API call of a runner (work 054, K8 and the
// visible-output milestones). The runner's one Slack client (convention 6) is
// wrapped once, so every call — from Session, Segment, prompts, panels — is
// observed without touching the call sites.
//
// Two facts come from the caller: a write whose arguments are in
// `placeholderWrites` shows only the turn's opening `Started` card (work 068),
// so telemetry can tell first visible apart from first content; and a write
// whose arguments are in `queuedSince` carries content that has waited since
// then (segment.ts), so `queued_ms` plus the call's own duration is how stale
// the content was when the person could see it (work 082, `client.lag`).
//
// Invariants: the wrapper never changes arguments, results or errors, and an
// observer that throws is ignored. Only the method name, duration, outcome
// and rate-limit facts leave; never arguments or responses.

/** Calls that change what a person sees in the thread. */
export const VISIBLE_METHODS = new Set([
  'chat.postMessage',
  'chat.update',
  'chat.startStream',
  'chat.appendStream',
  'chat.stopStream',
  'files.uploadV2',
  'files.completeUploadExternal',
]);

/** Arguments of writes that show only a turn's opening card (segment.ts); never sent anywhere. */
export const placeholderWrites = new WeakSet<object>();

/** Arguments of writes carrying content, and when (`performance.now()`) the oldest of it was queued; never sent anywhere. */
export const queuedSince = new WeakMap<object, number>();

export interface SurfaceCall {
  method: string;
  ms: number;
  ok: boolean;
  /** The frontend's error code (`ratelimited`, `channel_not_found`, …), never a message. */
  error?: string;
  rateLimited?: boolean;
  retryAfterS?: number;
  /** The write showed only the turn's opening card, not content. */
  placeholder?: boolean;
  /** How long the oldest content in this write waited before the call was made, ms. */
  queuedMs?: number;
}

/**
 * Errors that mean the frontend is already in the state the call asked for
 * (removing a 👀 the gateway never added: it acknowledges with a status where
 * it can). They count as successful calls, not as frontend errors in K8.
 */
const SETTLED = new Set(['no_reaction', 'already_reacted']);

interface SlackError {
  data?: { error?: unknown };
  code?: unknown;
  retryAfter?: number;
}

const errorCode = (err: unknown): string => {
  const e = err as SlackError | undefined;
  const c = e?.data?.error ?? e?.code ?? 'unknown';
  return typeof c === 'string'
    ? c
        .replace(/[^a-z0-9_.]/gi, '_')
        .toLowerCase()
        .slice(0, 64)
    : 'unknown';
};

/** Wrap a Slack client (or any `ns.method()` client): each call reports to `observe`. */
export function meteredClient<T extends object>(client: T, observe: (c: SurfaceCall) => void, now = () => performance.now()): T {
  const report = (c: SurfaceCall) => {
    try {
      observe(c);
    } catch {
      // Telemetry never fails a Slack call.
    }
  };
  // biome-ignore lint/suspicious/noExplicitAny: wraps any client namespace or method, untyped by nature
  const wrap = (target: any, name: string, owner?: unknown): any =>
    new Proxy(target, {
      get(t, prop) {
        const v = Reflect.get(t, prop, t);
        if (typeof prop !== 'string' || prop === 'then' || prop === 'constructor') return v;
        if (typeof v === 'function' || (v && typeof v === 'object' && !Array.isArray(v) && /^[a-z]/.test(prop)))
          return wrap(v, name ? `${name}.${prop}` : prop, t);
        return v;
      },
      apply(f, _this, args) {
        const started = now();
        const a = args[0] && typeof args[0] === 'object' ? (args[0] as object) : undefined;
        const since = a && queuedSince.get(a);
        const mark = {
          ...(a && placeholderWrites.has(a) ? { placeholder: true } : {}),
          ...(since !== undefined ? { queuedMs: Math.max(0, Math.round(started - since)) } : {}),
        };
        let r: unknown;
        try {
          r = Reflect.apply(f, owner, args);
        } catch (e) {
          report({ method: name, ms: now() - started, ok: false, error: errorCode(e) });
          throw e;
        }
        if (!(r instanceof Promise)) return r;
        return r.then(
          (v) => (report({ method: name, ms: now() - started, ok: true, ...mark }), v),
          (e: SlackError | undefined) => {
            const code = errorCode(e);
            const limited = code === 'slack_webapi_rate_limited_error' || e?.data?.error === 'ratelimited';
            if (SETTLED.has(code)) report({ method: name, ms: now() - started, ok: true });
            else report({ method: name, ms: now() - started, ok: false, error: code, rateLimited: limited, retryAfterS: e?.retryAfter });
            throw e;
          },
        );
      },
    });
  return wrap(client, '');
}
