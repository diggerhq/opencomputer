// The subagents running in a session (work 084), as the runner reports them
// (SessionReport.subagents) and holds its idle exit for: from the harness's
// task records, whether or not the API is attached.

import type { HarnessEvent } from '../harness/types.js';

type TaskRecord = Extract<HarnessEvent, { t: 'task' }>;

export class RunningSubagents {
  private ids = new Set<string>();

  get size() {
    return this.ids.size;
  }

  /** Take a task record; true when the count changed. */
  seen(e: TaskRecord): boolean {
    const n = this.ids.size;
    if (e.state === 'started' || e.state === 'progress') this.ids.add(e.id);
    else this.ids.delete(e.id);
    return n !== this.ids.size;
  }
}
