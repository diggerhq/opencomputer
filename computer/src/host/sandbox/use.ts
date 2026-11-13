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
  async function enter(id: string): Promise<Use> {
    await d.as.settled(d.waitMs ?? WAIT_MS);
    const r = d.records.get(id);
    if (!r) throw new Unavailable('The session has no files on this computer any more.', false);
    return { place: { id, person: r.person, workspace: d.workspace(r), running: await d.unitActive(id) }, leave() {} };
  }
  return { enter };
}
