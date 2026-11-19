// The host's model access (work 097, design C3, C4 and C6): every session's
// runner reaches its model through the model proxy (computer/modelproxy), and
// this module binds each runner there to its session's route. A route is a
// profile the proxy loaded plus the values of its variables, or a refusal.
// The gateway sends routes; the proxy's control socket (model-proxy.ts) takes
// binds; a runner gets only the profile's `harness` object and where to
// connect (C4), never a variable. host/main.ts sees only this file.
//
// Invariants:
// - A runner's caller at the proxy is its runner id (`single` when runners are
//   not systemd units, `-identity=single`). One caller serves one session from
//   its bind to its release; a spare's session key is `spare/<id>`.
// - A session's route is the last one its own `deliver`, `start` or `model`
//   carried, else `models[harness]` from the last `welcome` or `credentials`,
//   else none, which is bound as a refusal. Nothing is persisted: a runner
//   found again after a host restart keeps the binding the proxy holds until
//   its session's route arrives with a delivery or a `model` frame.
// - A bind the proxy refuses is bound again as a refusal naming the code; a
//   refusal is never retried, so this cannot loop. A bind with no answer in
//   5 s drops the control connection, and the next hello re-sends every bind.
// - A route change on a live runner: an equal `harness[h]` rebinds in place and
//   pushes the runner its C4; any other rebinds and tells the runner to exit
//   after its turn. A new refusal only rebinds.
// - A runner learns why its session has no route it can run on: `model` is
//   `{ refused }` with the text its caller is bound to (C3's), sent when it
//   starts and again whenever a bind of its caller is answered.
// - Proxy down (no control connection with a hello): no `profiles` in the
//   gateway hello, `model-request` answers `proxy_unavailable`, no runner or
//   spare starts, live runners are left alone; 30 s down is logged as an error.
// - Variables never reach a log, a runner or telemetry.

import { existsSync } from 'node:fs';
import type net from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { MODEL_SOCKET } from '../protocol.js';
import type { GatewayToHost, HarnessName, HostCredentials, HostToGateway, HostToRunner, ModelProfile, ModelRoute, ModelRoutes } from '../protocol.js';
import { isEventName } from '../telemetry/catalog.js';
import type { Telemetry } from '../telemetry/emitter.js';
import { send } from '../ipc.js';
import { log } from '../log.js';
import { spareKind } from '../model-key.js';
import { type ModelProxy, modelProxy, type ProxyBind, type ProxyEvent, type ProxyOptions } from './model-proxy.js';

export const NO_MODEL_CREDENTIAL = 'No model credential is configured for this computer.';
export const PROXY_DOWN = "This computer's model proxy is not running.";
export const SWITCHING = 'This thread is switching agents: it continues on the new one at your next message.';
export const noProfile = (name: string) => `This computer has no model profile \`${name}\`.`;
export const proxyRefused = (code: string) => `This computer's model proxy refused the session's credential (${code}).`;

const SPARE = 'spare/';
/** The proxy's events the host relays (computer/modelproxy/README.md); the catalog checks their data again. */
const RELAYED = new Set(['model.request', 'model.held', 'model.denied', 'model.binding', 'model.proxy_started', 'model.pool']);
const DOWN_ERROR_MS = 30_000;

export interface HostModelAccessDeps {
  /** The proxy's control socket, SP_MODEL_PROXY; unset: the proxy is down. */
  controlSocket?: string;
  /** Where runners reach the proxy's API, SP_MODEL_SOCKET; default MODEL_SOCKET. */
  modelSocket?: string;
  /** Runners are not systemd units: every runner is the proxy's caller `single`, and there are no spares. */
  single?: boolean;
  toGateway(m: HostToGateway): void;
  /** `key`'s runner, if it has one. */
  runner(key: string): { id: string; sock: net.Socket; harness?: HarnessName } | undefined;
  /** The organization's credentials, as the gateway last sent them. */
  creds(): HostCredentials | undefined;
  /** Tell `key`'s runner to exit after its turn: its route needs a new start. */
  exit(key: string): void;
  /** Whether runner `caller`'s unit still exists; a binding the proxy lists for one that does not is released. */
  unitExists(caller: string): Promise<boolean>;
  /** The profiles the host advertises changed: say hello to the gateway again. */
  rehello(): void;
  tm: Telemetry;
  /** The Codex CLI runners launch: a profile only for Codex is not advertised without it. */
  codexBin?: string;
  proxy?: ProxyOptions;
}

