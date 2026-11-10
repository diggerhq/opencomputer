// The host's model access (work 097, 6b): one interface for how a session's
// runner gets its model credentials, and the public build's implementation of
// it, in which every session runs on the organization's managed credentials.
//
// The hosted build (subscriptions.ts, model-proxy.ts, model-routes.ts: an
// owner's Claude or ChatGPT subscription through oc-modelproxy) implements the
// same interface; model-access-impl.ts is the one place that chooses, and
// host/main.ts sees only this file's types. Whatever is behind it, the wire
// is protocol.ts's and unchanged: `model-bound`, `model-health`, `probe`,
// `claudeSubscription`.
//
// Invariants:
// - `noHostModelAccess` is what `hostSubscriptions` did with no control
//   socket (SP_MODEL_PROXY unset): no `model-proxy` feature is advertised, so
//   the gateway routes every session managed; credentials pass through to a
//   Claude runner unchanged; a Codex runner never gets Claude's fields; a
//   `probe` is answered `proxy_unavailable`; a managed `model` push re-sends
//   a live runner its credentials; nothing binds, persists or exits a runner. A route the gateway would only send to a proxy host (a
//   subscription) is dropped with a warning rather than acted on.
// - Nothing here throws: a host with no hosted module never fails on a
//   model frame.

import type net from 'node:net';
import type { GatewayToHost, HarnessName, HostCredentials, HostToGateway, HostToRunner, ModelRoute, SessionReport } from '../protocol.js';
import type { Telemetry } from '../telemetry/emitter.js';
import { send } from '../ipc.js';
import { log } from '../log.js';

/** What host/main.ts hands the model access; the hosted build reads every field, the public build only `runner` and `toGateway`. */
export interface HostModelAccessDeps {
  /** oc-modelproxy's control socket, from SP_MODEL_PROXY. */
  controlSocket?: string;
  dataDir: string;
  toGateway(m: HostToGateway): void;
  /** `key`'s runner, if it has one. */
  runner(key: string): { sock: net.Socket; report?: SessionReport; harness?: HarnessName } | undefined;
  /** The proxy came up or went away since the gateway hello: say hello again so the gateway sees whether `model-proxy` is there. */
  rehello(): void;
  tm: Telemetry;
  /** The Codex CLI runners launch (runner-env.ts `codexBin`): no `model-proxy/chatgpt` without it. */
  codexBin?: string;
}

/** How host/main.ts asks about, and tells of, each session's model route. */
export interface HostModelAccess {
  routes: {
    /** `key`'s route now: managed, its owner's subscription, or refused (absent route: managed). */
    mode(key: string): ModelRoute['mode'];
    /** Runner `id`, on `harness`, now serves `key`. */
    registered(key: string, id: string, harness?: HarnessName): void;
    /** `key`'s runner `id` is gone. */
    closed(key: string, id: string): void;
  };
  /** For the gateway hello: the features this host's model access adds (`model-proxy`, `model-proxy/chatgpt`), or none. */
  features(): string[] | undefined;
  /** A delivery's credentials and route, for `key`'s runner on `harness`: resolves to the credentials that runner gets. */
  delivered(key: string, c: HostCredentials | undefined, route: ModelRoute | undefined, harness?: HarnessName): Promise<HostCredentials | undefined>;
  /** Credentials as `key`'s runner (on `harness`, else its live runner's) gets them (welcome and `credentials` pushes go through here). */
  forRunner(key: string, c: HostCredentials | undefined, harness?: HarnessName): HostCredentials | undefined;
  /** Gateway frames about model routes (`model`, `probe`); false for every other message. */
  onGateway(m: GatewayToHost, fallback: HostCredentials | undefined): boolean;
  stop(): void;
}

/** `c` without its Claude fields: what a Codex runner gets on any route (it has no Claude credential, as model-routes.ts has it). */
export function withoutClaude(c: HostCredentials | undefined): HostCredentials {
  const { claudeOAuthToken: _o, anthropicApiKey: _k, anthropicBaseUrl: _u, ...slack } = c ?? { slackBotToken: '', slackBotUserId: '' };
  return slack;
}

/** The public build: every session on the organization's managed credentials, no proxy, nothing advertised. */
/** Takes the same deps as the hosted build, so `createHostModelAccess = noHostModelAccess` is a drop-in; only `runner` and `toGateway` are read. */
export function noHostModelAccess(o: HostModelAccessDeps): HostModelAccess {
  /** The last credentials each session's runner was delivered, re-sent on a `model` push (as the hosted build does); ends with the runner. */
  const last = new Map<string, HostCredentials>();
  const forRunner = (key: string, c: HostCredentials | undefined, harness = o.runner(key)?.harness) => (harness === 'codex' ? withoutClaude(c) : c);
  return {
    routes: {
      mode: () => 'managed',
      registered() {},
      closed(key) {
        last.delete(key);
      },
    },
    features: () => undefined,
    async delivered(key, c, route, harness) {
      if (route && route.mode !== 'managed') log.warn(`session ${key}: a ${route.mode} route on a host without a model proxy; running managed`);
      if (c) last.set(key, c);
      return forRunner(key, c, harness ?? 'claude');
    },
    forRunner,
    onGateway(m, fallback) {
      if (m.t === 'probe') {
        o.toGateway({ t: 'probed', id: m.id, error: 'proxy_unavailable' });
        return true;
      }
      if (m.t !== 'model') return false;
      if (m.model.mode !== 'managed') {
        log.warn(`session ${m.sessionKey}: a ${m.model.mode} route on a host without a model proxy; ignored`);
        return true;
      }
      const c = forRunner(m.sessionKey, last.get(m.sessionKey) ?? fallback);
      if (c) send(o.runner(m.sessionKey)?.sock, { t: 'credentials', credentials: c } satisfies HostToRunner);
      return true;
    },
    stop() {},
  };
}
