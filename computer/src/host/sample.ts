// `host.sample` (work 054, "Host agent"): one event a minute from every host,
// whether or not the gateway is up, so a silent host and a gateway outage are
// both visible. Machine load comes from here; runner, gateway and telemetry
// figures from the host agent.
//
// Invariants: never throws; a figure that cannot be read is left out.

import os from 'node:os';
import { statfsSync } from 'node:fs';

export interface HostFigures {
  runners: number;
  busy_runners: number;
  /** Spare runners in the warm pool (work 069). */
  spares?: number;
  oldest_fetch_age_s?: number;
  gateway_connected: boolean;
  since_gateway_message_s?: number;
  telemetry_spooled_bytes: number;
  telemetry_dropped: number;
  /** Seconds the model proxy's control socket has been down (work 097); 0 while up. A host's health fails past 30. */
  model_proxy_down_s?: number;
}

interface CpuTimes {
  idle: number;
  total: number;
}

const cpuTimes = (): CpuTimes =>
  os.cpus().reduce(
    (a, c) => {
      const t = c.times;
      return { idle: a.idle + t.idle, total: a.total + t.user + t.nice + t.sys + t.idle + t.irq };
    },
    { idle: 0, total: 0 },
  );

/** Busy share of CPU time between two readings, 0–100. */
export function cpuPct(prev: CpuTimes, next: CpuTimes): number | undefined {
  const total = next.total - prev.total;
  if (total <= 0) return undefined;
  return Math.round((1000 * (total - (next.idle - prev.idle))) / total) / 10;
}

/** A sampler: each call returns the `data` of one `host.sample`; CPU is measured since the previous call. */
export function hostSampler(dataDir: string) {
  let prev = cpuTimes();
  return (f: HostFigures): Record<string, number | boolean> => {
    const out: Record<string, number | boolean> = { ...dropUndefined(f) };
    try {
      const next = cpuTimes();
      const pct = cpuPct(prev, next);
      prev = next;
      if (pct !== undefined) out.cpu_pct = pct;
      out.load1 = Math.round(os.loadavg()[0] * 100) / 100;
      out.mem_used_mb = Math.round((os.totalmem() - os.freemem()) / 2 ** 20);
      // The machine's size, to compare KPIs across VM sizes.
      out.cpus = os.cpus().length;
      out.mem_total_mb = Math.round(os.totalmem() / 2 ** 20);
      const fs = statfsSync(dataDir);
      out.disk_free_mb = Math.round((fs.bavail * fs.bsize) / 2 ** 20);
    } catch {
      // Partial sample.
    }
    return out;
  };
}

/**
 * The data volume's size and free space for the gateway, which grows the disk
 * when it nears capacity (work 071); undefined when it cannot be read.
 */
export function diskReport(dataDir: string): { t: 'disk'; totalBytes: number; freeBytes: number } | undefined {
  try {
    const fs = statfsSync(dataDir);
    return { t: 'disk', totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize };
  } catch {
    return undefined;
  }
}

function dropUndefined<T extends object>(o: T): Record<string, number | boolean> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
