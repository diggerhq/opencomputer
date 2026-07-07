// Schedules sub-resource of `oc.agents` (design 015) — cron for agents. A schedule fires an agent on
// a cron; each firing starts one session on the active revision with a fixed input. The HTTP layer
// converts camelCase ⟷ snake_case on the wire, so params/results here are camelCase.

import type { Http, Query } from "./http.js";

export type Overlap = "skip" | "allow";
export type ScheduleState = "active" | "paused" | "auto_paused";
export type RunOutcome = "enacted" | "skipped" | "failed";

export interface CreateScheduleParams {
  name: string;             // ^[a-z0-9][a-z0-9-]{0,63}$, unique per agent
  cron: string;             // 5-field cron (1-minute resolution)
  tz?: string | null;       // IANA name; omit for UTC
  input: string;            // first user message of every run (≤ 32 KiB)
  overlap?: Overlap;        // default "skip"
}

export interface UpdateScheduleParams {
  cron?: string;
  tz?: string | null;
  input?: string;
  overlap?: Overlap;
  paused?: boolean;         // true = pause, false = resume (recomputes next fire, resets failures)
}

export interface Schedule {
  id: string;               // sch_…
  agentId: string;
  name: string;
  cron: string;
  tz: string | null;
  input: string;
  overlap: Overlap;
  state: ScheduleState;
  nextFireAt: string;       // UTC ISO
  lastFiredAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRun {
  id: string;               // srn_…
  scheduleId: string;
  scheduledFor: string | null;   // the cron slot; null for a manual fire
  firedAt: string;
  outcome: RunOutcome;
  sessionId: string | null;      // chain into oc.sessions.get(sessionId)
  error: string | null;
}

export interface RunsPage { runs: ScheduleRun[]; nextCursor?: string | null; }

/** Cron for agents. Schedules live on the agent — every method takes the agent id first.
 *  `oc.agents.schedules.create(agentId, { name, cron, input })`. */
export class Schedules {
  constructor(private readonly http: Http) {}

  create(agentId: string, params: CreateScheduleParams): Promise<{ schedule: Schedule }> {
    return this.http.request("POST", `/agents/${agentId}/schedules`, { body: params });
  }
  list(agentId: string): Promise<{ schedules: Schedule[] }> {
    return this.http.request("GET", `/agents/${agentId}/schedules`);
  }
  get(agentId: string, scheduleId: string): Promise<{ schedule: Schedule }> {
    return this.http.request("GET", `/agents/${agentId}/schedules/${scheduleId}`);
  }
  update(agentId: string, scheduleId: string, params: UpdateScheduleParams): Promise<{ schedule: Schedule }> {
    return this.http.request("PATCH", `/agents/${agentId}/schedules/${scheduleId}`, { body: params });
  }
  delete(agentId: string, scheduleId: string): Promise<void> {
    return this.http.request("DELETE", `/agents/${agentId}/schedules/${scheduleId}`);
  }
  /** Test-fire now — enacts synchronously in any state (paused included), does not advance the cron.
   *  Returns the run; branch on `run.outcome` (a failed fire is still a 201 with `outcome:"failed"`). */
  fire(agentId: string, scheduleId: string): Promise<{ run: ScheduleRun }> {
    return this.http.request("POST", `/agents/${agentId}/schedules/${scheduleId}/fire`);
  }
  /** Run history, newest-first. Each run carries `sessionId` to chain into `oc.sessions.get`. */
  runs(agentId: string, scheduleId: string, opts: { cursor?: string; limit?: number } = {}): Promise<RunsPage> {
    return this.http.request("GET", `/agents/${agentId}/schedules/${scheduleId}/runs`, { query: opts as Query });
  }
}


