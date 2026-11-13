// The runner's model access (work 097, design C4 and C5): what the session's
// route, as the host sends it in `credentials.model`, means for this runner.
// Every model request goes through the host's model proxy; the runner learns
// the profile's `harness` object for its own harness, where to connect and
// the placeholder to send, never a credential. Each harness's adapter
// validates its own object: Claude Code's (harness/claude/model-env.ts) sets
// the environment Claude Code is spawned from; Codex reads `{}` and takes
// only the endpoint and placeholder (its loopback and config.toml).
//
// Invariants:
// - An absent `model` keeps the current one. A later `model` whose `harness`
//   object, endpoint or placeholder differs moves a session's runner to
//   another harness environment: 'switch', it finishes its turn and exits. A
//   changed `key` (or profile name, owner, ceiling) alone changes nothing in
//   the environment. A spare has no turn: it applies the new one and parks
//   again.
// - A refused route (`{ refused }`: the host bound the session to no
//   credential) refuses the turn with the host's reason and leaves the
//   environment as it is; the next route clears it. No route, or a `harness`
//   object its adapter does not accept: the turn is refused with NO_FIT, and
//   nothing is set.
// - A refused model steps down only when the profile says
//   `downgradeOnModelRefusal`; `maxModel` caps the session on any route.
// - Nothing here throws.

import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { Effect } from 'effect';
import type { HarnessName, RunnerModel, RunnerRefused, RunnerToHost } from '../protocol.js';
import { log } from '../log.js';
import { spareKind } from '../model-key.js';
import type { CacheTtlSettings } from './cache-ttl.js';
import { ClaudeModel, claudeModelEnv, clearClaudeModelEnv } from './harness/claude/model-env.js';
import type { HarnessEvent } from './harness/types.js';
import { RETRY_TEXT, aboveCeiling, deniedLine, nextDown } from './model-downgrade.js';
import type { Session } from './session.js';

export const NO_FIT = "This computer's model profile does not fit this agent.";

/** Each harness's `harness[h]` object. Codex reads nothing from it (design C5). */
const ADAPTERS = { claude: ClaudeModel, codex: z.strictObject({}) } satisfies Record<HarnessName, z.ZodType>;

/** What runner/main.ts hands the model access. */
export interface RunnerModelAccessDeps {
  /** The runner's environment, which its harness is spawned from. */
  env: NodeJS.ProcessEnv;
  cacheTtl: CacheTtlSettings;
  hooks: RunnerModelAccessHooks;
}

export interface RunnerModelAccessHooks {
  session(): Session | undefined;
  /** The harness this runner runs: its session's, else Claude (a spare parks Claude Code). */
  harness(): HarnessName;
  out(m: RunnerToHost): void;
  /** Telemetry: a refused model was stepped down. */
  downgraded(from: string, to: string): void;
}

/** Where the model client connects and what it sends as its credential (design C4). */
export type Endpoint = { unixSocket: string; placeholder: string };

export type RunnerModelAccess = ReturnType<typeof runnerModelAccess>;

export function runnerModelAccess({ env, cacheTtl, hooks: o }: RunnerModelAccessDeps) {
  /** The route this runner's environment was set for. */
  let cur: RunnerModel | undefined;
  /** Its `harness` object as the adapter read it; undefined: none, or malformed. */
  let read: z.infer<(typeof ADAPTERS)[HarnessName]> | undefined;
  /** The proxy's endpoint, kept across a reset: it is the host's, not the route's. */
  let endpoint: Endpoint | undefined;
  /** The host's reason it binds this runner's session to no credential. */
  let refused: string | undefined;
  let retry = false;

  const same = (a: RunnerModel, b: RunnerModel) =>
    isDeepStrictEqual([a.harness, a.endpoint, a.placeholder], [b.harness, b.endpoint, b.placeholder]);

  /** The route's ceiling on the session: `!model` stays at or below it, and a model above it moves down now. */
  function cap() {
    const s = o.session();
    if (!s) return;
    s.maxModel = cur?.maxModel;
    if (aboveCeiling(s.model, s.maxModel)) {
      s.info.model = s.maxModel!;
      s.persist();
    }
  }

  return {
    /** The route's profile name (telemetry `provider`). */
    profile: () => cur?.profile,
    endpoint: () => endpoint,
    /** The spare kind of the environment Claude Code is started from (model-key.ts). */
    kind: () => (cur && read ? spareKind('claude', cur.harness) : undefined),
    /** The host's refusal, else NO_FIT while this runner has no route its harness's adapter accepts. */
    refusal: () => refused ?? (read ? undefined : NO_FIT),
    /** A spare claimed for Codex: the route it parked Claude Code on is not the session's. */
    reset() {
      cur = read = undefined;
      clearClaudeModelEnv(env);
    },
    /** A session became this runner's (a claim): the route's ceiling applies to it. */
    cap,
    /**
     * `credentials.model` from the host: 'set' once the environment is set for it (start or re-park the harness),
     * 'switch' when the session's runner should finish its turn and exit, undefined when nothing changed.
     */
    apply(m: RunnerModel | RunnerRefused | undefined): 'set' | 'switch' | undefined {
      if (!m) return undefined;
      if ('refused' in m) {
        refused = m.refused;
        return undefined;
      }
      refused = undefined;
      if (cur && !same(cur, m) && o.session()) return 'switch';
      const changed = !cur || !same(cur, m);
      cur = m;
      cap();
      if (!changed) return undefined;
      endpoint = { unixSocket: m.endpoint.unixSocket, placeholder: m.placeholder };
      const h = o.harness();
      const r = ADAPTERS[h].safeParse(m.harness);
      read = r.success ? r.data : undefined;
      if (!r.success) {
        log.warn(`model profile ${m.profile}: its ${h} settings are not this runner's (${r.error.issues.map((i) => i.path.join('.') || i.message).join(', ')})`);
        if (h === 'claude') clearClaudeModelEnv(env);
        return undefined;
      }
      if (h === 'claude') claudeModelEnv(env, r.data as ClaudeModel, m.endpoint.unixSocket, m.placeholder, cacheTtl);
      return 'set';
    },
    /** A harness record: a refused model (the main thread's) steps down one family, and the turn is retried when it ends. */
    async event(e: HarnessEvent) {
      const s = o.session();
      if (!s || !(read as ClaudeModel | undefined)?.downgradeOnModelRefusal || !(e.t === 'error' && e.code === 'model_not_found')) return;
      const from = s.model;
      const to = nextDown(from);
      if (!to) return;
      try {
        await Effect.runPromise(s.ensureHarness().setModel(to));
      } catch (e: any) {
        return log.warn(`downgrade to ${to}:`, e?.message ?? e);
      }
      s.info.model = to;
      s.persist();
      s.maxModel = to;
      retry = true;
      o.out({ t: 'model-denied', model: from, fallbackTo: to });
      o.downgraded(from, to);
      await s.say(deniedLine(from, to));
    },
    /** The turn ended; true when it is retried (on the lower model). */
    idle(): boolean {
      const s = o.session();
      if (!retry || !s) return false;
      retry = false;
      void s.send(RETRY_TEXT, s.info.userId);
      return true;
    },
  };
}
