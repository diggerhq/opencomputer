// End-to-end check of sessions in containers (work 103), on a computer: the
// host agent with SP_LAUNCH=podman against a fake gateway in this process,
// runners rendering to a fake Slack client (SP_FAKE_SLACK=1, read back with
// `podman logs`). No model call: every delivery is `!status`.
//
// It checks a new thread (record, container, unit, cgroup, run directory,
// token socket, the report's path), a warm delivery, the idle exit (container
// exited, home and record kept) and the resume under the same id with the
// home intact; and it prints what each start took.
//
// It needs what deploy/vm/provision.sh sets up (the runners' user and its
// Podman, the session image, the run and state directories), so it runs on a
// computer, as the host's user, from a release, and not in CI:
//   cd /opt/slack-presence/current && set -a && . ./.sp-version.env && set +a && \
//     sudo -u sp-host env SP_RUNNER_USER=agent SP_IMAGE="$SP_IMAGE" SP_IMAGE_ABI="$SP_IMAGE_ABI" \
//       node --import tsx src/dev/sandbox-check.ts [--keep]
//
// Invariants:
// - It refuses to run beside a host agent: it uses the computer's own SP_RUN
//   and SP_DATA, because the runners' user is set up for those and no others.
// - It removes what it made (container, home volume, record, run directory,
//   the person directory `sandbox-check`), pass or fail, unless `--keep`.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import type net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { runnerUser } from '../host/runner-user.js';
import { asRunner } from '../host/sandbox/podman.js';
import { containerName, unitName, unshareRmArgs, volumeName } from '../host/sandbox/podman-args.js';
import { sandboxRecords } from '../host/sandbox/records.js';
import { runnersDir, sandboxRunFor, secretsFor, socketFor, tokenSocketFor } from '../ipc.js';
import type { GatewayToHost, HostToGateway, SessionSpec, TraceContext } from '../protocol.js';
import { type TelemetryEvent, uuidv7 } from '../telemetry/envelope.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const KEEP = process.argv.includes('--keep');
const RUN = process.env.SP_RUN ?? '/run/slack-presence';
const DATA = process.env.SP_DATA ?? '/data';
const PERSON = 'sandbox-check';
const KEY = `C_SANDBOX:${Date.now() / 1000}`;
const IDLE_MS = 8000;

const t0 = Date.now();
const say = (...a: unknown[]) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
let failed = 0;
const check = (ok: boolean, what: string) => {
  say(ok ? 'PASS' : 'FAIL', what);
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | undefined | Promise<T | undefined>, ms = 30_000): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await f();
    if (v) return v;
  }
}
const refuse = (why: string): never => {
  console.error(`sandbox-check: ${why}`);
  process.exit(2);
};

const user = runnerUser(process.env) ?? refuse('set SP_RUNNER_USER (the runners\' user, `agent` on a computer)');
if (!process.env.SP_IMAGE || !process.env.SP_IMAGE_ABI) refuse("set SP_IMAGE and SP_IMAGE_ABI (the release's .sp-version.env has both)");
if (!existsSync(path.join(ROOT, 'dist/runner-boot.mjs'))) refuse(`${ROOT} has no dist/runner-boot.mjs: run it from a release (node scripts/bundle-runner.mjs builds one)`);
try {
  execFileSync('/usr/bin/systemctl', ['is-active', '--quiet', 'slack-presence-host.service']);
  refuse('slack-presence-host is running here; this check would be a second host on its directories');
} catch {
  // not active: the directories are ours for the run
}
const as = asRunner(user.sudo);
const podman = (args: string[], timeoutMs = 30_000) => as.podman(args, { timeoutMs });
/** Read anew at every use: the host writes the records. */
const records = () => sandboxRecords(path.join(DATA, 'state', 'sandboxes'));
const recordOf = () => records().find(PERSON, KEY);

// ---- fake collector (the host's telemetry) and fake gateway

const tel: TelemetryEvent[] = [];
const collector = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c)).on('end', () => {
    tel.push(...JSON.parse(body).events);
    res.writeHead(202).end();
  });
});
await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
function mkTrace(): TraceContext {
  const now = Date.now();
  return { id: uuidv7(now), sentAt: now - 40, receivedAt: now - 20, dispatchedAt: now, surface: 'slack', surfaceWorkspaceId: 'T_CHECK', conversationId: 'C_SANDBOX', personId: 'U_OWNER' };
}
const launched = (trace: TraceContext) => tel.find((e) => e.trace_id === trace.id && e.event_name === 'runner.launched');

