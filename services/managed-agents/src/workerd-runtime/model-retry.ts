/**
 * The host's word on a failed model call, asked through OpenCode's
 * `session.retry` hook.
 *
 * OpenCode decides first: rate limits, provider errors and unknown provider
 * failures are retried on its own schedule, with any wait the provider asked
 * for (Retry-After) honored up to its own budget, and everything it will not
 * retry (a rejection, an invalid request, a route with no model) declined.
 * That decision stands here unchanged: a proposed retry keeps its delay, a
 * declined rejection stays declined, and a wait OpenCode found too long is
 * never shortened into an early retry.
 *
 * The host adds one thing. Two failures OpenCode declines today are exactly
 * what the incident showed and are worth a second attempt: a transport
 * failure after the request was sent, and a response stream that broke once
 * output had started. For those the host grants one retry per model call,
 * after a short fixed wait; a call that fails the same way again is over.
 */

export interface ModelRetryError {
  readonly type: string;
  readonly message?: string;
  readonly status?: number;
}

export type ModelRetryDecision = { retry: false } | { retry: true; delay: number };

export interface ModelRetryInput {
  readonly error: ModelRetryError;
  /** OpenCode's own decision for this failure, delay included. */
  readonly decision: ModelRetryDecision;
  /** Whether the host already granted a retry for the model call in flight. */
  readonly hostRetried: boolean;
}

export interface ModelRetryVerdict {
  readonly decision: ModelRetryDecision;
  /** True when the host turned OpenCode's decline into the one retry it grants. */
  readonly overridden: boolean;
}

/** The wait before the host's own retry; the provider asked for nothing. */
export const MODEL_RETRY_OVERRIDE_DELAY_MS = 1_000;

/**
 * The failure classes the host retries once where OpenCode declines: a
 * transport failure after the send, and a response the provider cut short.
 */
export const MODEL_RETRY_OVERRIDE_TYPES: ReadonlySet<string> = new Set([
  "provider.transport",
  "provider.invalid-output",
]);

export function modelRetryDecision(input: ModelRetryInput): ModelRetryVerdict {
  // OpenCode's schedule, its waits and its declines are the policy.
  if (input.decision.retry) return { decision: input.decision, overridden: false };
  if (input.hostRetried || !MODEL_RETRY_OVERRIDE_TYPES.has(input.error.type)) {
    return { decision: { retry: false }, overridden: false };
  }
  return { decision: { retry: true, delay: MODEL_RETRY_OVERRIDE_DELAY_MS }, overridden: true };
}
