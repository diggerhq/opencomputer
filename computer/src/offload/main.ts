// The build offload service (work 136): one per self-hosted box that opted in,
// as its own user (`oc-offload`), the only process there with AWS credentials
// (the instance role, through the one IMDS exception). Started by
// opencomputer-offload.service; the reaper timer runs `reap`.
//
//   node --import tsx src/offload/main.ts serve | check-aws | reap | drain [--timeout N] | health
//
//   serve      the control socket (control.ts), jobs (jobs.ts), the reaper every 60 s; SIGTERM drains:
//              new work refused, every MicroVM terminated (25 s at most, inside the unit's TimeoutStopSec=30)
//   check-aws  exit 0 AWS with an instance role, 1 not AWS, 2 AWS without a role; one line, never a credential
//   reap       one reaper pass (reaper.ts), reading the ledger without writing it
//   drain      ask the running service to drain; exit 0 once every MicroVM is gone
//   health     the running service's health as JSON; exit 1 when it is not ready
//
// Settings: config.ts (selfhost.env, read only with the enable marker).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type Health, OFFLOAD_CONTROL, OFFLOAD_SIZES, askLine } from '../offload-protocol.js';
import { log } from '../log.js';
import { aws } from './aws.js';
import { DRAIN_MARKER, ENABLE_MARKER, type OffloadConfig, loadOffloadConfig } from './config.js';
import { serveControl } from './control.js';
import { checkAwsResult, detectAws } from './detect.js';
import { type Jobs, offloadJobs } from './jobs.js';
import { openLedger, readLedger } from './ledger.js';
import { reap } from './reaper.js';

const env = process.env;
const [cmd, ...args] = process.argv.slice(2);
const dmi = (name: string) => {
  try {
    return readFileSync(`/sys/class/dmi/id/${name}`, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
};
const detect = () => detectAws({ dmi, fetch });
/** The host's group, for the control socket (control.ts). */
const hostGid = (name = env.SP_OFFLOAD_GROUP || 'sp-host') => {
  try {
    const line = readFileSync('/etc/group', 'utf8').split('\n').find((l) => l.startsWith(`${name}:`));
    const gid = Number(line?.split(':')[2]);
    return Number.isInteger(gid) ? gid : undefined;
  } catch {
    return undefined;
  }
};

function loaded() {
  const l = loadOffloadConfig(env, existsSync(ENABLE_MARKER));
  for (const w of l.warnings) log.warn(w);
  return l;
}

async function serve() {
  const { config, off } = loaded();
  if (!config) return log.info(off ?? 'offload is off'), 0;
  const det = await detect();
  let notReady = !det.aws ? `not AWS: ${det.why}` : !det.role ? 'this instance has no role for offload' : undefined;
  let jobs: Jobs | undefined;
  if (!notReady && det.aws) {
    const ledger = openLedger(config.stateDir);
    if (ledger.skipped) log.warn(`offload ledger: ${ledger.skipped} lines skipped`);
    const a = aws({ region: config.region ?? det.region, bucket: config.bucket });
    jobs = offloadJobs({ config, aws: a, ledger, logsDir: path.join(config.stateDir, 'logs'), hostTag: det.instanceId, paused: () => existsSync(DRAIN_MARKER) });
    await jobs.recover();
    const pass = () => reap({ aws: a, rows: () => ledger.all(), images: Object.values(config.images) }).then(
      (r) => {
        for (const t of r.terminated) log.info(`offload reaper: terminated ${t.microvmId}: ${t.why}`);
        for (const e of r.errors) log.warn(`offload reaper: ${e}`);
      },
      (e) => log.warn(`offload reaper: ${e?.message ?? e}`),
    );
    await pass();
    setInterval(() => (jobs!.tick(), void pass()), 60_000).unref();
  }
  const health = (): Health => {
    const marker = existsSync(DRAIN_MARKER);
    const draining = !!jobs?.draining || marker;
    const reason = notReady ?? (draining ? 'offload is draining on this host' : undefined);
    return { ready: !reason, reason, draining, ...(jobs?.counts() ?? { running: 0, queued: 0 }), ...limits(config) };
  };
  const drain = async (sec = 25) => (jobs ? jobs.drain(Math.min(Math.max(sec, 1), 600) * 1000) : true);
  const server = serveControl(config.control, { jobs, health, drain }, hostGid());
  log.info(`offload service on ${config.control}: ${notReady ?? 'ready'}`);
  let stopping = false;
  process.on('SIGTERM', () => {
    if (stopping) return;
    stopping = true;
    notReady = 'the offload service is stopping';
    void drain(25).then((all) => {
      if (!all) log.warn('offload: MicroVMs still running at stop; the reaper and their maximum duration end them');
      server.close();
      process.exit(0);
    });
  });
  return undefined;
}

const limits = (c: OffloadConfig) => ({
  maxConcurrent: c.maxConcurrent, maxMinutes: c.maxMinutes, sourceMaxMb: c.sourceMaxMb, artifactMaxMb: c.artifactMaxMb,
  sizes: OFFLOAD_SIZES.filter((s) => c.images[s]),
});

async function reapOnce() {
  const { config, off } = loaded();
  if (!config) return console.log(off), 0;
  const det = await detect();
  if (!det.aws || !det.role) return console.log(checkAwsResult(det).line), 0;
  const { rows } = readLedger(config.stateDir);
  const a = aws({ region: config.region ?? det.region, bucket: config.bucket });
  const r = await reap({ aws: a, rows: () => [...rows.values()], images: Object.values(config.images) });
  for (const t of r.terminated) console.log(`terminated ${t.microvmId}: ${t.why}`);
  for (const e of r.errors) console.error(e);
  console.log(`reaper: ${r.terminated.length} terminated, ${r.kept} kept`);
  return r.errors.length ? 1 : 0;
}

const control = () => env.SP_OFFLOAD_CONTROL?.trim() || OFFLOAD_CONTROL;

async function main(): Promise<number | undefined> {
  switch (cmd) {
    case 'serve': return serve();
    case 'check-aws': {
      const { code, line } = checkAwsResult(await detect());
      console.log(line);
      return code;
    }
    case 'reap': return reapOnce();
    case 'drain': {
      const i = args.indexOf('--timeout');
      const timeoutSec = i >= 0 ? Number(args[i + 1]) : 25;
      const r = await askLine(control(), { op: 'drain', timeoutSec }, (timeoutSec + 5) * 1000);
      console.log(JSON.stringify(r));
      return r.ok && r.drained ? 0 : 1;
    }
    case 'health': {
      const r = await askLine(control(), { op: 'health' }, 5000).catch((e) => ({ ok: false, ready: false, reason: `offload service not reachable: ${e?.message ?? e}` }));
      console.log(JSON.stringify(r));
      return r.ok && (r as { ready?: boolean }).ready ? 0 : 1;
    }
    default:
      console.error('usage: main.ts serve | check-aws | reap | drain [--timeout N] | health');
      return 64;
  }
}

main().then(
  (code) => code !== undefined && process.exit(code),
  (e) => {
    console.error(`offload ${cmd}: ${e?.message ?? e}`);
    process.exit(1);
  },
);
