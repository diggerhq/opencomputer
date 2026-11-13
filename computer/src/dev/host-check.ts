// End-to-end check of the host agent and runner without Slack: a fake gateway
// WebSocket server in-process, the host agent in laptop mode on temp dirs,
// runners rendering to a fake Slack client (SP_FAKE_SLACK=1, output in the
// runner's log). Checks spawn, socket, forwarding, token relay and cache, a
// host restart with rediscovery, idle exit, a restart after it, and `!restart`.
// Telemetry (work 054): host events reach a fake collector through the spool,
// across a collector outage and a host restart, with the path decided per
// delivery; a runner killed mid-turn (with and without a host restart in
// between) gives `turn.abandoned` with its trace. A fake model API that never
// answers keeps those turns running.
//   npx tsx src/dev/host-check.ts            (no model calls: `!status` deliveries)
//   npx tsx src/dev/host-check.ts --claude   (first delivery is one tiny real Claude turn)
//   npx tsx src/dev/host-check.ts --workspace  (workspace definition of one local bare repository: the first
//                                               start forks it while the runner launches, cold-start.ts)

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { GatewayToHost, HostToGateway, SessionSpec, TraceContext } from '../protocol.js';
import { type TelemetryEvent, uuidv7 } from '../telemetry/envelope.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLAUDE = process.argv.includes('--claude');
const WORKSPACE = process.argv.includes('--workspace');
const dir = mkdtempSync('/tmp/sph-'); // short: unix socket paths are limited to ~104 bytes on macOS
const DEFINITION = WORKSPACE ? path.join(dir, 'definition.json') : undefined;
if (DEFINITION) {
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=check', '-c', 'user.email=check@localhost', ...a], { cwd, stdio: 'ignore' });
  g(dir, 'init', '-q', '--bare', '-b', 'main', 'alpha.git');
  g(dir, 'clone', '-q', 'alpha.git', 'alpha-src');
  writeFileSync(path.join(dir, 'alpha-src', 'README.md'), 'alpha\n');
  g(path.join(dir, 'alpha-src'), 'add', '-A');
  g(path.join(dir, 'alpha-src'), 'commit', '-qm', 'init');
  g(path.join(dir, 'alpha-src'), 'push', '-q', 'origin', 'main');
  writeFileSync(DEFINITION, JSON.stringify({ name: 'check', repos: [{ name: 'alpha', remote: `file://${dir}/alpha.git` }] }));
}
const RUN = path.join(dir, 'run');
const KEY = `C_CHECK:${Date.now() / 1000}`;
const b64 = Buffer.from(KEY).toString('base64url');
const SOCK = path.join(RUN, 'runners', `${b64}.sock`);
const LOG = path.join(RUN, 'logs', `${b64}.log`);
const t0 = Date.now();
const say = (...a: unknown[]) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
let failed = 0;
const check = (ok: boolean, what: string) => {
  say(ok ? 'PASS' : 'FAIL', what);
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | undefined, ms = 30_000): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = f();
    if (v) return v;
  }
}

// ---- fake collector: 503 while `outage`, else 202; and a model API that never answers

const batches: { boot: string; seq: number; auth?: string; events: TelemetryEvent[] }[] = [];
let outage = true;
const collector = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c)).on('end', () => {
    if (outage) return void res.writeHead(503).end();
    const b = JSON.parse(body);
    batches.push({ boot: b.host_boot_id, seq: b.batch_seq, auth: req.headers.authorization, events: b.events });
    res.writeHead(202).end();
  });
});
await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
const COLLECTOR = `http://127.0.0.1:${(collector.address() as net.AddressInfo).port}`;
const tel = () => batches.flatMap((b) => b.events);
const telOf = (trace: TraceContext, name: string) => tel().filter((e) => e.trace_id === trace.id && e.event_name === name);
function mkTrace(): TraceContext {
  const now = Date.now();
  return { id: uuidv7(now), sentAt: now - 40, receivedAt: now - 20, dispatchedAt: now, surface: 'slack', surfaceWorkspaceId: 'T_CHECK',
    conversationId: 'C_CHECK', personId: 'U_OWNER' };
}

// ---- fake gateway

