// What the gateway tells a host about its organization, and what a change
// means for the runners already there (work 045, 052): the credentials from
// `welcome` and `credentials`, and the people from `welcome` and `people`.
// host/main.ts keeps the rest of `welcome` (definition, telemetry, previews).
//
// Invariants:
// - Credentials live in memory only and reach runners over their sockets,
//   shaped per session by `forRunner` (model-access.ts: Slack's, plus the
//   session's model, never a model credential); a spare's as key ''.
// - A multi-workspace gateway's welcome has only the shared agent credentials
//   (each delivery brings its workspace's Slack installation): its empty Slack
//   values must not replace live runners' after a host reconnect.
// - A `people` update reaches a running session's commits (its owner's name
//   and email) and warms new members' workspaces before their first mention.

import type net from 'node:net';
import type { GatewayToHost, HostCredentials, HostToRunner, Person } from '../protocol.js';
import { send } from '../ipc.js';
import { log } from '../log.js';

export interface UpdateTargets {
  /** The sessions' runners. */
  runners(): Iterable<{ key: string; sock: net.Socket; owner?: Person }>;
  /** The pool's spares. */
  spares(): Iterable<{ sock: net.Socket }>;
  /** Credentials as `key`'s runner gets them. */
  forRunner(key: string, c: HostCredentials): HostCredentials | undefined;
  /** Spares start once there is a model route to park with. */
  fillPool(): void;
  /** A member the gateway just learned: prepare their workspace (a no-op without workspaces). */
  prepare(p: Person): void;
}

type Welcome = Extract<GatewayToHost, { t: 'welcome' }>;
type Credentials = Extract<GatewayToHost, { t: 'credentials' }>;
type People = Extract<GatewayToHost, { t: 'people' }>;

export function gatewayUpdates(o: UpdateTargets) {
  let creds: HostCredentials | undefined;
  let people: Person[] = [];
  const push = (r: { key: string; sock: net.Socket }, c: HostCredentials) =>
    send(r.sock, { t: 'credentials', credentials: o.forRunner(r.key, c)! } satisfies HostToRunner);

  return {
    get creds() {
      return creds;
    },
    get people() {
      return people;
    },
    welcome(m: Welcome) {
      creds = m.credentials;
      people = m.people;
      if (creds.slackBotToken) for (const r of o.runners()) push(r, creds);
      for (const r of o.spares()) push({ key: '', sock: r.sock }, creds);
      o.fillPool();
    },
    credentials(m: Credentials) {
      creds = m.credentials;
      const spares = [...o.spares()];
      log.info(`credentials refreshed by the gateway; forwarding to ${[...o.runners()].length + spares.length} runner(s)`);
      for (const r of o.runners()) push(r, creds);
      for (const r of spares) push({ key: '', sock: r.sock }, creds);
      o.fillPool();
    },
    peopleChanged(m: People) {
      const known = new Set(people.map((p) => p.slackUserId));
      const added = m.people.filter((p) => !known.has(p.slackUserId));
      people = m.people;
      for (const r of o.runners()) {
        const p = r.owner && m.people.find((p) => p.slackUserId === r.owner!.slackUserId);
        if (!p || (p.gitName === r.owner!.gitName && p.gitEmail === r.owner!.gitEmail)) continue;
        r.owner = p;
        send(r.sock, { t: 'owner', owner: p } satisfies HostToRunner);
      }
      for (const p of added) o.prepare(p);
    },
  };
}
