// The runner's model access (work 097, 6b): one interface for what the
// credentials the host sends mean to this runner's harness, and the public
// build's implementation of it, in which a runner only ever holds managed
// credentials (the organization's, applied to its environment by main.ts).
//
// The hosted build (subscription.ts: the owner's Claude subscription through
// oc-modelproxy's socket, with the model downgrades it brings) implements the
// same interface; model-access-impl.ts is the one place that chooses, and
// runner/main.ts sees only this file's types. The frames stay protocol.ts's:
// `claudeSubscription` in HostCredentials, `model-denied` out.
//
// Invariants:
// - `noRunnerModelAccess` never touches the environment: `apply` only reports
//   the route the credentials carry ('managed', or undefined for a Slack-only
//   update) and main.ts applies them as before. A `claudeSubscription`
//   credential, which only a proxy host sends, is reported as no Claude part
//   (undefined) with a warning: the runner keeps the credential it has rather
//   than pointing its harness at a socket that is not there or restarting
//   into the same delivery again.
// - Nothing here throws, and no method is ever 'switch' or 'subscription'.

import type { HostCredentials, RunnerToHost } from '../protocol.js';
import { log } from '../log.js';
import type { HarnessEvent } from './harness/types.js';
import type { Session } from './session.js';

export { MODEL_SOCKET } from '../protocol.js';

export type Route = 'managed' | 'subscription';

/** The route `c` carries; undefined for an update with no Claude part (Slack only). */
export const routeOf = (c: HostCredentials): Route | undefined => (c.claudeOAuthToken || c.anthropicApiKey ? 'managed' : undefined);

/** What runner/main.ts hands the model access. */
export interface RunnerModelAccessDeps {
  /** The runner's environment, which its harness is spawned from. */
  env: NodeJS.ProcessEnv;
  /** The proxy's socket (SP_MODEL_SOCKET), when not the default. */
  socket: string | undefined;
  hooks: RunnerModelAccessHooks;
}

export interface RunnerModelAccessHooks {
  session(): Session | undefined;
  out(m: RunnerToHost): void;
  /** Telemetry: a refused model was stepped down. */
  downgraded(from: string, to: string): void;
}

/** How runner/main.ts asks what its credentials mean, and tells of what the harness says. */
export interface RunnerModelAccess {
  /** The route this runner started on, once credentials arrived. */
  route(): Route | undefined;
  /** A spare claimed for another harness: the route it parked on is not the session's. */
  reset(): void;
  /**
   * Credentials from the host: 'switch' when they move this runner to another route (it should finish and exit),
   * 'subscription' once its harness is pointed at the proxy, 'managed' or undefined for main.ts to apply them.
   */
  apply(c: HostCredentials): Route | 'switch' | undefined;
  /** A harness record, for whatever the route makes of it (a refused model on a subscription steps down). */
  event(e: HarnessEvent): Promise<void>;
  /** The turn ended; true when the model access retries it (on another model). */
  idle(): boolean;
}

/** The public build: managed credentials only, applied by main.ts; nothing to tunnel, downgrade or retry. */
/** Takes the same deps as the hosted build, so `createRunnerModelAccess = noRunnerModelAccess` is a drop-in; none is read. */
export function noRunnerModelAccess(_: RunnerModelAccessDeps): RunnerModelAccess {
  let route: Route | undefined;
  let warned = false;
  return {
    route: () => route,
    reset() {
      route = undefined;
    },
    apply(c) {
      const next = routeOf(c);
      if (next === 'subscription') {
        if (!warned) log.warn('credentials name a subscription, which this runner has no model proxy for; keeping the credential it has');
        warned = true;
        return undefined;
      }
      route = next ?? route;
      return next;
    },
    event: async () => {},
    idle: () => false,
  };
}
