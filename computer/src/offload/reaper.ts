// The offload reaper (work 136): terminates MicroVMs of our images that no live
// job owns. Runs at the service's start, every 60 s in it, and every 5 minutes
// from its own timer (`main.ts reap`), so a dead service still leaks nothing
// for long; AWS's own maximum duration and idle policy are the last backstop.
//
// A MicroVM (listed per configured image, TERMINATED/TERMINATING skipped) is:
// - kept while a ledger row names it, the row is not terminal and its deadline
//   has not passed;
// - terminated when a row names it otherwise (ended, or past its deadline);
// - with no row naming it, terminated once older than 10 minutes and no job
//   of ours is launching (RunMicrovm answered, row not yet updated).
// MicroVMs are not taggable (aws.ts), so the image ARN and the ledger are all
// there is to go on. A failed TerminateMicrovm (say, IAM still denying it) is
// an error for this pass; the next pass retries it.

import { TERMINAL } from '../offload-protocol.js';
import type { Aws } from './aws.js';
import type { JobRow } from './ledger.js';

const UNOWNED_GRACE = 10 * 60_000;

export interface ReapDeps {
  aws: Aws;
  rows: () => JobRow[];
  images: string[];
  now?: () => number;
}

export interface Reaped {
  terminated: { microvmId: string; why: string }[];
  kept: number;
  errors: string[];
}

export async function reap(d: ReapDeps): Promise<Reaped> {
  const now = (d.now ?? Date.now)();
  const rows = d.rows();
  const byVm = new Map(rows.filter((r) => r.microvmId).map((r) => [r.microvmId!, r]));
  const launching = rows.filter((r) => r.state === 'launching' && !r.microvmId);
  const live = (r: JobRow) => !TERMINAL.has(r.state) && (r.deadline === undefined || now <= r.deadline);
  const out: Reaped = { terminated: [], kept: 0, errors: [] };
  const seen = new Set<string>();
  for (const image of new Set(d.images)) {
    let items: Awaited<ReturnType<Aws['list']>>;
    try {
      items = await d.aws.list(image);
    } catch (e) {
      out.errors.push(`ListMicrovms ${image}: ${(e as Error)?.message ?? e}`);
      continue;
    }
    for (const vm of items) {
      const id = vm.microvmId;
      if (!id || seen.has(id) || vm.state === 'TERMINATED' || vm.state === 'TERMINATING') continue;
      seen.add(id);
      const why = verdict(id, vm.startedAt);
      if (!why) {
        out.kept++;
        continue;
      }
      try {
        await d.aws.terminate(id);
        out.terminated.push({ microvmId: id, why });
      } catch (e) {
        out.errors.push(`TerminateMicrovm ${id}: ${(e as Error)?.message ?? e}`);
      }
    }
  }
  return out;

  /** Why to terminate it, or undefined to keep it. */
  function verdict(id: string, startedAt: Date | undefined): string | undefined {
    const row = byVm.get(id);
    if (row) return live(row) ? undefined : TERMINAL.has(row.state) ? `job ${row.id} is ${row.state}` : `job ${row.id} is past its deadline`;
    const age = startedAt ? now - startedAt.getTime() : Number.POSITIVE_INFINITY;
    if (age < UNOWNED_GRACE || launching.some(live)) return undefined;
    return 'no job owns it, and no job of ours is launching';
  }
}