const events: HostToGateway[] = [];
let conn: WebSocket | undefined;
let tokenRequests = 0;
const tokenSessions: (string | undefined)[] = [];
const wss = new WebSocketServer({
  port: 0,
  path: '/host',
  verifyClient: ({ req }: any) => req.headers.authorization === 'Bearer check-token',
});
await new Promise((r) => wss.on('listening', r));
const port = (wss.address() as net.AddressInfo).port;
const toHost = (m: GatewayToHost) => conn?.send(JSON.stringify(m));
wss.on('connection', (c) => {
  conn = c;
  c.on('message', (d) => {
    const m = JSON.parse(String(d)) as HostToGateway;
    events.push(m);
    say('gateway <', m.t === 'session' ? `session ${m.report.status} sdk=${m.report.sdkSessionId ?? '-'}` : m.t === 'hello' ? `hello sessions=${JSON.stringify(m.sessions.map((s) => s.status))}` : m.t);
    if (m.t === 'hello')
      toHost({ t: 'welcome', protocol: 1, credentials: {
        slackBotToken: '', slackBotUserId: '',
      }, people: [owner] });
    if (m.t === 'token') {
      tokenRequests++;
      tokenSessions.push(m.sessionKey);
      toHost({ t: 'token', id: m.id, result: { token: `ghs_fake${tokenRequests}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
    }
  });
});
async function request(m: GatewayToHost & { id: string }) {
  toHost(m);
  return until(() => events.find((e): e is Extract<HostToGateway, { t: 'reply' }> => e.t === 'reply' && e.id === m.id), 120_000);
}
const reports = () => events.flatMap((e) => (e.t === 'session' && e.report.key === KEY ? [e.report] : []));
const hellos = () => events.filter((e) => e.t === 'hello') as Extract<HostToGateway, { t: 'hello' }>[];

// ---- host agent

const owner = { slackUserId: 'U_OWNER', dir: 'tester', gitName: 'Test Owner', gitEmail: 'owner@example.com' };
const spec: SessionSpec = { key: KEY, kind: 'thread', channel: 'C_CHECK', threadTs: KEY.split(':')[1], owner, title: 'host check', mode: 'bypassPermissions' };
const scopedCredentials = {
  slackBotToken: 'xoxb-fake',
  slackBotUserId: 'U_BOT',
};
function startHost(idleMs: number): ChildProcess {
  const { SP_DEFINITION, WORKDIR, SLACK_BOT_TOKEN, ...rest } = process.env;
  const h = spawn(process.execPath, ['--import', 'tsx', 'src/host/main.ts'], {
    cwd: ROOT,
    env: { ...rest, SP_GATEWAY_URL: `ws://127.0.0.1:${port}/host`, SP_HOST_TOKEN: 'check-token', SP_HOST_ID: 'check',
      SP_RUN: RUN, SP_DATA: path.join(dir, 'data'), SP_IDLE_MS: String(idleMs), SP_LAUNCH: 'detached', SP_FAKE_SLACK: '1',
      SP_TELEMETRY_URL: COLLECTOR, SP_TELEMETRY_CREDENTIAL: 'check-credential', SP_REGION: 'local', SP_SUBSTRATE: 'laptop',
      ...(DEFINITION && { SP_DEFINITION: DEFINITION }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const s of [h.stdout!, h.stderr!]) s.on('data', (d) => process.stdout.write(String(d).replace(/^(?=.)/gm,'    host| ')));
  return h;
}
const runnerPid = () => (existsSync(SOCK.replace(/\.sock$/, '.pid')) ? Number(readFileSync(SOCK.replace(/\.sock$/, '.pid'), 'utf8')) : 0);
const alive = (pid: number) => {
  try {
    return pid > 0 && process.kill(pid, 0);
  } catch {
    return false;
  }
};
const runnerLog = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '');
function askToken(sessionKey: string, socket = path.join(RUN, 'token.sock')) {
  return new Promise<any>((resolve, reject) => {
    const s = net.createConnection(socket, () => s.write(JSON.stringify({ sessionKey }) + '\n'));
    let buf = '';
    s.on('data', (d) => (buf += d)).on('end', () => resolve(JSON.parse(buf))).on('error', reject);
  });
}

let host = startHost(600_000);
let pid = 0;
try {
  check(!!(await until(() => hellos()[0])), 'host dialed the gateway with its bearer token and said hello');

  // The welcome starts housekeeping, which clones the workspace; the first fork then has a repository to fork.
  if (WORKSPACE) check(!!(await until(() => existsSync(path.join(dir, 'data', 'people', 'tester', 'ws', 'alpha', '.git')))), 'workspace cloned by housekeeping');
  const text = CLAUDE ? 'Reply with exactly the word: hi' : '!status';
  const tr1 = mkTrace();
  const r1 = await request({ t: 'deliver', id: randomUUID(), session: spec, msg: { userId: 'U_OWNER', text, ts: '2.1' }, credentials: scopedCredentials, trace: tr1 });
  check(!!r1?.ok, `deliver "${text}" → reply ok (${r1?.error ?? ''})`);
  pid = runnerPid();
  check(alive(pid) && existsSync(SOCK), `runner process ${pid} spawned, listening on its socket`);
  if (CLAUDE) {
    await until(() => reports().some((r) => r.status === 'busy') && reports().at(-1)?.status === 'idle' ? true : undefined, 120_000);
    check(/chat\.(startStream|postMessage)/.test(runnerLog()) && !!reports().at(-1)?.sdkSessionId, 'Claude turn rendered to fake Slack, sdkSessionId reported');
    check(/reactions\.remove/.test(runnerLog()), "gateway's 👀 cleared when output started");
  } else {
    check(!!(await until(() => /chat\.postMessage .*cwd/.test(runnerLog()))), 'runner answered !status into fake Slack');
  }
  check(reports().at(-1)?.status === 'idle' && reports().at(-1)?.forkPath !== undefined, 'runner reported idle with forkPath');
  if (WORKSPACE) {
    const fp = reports().at(-1)?.forkPath ?? '';
    check(existsSync(path.join(fp, '.fork.json')) && existsSync(path.join(fp, 'alpha', '.git')), `runner runs in the complete fork ${fp}`);
  }

  const a = await request({ t: 'action', id: randomUUID(), sessionKey: KEY, promptId: 'nope', value: 'allow', userId: 'U_OWNER' });
  check(a?.ok === false && /no such prompt/.test(a.error ?? ''), 'action for an unknown prompt reaches the runner and fails cleanly');
  check(!!(await request({ t: 'stop', id: randomUUID(), sessionKey: KEY }))?.ok, 'stop → ok');

  const tr2 = mkTrace();
  check(!!(await request({ t: 'deliver', id: randomUUID(), session: spec, msg: { userId: 'U_OWNER', text: '!status', ts: '2.15' }, trace: tr2 }))?.ok,
    'second delivery → ok');

  const tk1 = await askToken(KEY);
  const tk2 = await askToken(KEY);
  check(tk1.token === 'ghs_fake1' && tk2.token === 'ghs_fake1' && tokenRequests === 1, `token.sock relays to the gateway and caches (${tk1.token}, ${tk2.token}, ${tokenRequests} request)`);
  // Work 080: the shared socket names no session, whatever the asker says; a runner's own names the one it serves.
  for (const f of readdirSync(path.join(RUN, 'tokens'))) await askToken('C_OTHER:1.1', path.join(RUN, 'tokens', f));
  check(tokenSessions[0] === undefined && tokenSessions.includes(KEY) && !tokenSessions.includes('C_OTHER:1.1'),
    `the host names the session from the runner's own token socket (${JSON.stringify(tokenSessions)})`);

  // Host crash and restart during a collector outage: what the first host spooled is sent by the second.
  await sleep(2500); // the emitter's 2 s flush into the spool
  check(batches.length === 0, 'collector down: nothing delivered yet');
  host.kill('SIGKILL');
  await sleep(1000);
  check(alive(pid), 'runner survives the host being killed');
  outage = false;
  host = startHost(4000);
  const h2 = await until(() => hellos()[1]);
  check(!!h2?.sessions.some((s) => s.key === KEY && s.status === 'idle'), 'restarted host rediscovered the runner and reported it in hello');
  const r2 = await request({ t: 'deliver', id: randomUUID(), session: spec, msg: { userId: 'U_OWNER', text: '!status', ts: '2.2' }, credentials: scopedCredentials });
  check(!!r2?.ok && runnerPid() === pid, 'delivery after restart goes to the same runner');

  check(!!(await until(() => telOf(tr2, 'deliver.forwarded')[0])), "the first host's spooled events arrive after the outage, sent by the second host");
  const fwd = (t: TraceContext) => telOf(t, 'deliver.forwarded')[0];
  const seq1 = ['deliver.received', 'fork.done', 'runner.launched', 'runner.ready', 'deliver.forwarded'];
  check(seq1.every((n) => telOf(tr1, n).length === 1) && fwd(tr1)?.path === 'new',
    `new thread: ${seq1.join(' → ')} on the trace, path new (${tel().filter((e) => e.trace_id === tr1.id).map((e) => e.event_name).join(', ')})`);
  check(fwd(tr2)?.path === 'warm' && telOf(tr2, 'runner.launched').length === 0, 'live runner: path warm, no launch');
  if (WORKSPACE) {
    const [fd, rl, rr, fw] = ['fork.done', 'runner.launched', 'runner.ready', 'deliver.forwarded'].map((n) => telOf(tr1, n)[0]);
    const start = (e: TelemetryEvent) => Date.parse(e.occurred_at) - (e.duration_ms ?? 0);
    const end = (e: TelemetryEvent) => Date.parse(e.occurred_at);
    say(`cold start: fork ${fd?.duration_ms} ms, launch ${rl?.duration_ms} ms, ready ${rr?.duration_ms} ms (${rr?.data.polls} polls)`);
    check(!!(fd && rl && fw) && start(rl) < end(fd) && end(fd) <= end(fw) && telOf(tr1, 'fork.repo')[0]?.data.repo === 'alpha',
      'runner launched before the fork finished; delivered after it');
  }
  check(tel().some((e) => e.event_name === 'host.sample' && e.host_id === 'check' && e.region === 'local' && e.substrate === 'laptop'), 'host.sample with host id, region, substrate');
  check(tel().some((e) => e.event_name === 'token.minted' && e.data.cache_hit === true), 'token.minted with cache hits');
  check(batches.every((b) => b.auth === 'Bearer check-credential'), 'batches carry the credential');

  check(!!(await until(() => (!alive(pid) ? true : undefined), 20_000)), 'runner exited after the idle timeout');
  check(reports().at(-1)?.status === 'stopped' && !existsSync(SOCK), 'runner reported stopped and removed its socket');

  check(!!(await until(() => tel().find((e) => e.event_name === 'runner.exited' && e.data.exit_reason === 'idle' && e.data.busy === false))),
    'runner.exited: idle, not busy');
  const tr3 = mkTrace();
  // A resumable session (`!status` never starts the harness, so the id needn't exist).
  const sdkSessionId = reports().findLast((r) => r.sdkSessionId)?.sdkSessionId ?? 'check-session';
  const r3 = await request({ t: 'deliver', id: randomUUID(), session: { ...spec, sdkSessionId }, msg: { userId: 'U_OWNER', text: '!status', ts: '2.3' }, credentials: scopedCredentials, trace: tr3 });
  const pid3 = runnerPid();
  check(!!r3?.ok && alive(pid3) && pid3 !== pid, `delivery after idle exit starts a fresh runner (${pid3})`);
  check((await until(() => fwd(tr3)))?.path === 'resume', 'a new runner on an existing session: path resume');
  pid = pid3;

  // !restart: the runner exits; a message right behind it starts a fresh runner.
  const r4 = await request({ t: 'deliver', id: randomUUID(), session: spec, msg: { userId: 'U_OWNER', text: '!restart', ts: '2.4' } });
  const r5 = await request({ t: 'deliver', id: randomUUID(), session: spec, msg: { userId: 'U_OWNER', text: '!status', ts: '2.5' } });
  const pid5 = runnerPid();
  check(!!r4?.ok && !!r5?.ok && !alive(pid) && alive(pid5) && pid5 !== pid, `!restart exits the runner; the next message starts a fresh one (${pid5}) (${r5?.error ?? ''})`);
  pid = pid5;

  // Mid-turn: a model that never answers keeps the runner busy.
  // The model proxy's profile, not the credentials, now says where a turn goes: a model that never answers needs one (work 097).
  const hanging = scopedCredentials;
  const busy = () => reports().at(-1)?.status === 'busy' || undefined;
  const tr6 = mkTrace();
  check(!!(await request({ t: 'deliver', id: randomUUID(), session: spec, msg: { userId: 'U_OWNER', text: 'hello', ts: '2.6' }, credentials: hanging, trace: tr6 }))?.ok
    && !!(await until(busy)), 'a turn is running (model never answers)');
  process.kill(pid, 'SIGKILL');
  const ab6 = await until(() => telOf(tr6, 'turn.abandoned')[0]);
  check(ab6?.outcome === 'abandoned' && ab6.data.exit_reason === 'unknown' && typeof ab6.duration_ms === 'number',
    'runner killed mid-turn → turn.abandoned with its trace');

  const tr7 = mkTrace();
  check(!!(await request({ t: 'deliver', id: randomUUID(), session: spec, msg: { userId: 'U_OWNER', text: 'hello again', ts: '2.7' }, credentials: hanging, trace: tr7 }))?.ok
    && !!(await until(busy)), 'another turn is running');
  pid = runnerPid();
  await sleep(2500);
  host.kill('SIGKILL');
  await sleep(500);
  host = startHost(600_000);
  check(!!(await until(() => hellos()[2]))?.sessions.some((s) => s.key === KEY && s.status === 'busy'), 'restarted host found the busy runner');
  process.kill(pid, 'SIGKILL');
  check(!!(await until(() => telOf(tr7, 'turn.abandoned')[0])), 'host restarted mid-turn, then the runner killed → turn.abandoned still names the trace');

  if (WORKSPACE) {
    // The host dies mid-fork: the next host must not adopt (and give credentials to) the runner in the partial fork.
    const r8 = await request({ t: 'deliver', id: randomUUID(), session: spec, msg: { userId: 'U_OWNER', text: '!status', ts: '2.8' }, credentials: scopedCredentials });
    pid = runnerPid();
    const fp = reports().at(-1)?.forkPath ?? '';
    host.kill('SIGKILL');
    await sleep(500);
    rmSync(path.join(fp, '.fork.json')); // as if the host died before forkSession's last step
    host = startHost(600_000);
    await until(() => hellos()[3]);
    check(!!r8?.ok && !!(await until(() => (!alive(pid) ? true : undefined), 10_000)) && !hellos()[3].sessions.some((s) => s.key === KEY),
      'restarted host stops a runner in an incomplete fork instead of adopting it');
    const r9 = await request({ t: 'deliver', id: randomUUID(), session: { ...spec, forkPath: fp }, msg: { userId: 'U_OWNER', text: '!status', ts: '2.9' },
      credentials: scopedCredentials });
    check(!!r9?.ok && alive(runnerPid()) && runnerPid() !== pid && existsSync(path.join(fp, '.fork.json')),
      'the next delivery cold-starts a runner and finishes the fork');
    pid = runnerPid();
  }

  const bySeq = new Map<string, number[]>();
  for (const b of batches) bySeq.set(b.boot, [...(bySeq.get(b.boot) ?? []), b.seq]);
  check(bySeq.size >= 2 && [...bySeq.values()].every((q) => q.sort((a, b) => a - b).every((n, i) => n === i + 1)),
    `batches numbered without gaps per host boot (${[...bySeq.values()].map((q) => q.length).join(', ')} batches)`);
  const ids = tel().map((e) => e.event_id);
  check(new Set(ids).size === ids.length, `no event sent twice (${ids.length} events)`);
} finally {
  host.kill('SIGTERM');
  if (alive(pid)) process.kill(pid, 'SIGTERM');
  await sleep(500);
  say('runner log (last lines):\n' + runnerLog().split('\n').slice(-12).map((l) => '    runner| ' + l).join('\n'));
  rmSync(dir, { recursive: true, force: true });
  rmSync(path.join(ROOT, 'workspaces', KEY.replace(/[^a-zA-Z0-9]+/g, '-')), { recursive: true, force: true });
  wss.close();
  collector.close();
  say(failed ? `${failed} check(s) failed` : 'all checks passed');
  process.exit(failed ? 1 : 0);
}