const events: HostToGateway[] = [];
const tokenSessions: (string | undefined)[] = [];
let conn: WebSocket | undefined;
const wss = new WebSocketServer({ port: 0, path: '/host', verifyClient: ({ req }: { req: http.IncomingMessage }) => req.headers.authorization === 'Bearer check-token' });
await new Promise((r) => wss.on('listening', r));
const toHost = (m: GatewayToHost) => conn?.send(JSON.stringify(m));
const owner = { slackUserId: 'U_OWNER', dir: PERSON, gitName: 'Sandbox Check', gitEmail: 'check@example.com' };
wss.on('connection', (c) => {
  conn = c;
  c.on('message', (d) => {
    const m = JSON.parse(String(d)) as HostToGateway;
    events.push(m);
    if (m.t === 'hello') toHost({ t: 'welcome', protocol: 1, credentials: { slackBotToken: '', slackBotUserId: '' }, people: [owner] });
    if (m.t === 'token') {
      tokenSessions.push(m.sessionKey);
      toHost({ t: 'token', id: m.id, result: { token: `ghs_fake${tokenSessions.length}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
    }
  });
});
const spec: SessionSpec = { key: KEY, kind: 'thread', channel: 'C_SANDBOX', threadTs: KEY.split(':')[1], owner, title: 'sandbox check', mode: 'bypassPermissions' };
const credentials = { slackBotToken: 'xoxb-fake', slackBotUserId: 'U_BOT' };
let ts = 1;
async function deliver(trace = mkTrace()) {
  const id = randomUUID();
  const at = Date.now();
  toHost({ t: 'deliver', id, session: spec, msg: { userId: 'U_OWNER', text: '!status', ts: `3.${ts++}` }, credentials, trace });
  const reply = await until(() => events.find((e): e is Extract<HostToGateway, { t: 'reply' }> => e.t === 'reply' && e.id === id), 120_000);
  return { reply, ms: Date.now() - at, trace };
}
const reports = () => events.flatMap((e) => (e.t === 'session' && e.report.key === KEY ? [e.report] : []));

// ---- the host, and what the check reads of a container

function startHost(): ChildProcess {
  const { SP_DEFINITION, WORKDIR, SLACK_BOT_TOKEN, ...rest } = process.env;
  const h = spawn(process.execPath, ['--import', 'tsx', 'src/host/main.ts'], {
    cwd: ROOT,
    env: { ...rest, SP_GATEWAY_URL: `ws://127.0.0.1:${(wss.address() as net.AddressInfo).port}/host`, SP_HOST_TOKEN: 'check-token', SP_HOST_ID: 'sandbox-check',
      SP_RUN: RUN, SP_DATA: DATA, SP_IDLE_MS: String(IDLE_MS), SP_LAUNCH: 'podman', SP_POOL_SIZE: '0', SP_FAKE_SLACK: '1',
      SP_TELEMETRY_URL: `http://127.0.0.1:${(collector.address() as net.AddressInfo).port}`, SP_TELEMETRY_CREDENTIAL: 'check-credential', SP_REGION: 'local', SP_SUBSTRATE: 'vm' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const s of [h.stdout!, h.stderr!]) s.on('data', (d) => process.stdout.write(String(d).replace(/^(?=.)/gm, '    host| ')));
  return h;
}
const inspect = (id: string, format: string) => podman(['inspect', '--format', format, containerName(id)]).then((s) => s.trim(), () => '');
const logs = (id: string) => podman(['logs', containerName(id)]).catch(() => '');
const unitActive = (id: string) => as.run(['/usr/bin/systemctl', '--user', 'is-active', '--quiet', unitName(id)], { timeoutMs: 5000 }).then(() => true, () => false);
const inside = (id: string, script: string) => podman(['exec', '--user', '1500:1500', containerName(id), '/bin/sh', '-c', script]).then((s) => s.trim());
/** One request on the session's own token socket, from inside its container. */
const askToken = (id: string) =>
  inside(id, `node -e 'const s=require("net").createConnection(process.env.SP_TOKEN_SOCKET,()=>s.write(JSON.stringify({sessionKey:"C_OTHER:1.1"})+"\\n"));let b="";s.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).token)).on("error",e=>{console.log("error "+e.message)})'`);

async function cleanup(id: string | undefined) {
  if (KEEP) return say(`--keep: left ${id ? containerName(id) : 'nothing'} and its files`);
  if (id) {
    const run = sandboxRunFor(RUN, id);
    await podman(['rm', '--force', '--volumes', containerName(id)]).catch((e) => say(`cleanup: ${e.message}`));
    await podman(['volume', 'rm', '--force', volumeName(id)]).catch((e) => say(`cleanup: ${e.message}`));
    await podman(unshareRmArgs([runnersDir(run), path.dirname(secretsFor(run, id))])).catch(() => {});
    rmSync(run, { recursive: true, force: true });
    records().delete(id);
  }
  await as.run(['/bin/rm', '-rf', '--', path.join(DATA, 'people', PERSON)], { timeoutMs: 10_000 }).catch((e) => say(`cleanup: ${e.message}`));
}

const host = startHost();
let id: string | undefined;
try {
  check(!!(await until(() => events.find((e) => e.t === 'hello'))), 'host with SP_LAUNCH=podman dialed the gateway and said hello');

  // ---- a new thread
  const d1 = await deliver();
  check(!!d1.reply?.ok, `first delivery → reply ok in ${d1.ms} ms (${d1.reply?.error ?? ''})`);
  const record = await until(recordOf, 5000);
  id = record?.id;
  check(!!record && record.key === KEY && record.person === PERSON, `the thread has a record: ${JSON.stringify(record)}`);
  if (!id) throw new Error('no record: nothing more can be checked');
  const run = sandboxRunFor(RUN, id);
  check((await inspect(id, '{{.State.Status}}')) === 'running' && (await unitActive(id)), `container ${containerName(id)} runs and its unit ${unitName(id)} is active`);
  const pid = Number(await inspect(id, '{{.State.Pid}}'));
  const cgroup = pid ? readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim() : '';
  check(new RegExp(`/${unitName(id).replace(/\./g, '\\.')}/`).test(cgroup), `its first process (${pid}) is in that unit's cgroup: ${cgroup}`);
  check((await inspect(id, '{{.Config.Image}}')) === process.env.SP_IMAGE && (await inspect(id, '{{index .Config.Labels "sp.abi"}}')) === process.env.SP_IMAGE_ABI,
    'it was created from SP_IMAGE and carries SP_IMAGE_ABI');
  check(lstatSync(socketFor(run, id)).isSocket(), `the runner listens on ${socketFor(run, id)}`);
  check(!!(await until(async () => (/chat\.postMessage .*cwd/.test(await logs(id!)) ? true : undefined))), 'the runner answered !status into the fake Slack');
  const status = (await logs(id)).split('\n').find((l) => /chat\.postMessage .*cwd/.test(l)) ?? '';
  check(/\/workspace\b/.test(status) && !status.includes(DATA), 'its cwd is /workspace, and it names no host path');
  const fp = (await until(() => reports().find((r) => r.status === 'idle')))?.forkPath;
  check(!!fp && path.dirname(fp) === path.join(DATA, 'people', PERSON, 'sessions'), `the report the gateway got names the host's path: ${fp}`);
  const seen = (await inside(id, 'id -u; echo $SP_RUN')).split('\n').join(' ');
  check(seen === `1500 ${run}`, `inside: uid 1500, SP_RUN its own run directory (${seen})`);
  check(readlinkSync(path.join(run, 'token.sock')) === path.relative(run, tokenSocketFor(run, id)), `token.sock in its run directory links to ${path.relative(run, tokenSocketFor(run, id))}`);
  const tk = await askToken(id);
  check(tk.startsWith('ghs_fake') && tokenSessions.at(-1) === KEY, `a token asked for inside, naming another session, is asked of the gateway for this one (${tk}, ${JSON.stringify(tokenSessions)})`);
  const l1 = launched(d1.trace) ?? (await until(() => launched(d1.trace), 10_000));
  check(l1?.data?.launch_mode === 'podman' && typeof l1.data['container.create_ms'] === 'number' && typeof l1.data['container.start_ms'] === 'number' && l1.data['container.recreated'] === undefined,
    `runner.launched: ${JSON.stringify(l1?.data)} duration ${l1?.duration_ms} ms`);
  await inside(id, 'echo kept > /home/agent/sandbox-check-marker');

  // ---- warm
  const d2 = await deliver();
  check(!!d2.reply?.ok && Number(await inspect(id, '{{.State.Pid}}')) === pid, `second delivery → ok in ${d2.ms} ms, same container process`);

  // ---- idle exit
  const idleAt = Date.now();
  check(!!(await until(async () => ((await inspect(id!, '{{.State.Status}}')) === 'exited' ? true : undefined), IDLE_MS + 40_000)),
    `idle for ${IDLE_MS} ms: the runner left and the container is exited (${Date.now() - idleAt} ms after the delivery)`);
  check(!!(await until(async () => ((await unitActive(id!)) ? undefined : true), 10_000)), 'its unit is gone');
  check((await podman(['volume', 'exists', volumeName(id)]).then(() => true, () => false)) && !!recordOf(), 'its home volume and its record stay');
  check(!!(await until(() => reports().find((r) => r.status === 'stopped'))), 'the gateway was told the session stopped');

  // ---- resume
  const d3 = await deliver();
  check(!!d3.reply?.ok, `delivery after the idle exit → ok in ${d3.ms} ms (${d3.reply?.error ?? ''})`);
  check(recordOf()?.id === id && (await inspect(id, '{{.State.Status}}')) === 'running' && (await unitActive(id)), 'the same container runs again, under the same id');
  check((await inside(id, 'cat /home/agent/sandbox-check-marker')) === 'kept', 'a file written in its home before the exit is there');
  const l3 = launched(d3.trace) ?? (await until(() => launched(d3.trace), 10_000));
  check(l3?.data?.['container.recreated'] === false && l3.data['container.create_ms'] === undefined, `runner.launched of the resume: ${JSON.stringify(l3?.data)} duration ${l3?.duration_ms} ms`);
  check((await askToken(id)).startsWith('ghs_fake'), 'its token socket answers again');
} catch (e) {
  check(false, `the check itself failed: ${(e as Error)?.stack ?? e}`);
} finally {
  host.kill('SIGTERM');
  await sleep(1500);
  host.kill('SIGKILL');
  await cleanup(id ?? recordOf()?.id);
  wss.close();
  collector.close();
}
say(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
