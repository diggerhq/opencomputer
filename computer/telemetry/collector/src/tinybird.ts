// Forwarding to Tinybird's Events API (work 054, "Pipeline"): one NDJSON POST
// per datasource per host batch, `wait=false`. The collector never buffers:
// anything but a 2xx is reported as a failure, the handler answers 503 and
// the host keeps the batch on disk and retries. Duplicates from a partial
// success are expected; every query deduplicates by `event_id` / `turn_id`.

import { eventLine, type TelemetryEvent, type TurnRow } from '../../../src/telemetry/envelope.js';

export const EVENTS_DATASOURCE = 'calvin_events';
export const TURNS_DATASOURCE = 'calvin_turns';
const TIMEOUT_MS = 10_000;

export interface Target {
  url: string;
  token: string;
  fetch: typeof fetch;
}

async function post(t: Target, datasource: string, lines: string[]): Promise<boolean> {
  if (!lines.length) return true;
  // Called unbound: Workers' fetch throws "Illegal invocation" as a method of `t`.
  const f = t.fetch;
  try {
    const res = await f(`${t.url.replace(/\/+$/, '')}/v0/events?name=${datasource}&wait=false`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/x-ndjson' },
      body: `${lines.join('\n')}\n`,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** True when both datasources accepted their rows. */
export async function forward(t: Target, events: TelemetryEvent[], turns: TurnRow[]): Promise<boolean> {
  const [a, b] = await Promise.all([
    post(t, EVENTS_DATASOURCE, events.map(eventLine)),
    post(
      t,
      TURNS_DATASOURCE,
      turns.map((r) => JSON.stringify(r)),
    ),
  ]);
  return a && b;
}
