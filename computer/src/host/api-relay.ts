// What the host tells the relay (work 084): its key (the previews key), the
// organization's admins, and each session's access, as the gateway's frames
// carry them; the link to the relay's local socket (api-wire.ts) is started on
// the first v4 welcome and gets all of it then.
//
// Invariants:
// - The host keeps the latest of each whether or not the link is up, and a
//   link that comes up (or comes up again after failing to start) gets all of
//   it before anything else, so the relay never serves on less than the host knows.
// - A frame without a key never clears one: a welcome from a gateway that could
//   not read the previews config keeps the key the relay has, and a later
//   `previews` frame keys a relay whose welcome carried none.

import type { Person, SessionAccess } from '../protocol.js';
import { log } from '../log.js';
import type { WireLink, WireLinkHooks } from './wire-link.js';

/** What the relay's local socket needs from the host, and how the host drives it (wire-link.ts). */
export type WireHooks = Required<WireLinkHooks>;
export type WireLinkLike = Pick<WireLink, 'setKey' | 'setAccess' | 'setAdmins' | 'revoked' | 'moved' | 'close'>;

export function apiRelay(serve: ((hooks: WireHooks) => Promise<WireLinkLike>) | undefined, hooks: WireHooks) {
  let link: WireLinkLike | undefined;
  let starting = false;
  let key: string | null = null;
  let admins: string[] = [];
  const access = new Map<string, SessionAccess>();

  const setKey = (k: string | null) => {
    if (k === key) return;
    key = k;
    link?.setKey(k);
  };

  return {
    /** Start the link once (a failed start is tried again on the next call). */
    start() {
      if (starting || link || !serve) return;
      starting = true;
      serve(hooks).then(
        (w) => {
          link = w;
          w.setKey(key);
          w.setAdmins(admins);
          for (const a of access.values()) w.setAccess(a);
        },
        (e) => log.warn(`wire link not started: ${e?.message ?? e}`),
      ).finally(() => (starting = false));
    },
    /** A welcome's key; absent, the relay keeps the one it has. */
    welcome(k: string | undefined) {
      setKey(k ?? key);
    },
    /** The organization's tunnel config: its previews key is the relay's key. */
    previews(k: string) {
      setKey(k);
    },
    people(people: Person[]) {
      admins = people.flatMap((p) => (p.admin && p.userId ? [p.userId] : []));
      link?.setAdmins(admins);
    },
    access(a: SessionAccess) {
      access.set(a.sessionId, a);
      link?.setAccess(a);
    },
    revoked(keyId: string) {
      link?.revoked(keyId);
    },
    /** The session's writer moved (a runner started or exited, a hand-off). */
    moved(sessionId: string) {
      link?.moved(sessionId);
    },
    async close() {
      await link?.close().catch(() => {});
    },
  };
}

export type ApiRelay = ReturnType<typeof apiRelay>;