export type HostModelAccess = ReturnType<typeof hostModelAccess>;

/** Only `c`'s Slack fields, whatever else a gateway sent: no runner gets a model credential's value. */
export function slackOnly({ slackBotToken, slackBotUserId, teamId }: HostCredentials): HostCredentials {
  return { slackBotToken, slackBotUserId, ...(teamId !== undefined && { teamId }) };
}

interface Held {
  sessionKey: string;
  harness: HarnessName;
  /** The proxy refused this caller's route: bound as a refusal with this text until the route changes or the proxy says hello. */
  refused?: string;
  /** The latest bind, true once bound to the session's route. */
  pending?: Promise<boolean>;
}

type Resolved = ({ profile: string; vars: Record<string, string>; key: string } | { mode: 'refuse'; reason: string }) & { switching?: true };

export function hostModelAccess(o: HostModelAccessDeps) {
  const own = new Map<string, ModelRoute>();
  let models: ModelRoutes | undefined;
  /** By caller: what the host has bound there. */
  const held = new Map<string, Held>();
  /** Sessions whose runner was found after a host restart and whose route has not arrived yet. */
  const unknown = new Set<string>();
  /** The credentials each session's runner was last delivered, for a C4 push. */
  const last = new Map<string, HostCredentials>();
  let advertised = 'null';
  let downLogged = false;

  const callerOf = (id: string) => (o.single ? 'single' : id);
  const routeOf = (key: string, h: HarnessName) => own.get(key) ?? models?.[h];
  const profileOf = (name: string): ModelProfile | undefined => proxy.hello?.profiles.find((p) => p.name === name);
  const harnessOf = (route: ModelRoute | undefined, h: HarnessName) => (route?.mode === 'profile' ? profileOf(route.profile)?.harness[h] : undefined);

  function resolve(key: string, h: HarnessName): Resolved {
    const route = routeOf(key, h);
    if (!route) return { mode: 'refuse', reason: NO_MODEL_CREDENTIAL };
    if (route.mode === 'refuse') return { mode: 'refuse', reason: route.reason };
    const p = profileOf(route.profile);
    if (!p) return { mode: 'refuse', reason: noProfile(route.profile) };
    if (p.harness[h] === undefined) return { mode: 'refuse', reason: SWITCHING, switching: true };
    return { profile: route.profile, vars: route.vars, key: route.key };
  }

  /** Send `caller`'s bind; resolves true once bound to its session's route. */
  function bind(caller: string): Promise<boolean> {
    const h = held.get(caller);
    if (!h) return Promise.resolve(false);
    const { switching: _, ...b } = h.refused ? ({ mode: 'refuse', reason: h.refused } as Resolved) : resolve(h.sessionKey, h.harness);
    const p = proxy.bind({ caller, sessionKey: h.sessionKey, ...b } as ProxyBind).then((a): boolean | Promise<boolean> => {
      if (held.get(caller) !== h) return false;
      if (a.bound) {
        if (!h.sessionKey.startsWith(SPARE)) {
          o.toGateway({ t: 'model-bound', sessionKey: h.sessionKey, ...('profile' in b ? { mode: 'profile', profile: b.profile, key: b.key } : { mode: 'refuse' }) });
          tell(h.sessionKey);
        }
        return 'profile' in b;
      }
      // Down or slow: the next hello re-sends it. A refusal refused: logged, never retried.
      if (a.code === 'proxy_unavailable' || a.code === 'timeout') return false;
      if (!('profile' in b)) return log.warn(`caller ${caller}: the model proxy refused to bind ${h.sessionKey} as refused (${a.code})`), false;
      log.warn(`session ${h.sessionKey}: the model proxy refused its credential (${a.code}); its requests are refused`);
      o.tm.emit('model.profile_refused', { session_key: h.sessionKey, provider: b.profile, outcome: 'failed', data: { caller, code: a.code } });
      h.refused = proxyRefused(a.code);
      return bind(caller).then(() => false);
    });
    h.pending = p;
    return p;
  }

  /** `caller` serves `sessionKey` from now on: release it from any other session, then bind it. */
  function hold(caller: string, sessionKey: string, harness: HarnessName) {
    const was = held.get(caller);
    if (was && was.sessionKey !== sessionKey) proxy.release(caller);
    held.set(caller, { sessionKey, harness });
    return bind(caller);
  }

  /** `key`'s live runner, with its caller, when the host holds it for `key`. */
  function live(key: string) {
    const r = o.runner(key);
    const caller = r && callerOf(r.id);
    return caller && held.get(caller)?.sessionKey === key ? { r: r!, caller, h: held.get(caller)! } : undefined;
  }

  /** Push `key`'s live runner what it knows of its route now: C4, or why it has none. */
  function tell(key: string) {
    const l = live(key);
    const c = l && forRunner(key, last.get(key) ?? o.creds(), l.h.harness);
    if (c) send(l.r.sock, { t: 'credentials', credentials: c } satisfies HostToRunner);
  }

  /** `key`'s route was `before`: rebind its live runner, and push it the new C4 or tell it to exit. */
  function changed(key: string, before: ModelRoute | undefined) {
    const l = live(key);
    if (!l) return;
    const after = routeOf(key, l.h.harness);
    if (isDeepStrictEqual(before, after)) return;
    l.h.refused = undefined;
    void bind(l.caller);
    if (!after || after.mode === 'refuse') return;
    const next = harnessOf(after, l.h.harness);
    if (next !== undefined && isDeepStrictEqual(harnessOf(before, l.h.harness), next)) tell(key);
    else o.exit(key);
  }

  /** Apply a route change to the sessions in `keys`. */
  function update(keys: string[], apply: () => void) {
    const before = keys.map((k) => [k, routeOf(k, o.runner(k)?.harness ?? 'claude')] as const);
    apply();
    for (const [k, b] of before) changed(k, b);
  }

  /** `key`'s own route arrived (`route` may be absent: a delivery without one, which settles a found runner on `models`). */
  function routed(key: string, route: ModelRoute | undefined) {
    if (unknown.delete(key)) {
      if (route) own.set(key, route);
      const r = o.runner(key);
      if (r) void hold(callerOf(r.id), key, r.harness ?? 'claude');
    } else if (route) update([key], () => own.set(key, route));
  }

  function forRunner(key: string, c: HostCredentials | undefined, harness = o.runner(key)?.harness ?? 'claude'): HostCredentials | undefined {
    if (!c) return undefined;
    const slack = slackOnly(c);
    if (unknown.has(key) || !proxy.hello) return slack;
    const l = live(key);
    const refused = l?.h.harness === harness ? l.h.refused : undefined;
    const r = refused ? { reason: refused } : resolve(key, harness);
    if ('reason' in r) return { ...slack, model: { refused: r.reason } };
    const route = routeOf(key, harness) as Extract<ModelRoute, { mode: 'profile' }>;
    const { profile, key: k, owner, maxModel } = route;
    const h = harnessOf(route, harness);
    return { ...slack, model: { profile, key: k, harness: h, owner, maxModel, endpoint: { unixSocket: o.modelSocket || MODEL_SOCKET }, placeholder: proxy.hello.placeholder } };
  }

  function profiles(): ModelProfile[] | undefined {
    if (!proxy.up) return undefined;
    const codex = !!o.codexBin && existsSync(o.codexBin);
    return proxy.hello!.profiles.filter((p) => codex || Object.keys(p.harness).some((h) => h !== 'codex'));
  }

  const recheck = () => {
    const a = JSON.stringify(profiles() ?? null);
    if (a === advertised) return;
    advertised = a;
    o.rehello();
  };

  function relay(e: ProxyEvent) {
    if (!RELAYED.has(e.name) || !isEventName(e.name)) return;
    const data = Object.fromEntries(Object.entries(e.data ?? {}).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)));
    const fields = Object.fromEntries(
      Object.entries({ session_key: e.session_key, duration_ms: e.duration_ms, outcome: e.outcome, error_type: e.error_type, provider: e.profile }).filter(
        ([, v]) => v !== undefined,
      ),
    );
    o.tm.emit(e.name, { ...fields, data } as never, e.at);
  }

  const proxy: ModelProxy = modelProxy(
    o.controlSocket,
    {
      hello(hello) {
        for (const [caller, h] of held) {
          h.refused = undefined;
          void bind(caller);
        }
        for (const b of hello.bindings) {
          if (held.has(b.caller)) continue;
          void o.unitExists(b.caller).then((exists) => exists || held.has(b.caller) || proxy.release(b.caller));
        }
        recheck();
      },
      changed(up) {
        if (up) downLogged = false;
        recheck();
      },
      observed({ caller: _, ...m }) {
        if (!m.sessionKey.startsWith(SPARE)) o.toGateway({ t: 'model-observed', ...m });
      },
      event: relay,
    },
    o.proxy,
  );

  if (!o.controlSocket) log.error('SP_MODEL_PROXY is not set: the model proxy is down and no session can start');
  const watch = setInterval(() => {
    if (proxy.downSince === undefined || downLogged || Date.now() - proxy.downSince < DOWN_ERROR_MS) return;
    downLogged = true;
    log.error(`the model proxy has been down for ${Math.round((Date.now() - proxy.downSince) / 1000)} s: no session can start`);
  }, 5000);
  watch.unref();

  return {
    get up() {
      return proxy.up;
    },
    /** Seconds the proxy has been down; 0 while up (host.sample `model_proxy_down_s`). */
    downS: () => (proxy.downSince === undefined ? 0 : Math.round((Date.now() - proxy.downSince) / 1000)),
    /** For the gateway hello: the proxy's profiles this host can serve, while it is up. */
    profiles,
    /** Runner `id`, on `harness`, now serves `key`: bind it, unless it was found after a restart (its route comes later). */
    registered(key: string, id: string, harness: HarnessName = 'claude', found = false) {
      if (found) return void unknown.add(key);
      const caller = callerOf(id);
      const h = held.get(caller);
      if (h?.sessionKey !== key || h.harness !== harness) void hold(caller, key, harness);
    },
    /** Runner `id` (of `key`, '' for a spare) is gone: release its caller. Not called while the host stops. */
    closed(key: string, id: string) {
      const caller = callerOf(id);
      const h = held.get(caller);
      unknown.delete(key);
      if (o.single && h && h.sessionKey !== (key || SPARE + id)) return;
      held.delete(caller);
      proxy.release(caller);
    },
    /** Settles once `key`'s latest bind was answered (or there is none). */
    ready: async (key: string) => void (await live(key)?.h.pending),
    /** A delivery's credentials and route for `key` on `harness`: binds any change, resolves to what its runner gets. */
    async delivered(key: string, c: HostCredentials | undefined, route: ModelRoute | undefined, harness: HarnessName = 'claude') {
      if (c) last.set(key, c);
      routed(key, route);
      await live(key)?.h.pending;
      return forRunner(key, c, harness);
    },
    /** Credentials as `key`'s runner (on `harness`, else its live runner's; '' for a spare) gets them: Slack's, plus C4. */
    forRunner,
    /** The spare kind `key` on `harness` may take (model-key.ts), if its route has one. */
    kind: (key: string, harness: HarnessName) => {
      const h = harnessOf(unknown.has(key) ? undefined : routeOf(key, harness), harness);
      return h === undefined ? undefined : spareKind(harness, h);
    },
    /** Spares start while the proxy is up and `models.claude` names a profile it serves for Claude. */
    canSpare: () => !o.single && proxy.up && harnessOf(models?.claude, 'claude') !== undefined,
    /** Bind spare `id` to `models.claude` before it launches; rejects if it was not bound. */
    async spare(id: string) {
      if (await hold(id, SPARE + id, 'claude')) return;
      held.delete(id);
      proxy.release(id);
      throw new Error(`spare ${id}: the model proxy did not bind it`);
    },
    /** Spare `id` becomes `key`'s: release it, bind it to the session; rejects if it was not bound (start cold). */
    async claim(id: string, key: string, harness: HarnessName) {
      if (!(await hold(callerOf(id), key, harness))) throw new Error(`spare ${id}: the model proxy did not bind it for ${key}`);
    },
    /** Gateway frames: `model` and `model-request` are this module's (true); `welcome` and `credentials` are read for `models` and passed on. */
    onGateway(m: GatewayToHost): boolean {
      switch (m.t) {
        case 'welcome':
        case 'credentials': {
          const before = models?.claude;
          const keys = [...held.values()].map((h) => h.sessionKey).filter((k) => !k.startsWith(SPARE) && !own.has(k));
          update(keys, () => (models = m.models));
          if (!isDeepStrictEqual(before, models?.claude)) for (const [caller, h] of held) if (h.sessionKey.startsWith(SPARE)) void bind(caller);
          return false;
        }
        case 'model':
          routed(m.sessionKey, m.model);
          return true;
        case 'model-request': {
          const { t: _, ...req } = m;
          void proxy.request(req).then((r) => o.toGateway({ t: 'model-response', ...r }));
          return true;
        }
        default:
          return false;
      }
    },
    stop() {
      clearInterval(watch);
      proxy.stop();
    },
  };
}
