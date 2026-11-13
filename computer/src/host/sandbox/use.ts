// Using a thread's sandbox from outside a turn of the agent (work 103, C13):
// what a `/files` script and a terminal do before they start anything in a
// container. `enter` answers where the thread is at this moment, and whoever
// entered says when it has left.
//
// Invariants:
// - Nothing is started for a person while provisioning holds Podman's
//   storage: `enter` waits for the image lock, WAIT_MS at most (less than the
//   relay waits for the host's answer, 15 s), and is refused with Unavailable
//   past it. So such a call never hangs for the minutes an image takes.
// - Where the thread is (its container running or not, its workspace) is read
//   when it is entered, from the thread's record and its unit: never taken
//   from what an earlier call was told. A thread whose record is gone has
//   nothing to enter.
// - A script never runs over a workspace that is being removed, and nothing
//   is removed under a script or a terminal: a thread is in use from the
//   moment it is entered (before any wait) until it is left, whoever removes
//   a stopped thread's files claims it first (prune.ts, artifacts.ts), and
//   neither happens between the other's check and its act, both being one
//   step of this process. A claim is refused while the thread is in use, and
//   when it was used since the claimer looked at its files (`since`): what
//   git said before an upload is old. While claimed, nothing enters.
// - A use does not take the thread's turn (thread-lock.ts): a download of an
//   hour would hold every message to the thread behind it. A start and a
//   `/files` helper may work on one workspace at once, as a session and its
//   own `/files` scripts do.
// - In memory only, like the turns: a host that restarts has no script and
//   no terminal of its own left to protect.

import { Unavailable } from '../unavailable.js';
import type { AsRunner } from './podman.js';
import type { Records, SandboxRecord } from './records.js';
import type { SandboxPlace } from './scripts.js';

/** How long a person's call waits for the image lock. */
export const WAIT_MS = 10_000;

export interface Use {
  place: SandboxPlace;
  /** The script or the terminal is over. Once; more calls do nothing. */
  leave(): void;
}

export interface UsesDeps {
  as: Pick<AsRunner, 'settled'>;
  records: Pick<Records, 'get'>;
  /** The record's workspace on the host (mounts.ts). */
  workspace(r: SandboxRecord): string;
  /** `containers.unitActive`. */
  unitActive(id: string): Promise<boolean>;
  waitMs?: number;
}

export type SandboxUses = ReturnType<typeof sandboxUses>;

export function sandboxUses(d: UsesDeps) {
  /** Uses not yet left, and when the last one was, by sandbox id. */
  const open = new Map<string, number>();
  const last = new Map<string, number>();
  const claimed = new Set<string>();

  async function enter(id: string): Promise<Use> {
    if (claimed.has(id)) throw new Unavailable("The session's files are being cleaned up, try again in a minute.");
    open.set(id, (open.get(id) ?? 0) + 1);
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      const n = (open.get(id) ?? 1) - 1;
      if (n > 0) open.set(id, n);
      else open.delete(id);
      last.set(id, Date.now());
    };
    try {
      await d.as.settled(d.waitMs ?? WAIT_MS);
      const r = d.records.get(id);
      if (!r) throw new Unavailable('The session has no files on this computer any more.', false);
      return { place: { id, person: r.person, workspace: d.workspace(r), running: await d.unitActive(id) }, leave };
    } catch (e) {
      leave();
      throw e;
    }
  }

  /**
   * For whoever removes files of a stopped thread: the thread, until the function returned is called. Undefined when a
   * script or a terminal is in it, was in it at or after `since` (ms), or somebody else has it.
   */
  function claim(id: string, since: number): (() => void) | undefined {
    if (open.has(id) || claimed.has(id) || (last.get(id) ?? -1) >= since) return undefined;
    claimed.add(id);
    return () => void claimed.delete(id);
  }

  return { enter, claim };
}
