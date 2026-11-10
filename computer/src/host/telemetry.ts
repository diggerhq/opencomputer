// The host's telemetry (work 054, "Pipeline"): its own emitter, the runners'
// batches relayed after re-validation, and the disk spool shipped to the
// collector. Off unless SP_TELEMETRY_URL is set: then everything is still
// validated and discarded.
//
//   <SP_DATA>/state/telemetry/spool/        the spool (telemetry-spool.ts), on the data volume so it outlives a reboot
//   <SP_DATA>/state/telemetry/credential    the latest credential from a `welcome`, which wins over host.env's
//
// Invariants: nothing here throws into the host; every record that will not
// leave is counted and reported as `telemetry.dropped`. Only runner events
// are relayed from a runner socket. The credential is never logged.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type Batch, createTelemetry, type Telemetry } from '../telemetry/emitter.js';
import type { Dimensions, DropReason } from '../telemetry/envelope.js';
import { type Shipper, startShipper } from './telemetry-ship.js';
import { Spool } from './telemetry-spool.js';
import { checkEvent, checkTurn } from '../telemetry/validate.js';
import type { WorkspaceObserver } from '../workspaces/index.js';

export interface HostTelemetryOptions {
  dataDir: string;
  /** Collector base URL (SP_TELEMETRY_URL). Unset: telemetry off. */
  url?: string;
  /** Signed credential from host.env (SP_TELEMETRY_CREDENTIAL). */
  credential?: string;
  version: string;
  region: string;
  /** Stamped on every host event; `host_id` is updated on a pool assignment. */
  base: Dimensions;
  /** Emitter flush and spool seal period. */
  intervalMs?: number;
}

export interface HostTelemetry {
  t: Telemetry;
  /** A runner's `{ t: 'telemetry', batch }`: re-validate, then spool. */
  relay(batch: unknown): void;
  /** A renewed credential from the gateway's `welcome`, and the collector URL if host.env had none. */
  renew(credential: string, url?: string): void;
  readonly spooledBytes: number;
  /** Records dropped since start, any reason, any stage. */
  readonly dropped: number;
  /** SIGTERM: flush, seal, and try to send for at most `ms`. */
  close(ms: number): Promise<void>;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function startHostTelemetry(o: HostTelemetryOptions): HostTelemetry {
  // Under state/, which the host user owns (identity.json lives there); <SP_DATA> itself may be root's.
  const dir = path.join(o.dataDir, 'state', 'telemetry');
  const credentialFile = path.join(dir, 'credential');
  let credential = readCredential(credentialFile) ?? (o.credential || undefined);
  const pending: Partial<Record<DropReason, number>> = {};
  let extra = 0;
  const drop = (reason: DropReason, n: number) => {
    if (n <= 0) return;
    pending[reason] = (pending[reason] ?? 0) + n;
    extra += n;
  };

  let shipper: Shipper | undefined;
  let spool: Spool | undefined;
  // Sending starts with host.env's URL, or later with the one a `welcome` brings.
  const enable = (url: string) => {
    if (spool) return;
    spool = new Spool({ dir: path.join(dir, 'spool'), onDrop: drop, onFull: () => shipper?.kick() });
    shipper = startShipper({ spool, url, credential: () => credential, intervalMs: o.intervalMs });
  };
  if (o.url) enable(o.url);

  const t = createTelemetry({
    service: 'host',
    version: o.version,
    region: o.region,
    base: o.base,
    send: (b: Batch) => spool?.append(b),
  });
  const flush = () => {
    for (const [reason, count] of Object.entries(pending) as [DropReason, number][]) {
      delete pending[reason];
      t.emit('telemetry.dropped', { data: { reason, count } });
    }
    return t.flush();
  };
  const timer = setInterval(() => void flush(), o.intervalMs ?? 2000);
  timer.unref();

  return {
    t,
    relay(batch) {
      try {
        if (!isPlain(batch)) return drop('invalid', 1);
        const raw = { events: Array.isArray(batch.events) ? batch.events : [], turns: Array.isArray(batch.turns) ? batch.turns : [] };
        const out: Batch = { events: [], turns: [] };
        for (const e of raw.events) {
          const c = checkEvent(e);
          if (c.ok && c.value.service_name === 'runner') out.events.push(c.value);
          else drop('invalid', 1);
        }
        for (const r of raw.turns) {
          const c = checkTurn(r);
          // The runner can't know the host's version; the row carries it from here.
          if (c.ok) out.turns.push({ ...c.value, host_version: c.value.host_version || o.version });
          else drop('invalid', 1);
        }
        spool?.append(out);
      } catch {
        drop('invalid', 1);
      }
    },
    renew(next, url) {
      if (url && /^https?:\/\//.test(url)) {
        try {
          enable(url);
        } catch {
          // Stays off until a restart.
        }
      }
      if (!next || next === credential) return;
      credential = next;
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(credentialFile, `${next}\n`, { mode: 0o600 });
      } catch {
        // Kept in memory; host.env's applies again after a restart until the next welcome.
      }
    },
    get spooledBytes() {
      return spool?.spooledBytes ?? 0;
    },
    get dropped() {
      return extra + Object.values(t.dropped).reduce((a, b) => a + (b ?? 0), 0);
    },
    async close(ms) {
      clearInterval(timer);
      await flush();
      spool?.seal();
      await shipper?.drain(ms);
    },
  };
}

/** Workspace timings as `fork.repo` and `housekeeping.fetch`; `context` gives the fields of the delivery a fork is for. */
export function workspaceTelemetry(tm: Telemetry, context: () => Dimensions | undefined): WorkspaceObserver {
  return {
    repoForked: (x) =>
      tm.emit('fork.repo', { ...context(), duration_ms: x.ms, outcome: 'completed', data: { repo: x.repo, fetch_ms: x.fetchMs,
        worktree_ms: x.worktreeMs, lock_wait_ms: x.lockWaitMs, fetch_skipped: x.fetchSkipped, fetch_error_type: x.fetchError } }),
    repoFetched: (x) =>
      tm.emit('housekeeping.fetch', { duration_ms: x.ms, outcome: x.fetchError ? 'failed' : 'completed',
        error_type: x.fetchError === 'timeout' ? 'timeout' : x.fetchError ? 'git_fetch' : undefined,
        data: { repo: x.repo, fast_forwarded: x.fastForwarded, trigger: x.trigger } }),
  };
}

function readCredential(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}
