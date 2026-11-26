// ONE-TIME systemd->podman migration (work 103). Delete together with the systemd launch path in step 11.
//
// End-to-end check of the flip, on a computer: a host agent with
// SP_LAUNCH=systemd serves two threads of a workspace with one repository
// (turns answered by src/dev/fake-model.mjs behind the release's
// oc-modelproxy, sandbox-check-model.ts); one goes idle and its runner exits
// (a cold thread), the other is live with an uncommitted file in its
// worktree. SIGUSR2 drains the host (legacy-migration/drain.ts): a delivery
// sent then gets no reply from it, its runner exits and so does the host.
// The host runs as its unit runs it, under tsx's CLI, and gets the signal the
// way provision.sh sends it, at the process deploy/vm/legacy-drain.sh finds
// (tsx forwards no SIGUSR2: the wrapper itself would die of it). A
// host with SP_LAUNCH=podman comes up, the fake gateway sends the held
// delivery again (as the gateway does when a host's socket closes), then
// delivers to the cold thread with the session id and fork path of its last
// report. Each thread is migrated (legacy-migration/migrate.ts): a record
// with its repository, its worktree working inside its container, its
// uncommitted file, its transcript in its home, and the stand-in model sent
// the earlier turns' text with the new turn: the session was resumed.
//
// It needs what deploy/vm/provision.sh sets up and github.com, so it runs on
// a computer, as the host's user, from a release, with no host agent running:
//   cd /opt/slack-presence/current && set -a && . ./.sp-version.env && set +a && \
//     sudo -u sp-host env SP_RUNNER_USER=agent SP_IMAGE="$SP_IMAGE" SP_IMAGE_ABI="$SP_IMAGE_ABI" \
//       node --import tsx src/dev/sandbox-check-legacy.ts [--keep]
//
// Invariants:
// - It refuses to run beside a host agent (sandbox-check.ts does the same).
// - It removes what it made, pass or fail, unless `--keep`: containers, home
//   volumes, records, run directories, the person directory
//   `sandbox-check-legacy`, the threads' transcripts and Codex homes in the
//   runners' user's home, and the definition it saved.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type net from 'node:net';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { codexHome } from '../codex-home.js';
import { runnerUser } from '../host/runner-user.js';
import { mounts } from '../host/sandbox/mounts.js';
import { asRunner, type PodmanError } from '../host/sandbox/podman.js';
import { containerName, unshareRmArgs, volumeName } from '../host/sandbox/podman-args.js';
import { sandboxRecords } from '../host/sandbox/records.js';
import { sandboxRunFor } from '../ipc.js';
import type { GatewayToHost, HostToGateway, Person, SessionReport, SessionSpec } from '../protocol.js';
import { gatewayDefinitionPath } from '../workspaces/definition.js';
import { checkModel } from './sandbox-check-model.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const KEEP = process.argv.includes('--keep');
const RUN = process.env.SP_RUN ?? '/run/slack-presence';
const DATA = process.env.SP_DATA ?? '/data';
const IDLE_MS = 20_000;
const NOW = Date.now() / 1000;

const t0 = Date.now();
const say = (...a: unknown[]) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
let failed = 0;
const check = (ok: boolean, what: string) => {
  say(ok ? 'PASS' : 'FAIL', what);
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | undefined | Promise<T | undefined>, ms = 30_000, every = 200): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) {
    const v = await f();
    if (v) return v;
  }
}
const refuse = (why: string): never => {
  console.error(`sandbox-check-legacy: ${why}`);
  process.exit(2);
};

const user = runnerUser(process.env) ?? refuse("set SP_RUNNER_USER (the runners' user, `agent` on a computer)");
if (!process.env.SP_IMAGE || !process.env.SP_IMAGE_ABI) refuse("set SP_IMAGE and SP_IMAGE_ABI (the release's .sp-version.env has them)");
if (!existsSync(path.join(ROOT, 'dist/runner-boot.mjs'))) refuse(`${ROOT} has no dist/runner-boot.mjs: run it from a release`);
try {
  execFileSync('/usr/bin/systemctl', ['is-active', '--quiet', 'slack-presence-host.service']);
  refuse('slack-presence-host is running here; this check would be a second host on its directories');
} catch {
  // not active: the directories are ours for the run
}
const model = await checkModel({ root: ROOT, run: RUN }).catch((e) => refuse(`no model proxy: ${e.message}`));
const as = asRunner(user.sudo);
const podman = (args: string[], timeoutMs = 30_000) => as.podman(args, { timeoutMs });
const mnt = mounts({ as, root: ROOT, dataDir: DATA });
const records = () => sandboxRecords(path.join(DATA, 'state', 'sandboxes'));
const savedDefinition = existsSync(gatewayDefinitionPath()) ? readFileSync(gatewayDefinitionPath(), 'utf8') : undefined;

// ---- fake gateway: it sends a delivery with no reply again to the next host, as the gateway does

const PAT: Person = { slackUserId: 'U_OWNER', userId: 'usr_sandbox_check_legacy', dir: 'sandbox-check-legacy', gitName: 'Sandbox Check', gitEmail: 'check@example.com' };
const credentials = { slackBotToken: '', slackBotUserId: '' };
const definition = { name: 'sandbox-check-legacy', about: 'legacy', repos: [{ name: 'hello', remote: 'https://github.com/octocat/Hello-World' }] };
const events: HostToGateway[] = [];
const pending = new Map<string, GatewayToHost>();
let conn: WebSocket | undefined;
const wss = new WebSocketServer({ port: 0, path: '/host', verifyClient: ({ req }: { req: { headers: Record<string, unknown> } }) => req.headers.authorization === 'Bearer check-token' });
await new Promise((r) => wss.on('listening', r));
const toHost = (m: GatewayToHost) => conn?.send(JSON.stringify(m));
wss.on('connection', (c) => {
  conn = c;
  c.on('message', (d) => {
    const m = JSON.parse(String(d)) as HostToGateway;
    events.push(m);
    if (m.t === 'hello') {
      toHost({ t: 'welcome', protocol: 4, credentials, models: { claude: model.route }, people: [PAT], definition });
      for (const p of pending.values()) toHost(p);
    }
    if (m.t === 'reply') pending.delete(m.id);
    if (m.t === 'token') toHost({ t: 'token', id: m.id, result: { token: 'ghs_fake', expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
  });
});

function thread(n: number) {
  const key = `C_LEGACY:${(NOW + n).toFixed(3)}`;
  const spec: SessionSpec = { key, kind: 'thread', channel: 'C_LEGACY', threadTs: key.split(':')[1], owner: PAT, title: `legacy check ${n}`, mode: 'bypassPermissions' };
  const t = {
    key, spec,
    fork: mnt.workspace({ person: PAT.dir, key }),
    record: () => records().find(PAT.dir, key),
    reports: () => events.flatMap((e) => (e.t === 'session' && e.report.key === key ? [e.report] : [])),
    report: () => t.reports().pop(),
    /** The last report with a session id: what the gateway keeps of the thread. */
    known: (): SessionReport | undefined => t.reports().filter((r) => r.sdkSessionId).pop(),
    /** Deliver `text` with the spec the gateway sends: for a thread it knows, its last report's session id and fork path. */
    send(text: string) {
      const id = randomUUID();
      const known = t.known();
      const session = known ? { ...spec, sdkSessionId: known.sdkSessionId, forkPath: known.forkPath } : spec;
      const m: GatewayToHost = { t: 'deliver', id, session, msg: { userId: 'U_OWNER', text, ts: `3.${Date.now()}` }, credentials };
      pending.set(id, m);
      toHost(m);
      return id;
    },
    reply: (id: string, ms = 120_000) => until(() => events.find((e): e is Extract<HostToGateway, { t: 'reply' }> => e.t === 'reply' && e.id === id), ms),
    inside: (script: string) =>
      podman(['exec', '--user', '1500:1500', containerName(t.record()?.id ?? ''), '/bin/sh', '-c', script], 60_000).then((s) => s.trim(), (e: PodmanError) => `error: ${(e.stderr || e.message).trim()}`),
  };
  return t;
}
type Thread = ReturnType<typeof thread>;
const LIVE = thread(1);
const COLD = thread(2);

// ---- the hosts, and the cleanup

let host: ChildProcess | undefined;
function startHost(launch: 'systemd' | 'podman'): ChildProcess {
  const { SP_DEFINITION, WORKDIR, SLACK_BOT_TOKEN, ...rest } = process.env;
  // As provision.sh's unit runs it (ExecStart): through tsx's CLI, which starts main.ts as its child.
  const h = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), ['src/host/main.ts'], {
    cwd: ROOT,
    env: { ...rest, SP_GATEWAY_URL: `ws://127.0.0.1:${(wss.address() as net.AddressInfo).port}/host`, SP_HOST_TOKEN: 'check-token', SP_HOST_ID: 'sandbox-check-legacy',
      SP_RUN: RUN, SP_DATA: DATA, SP_IDLE_MS: String(IDLE_MS), SP_LAUNCH: launch, SP_POOL_SIZE: '0', SP_FAKE_SLACK: '1', SP_MODEL_PROXY: model.control, SP_MODEL_SOCKET: model.api },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const s of [h.stdout!, h.stderr!]) s.on('data', (d) => process.stdout.write(String(d).replace(/^(?=.)/gm, `  ${launch}| `)));
  return h;
}
const exited = (h: ChildProcess, ms: number) => until(() => h.exitCode !== null || h.signalCode !== null, ms, 250);

async function cleanup() {
  if (host && host.exitCode === null) {
    host.kill('SIGTERM');
    await exited(host, 20_000);
  }
  model.stop();
  if (KEEP) return say('--keep: left the containers and their files');
  const quiet = (p: Promise<unknown>) => p.catch((e) => say(`cleanup: ${e.message}`));
  for (const t of [LIVE, COLD]) {
    const id = t.record()?.id;
    if (id) {
      await quiet(podman(['rm', '--force', '--volumes', containerName(id)]));
      await quiet(podman(['volume', 'rm', '--force', volumeName(id)]));
      await podman(unshareRmArgs([sandboxRunFor(RUN, id)])).catch(() => {});
      rmSync(sandboxRunFor(RUN, id), { recursive: true, force: true });
      records().delete(id);
    }
    // The `systemd` runners' leftovers in their user's home: the transcript (named for the fork) and the Codex home.
    const slug = t.fork.replace(/[^a-zA-Z0-9]/g, '-');
    await quiet(as.run(['/bin/rm', '-rf', '--', path.join(user.env.HOME, '.claude', 'projects', slug), codexHome(path.join(user.env.HOME, '.calvin', 'codex'), t.key)], { timeoutMs: 30_000 }));
  }
  await quiet(podman(unshareRmArgs([path.join(DATA, 'people', PAT.dir)]), 60_000));
  if (savedDefinition === undefined) rmSync(gatewayDefinitionPath(), { force: true });
  else writeFileSync(gatewayDefinitionPath(), savedDefinition);
}

// ---- the check

async function onSystemd() {
  host = startHost('systemd');
  const [l, c] = [LIVE.send('remember marker-live-1'), COLD.send('remember marker-cold-1')];
  const [rl, rc] = await Promise.all([LIVE.reply(l), COLD.reply(c)]);
  check(!!rl?.ok && !!rc?.ok, `systemd: both threads answered (${rl?.error ?? ''}${rc?.error ?? ''})`);
  const reported = await until(() => (LIVE.known() && COLD.known() ? [LIVE.known()!, COLD.known()!] : undefined));
  check(!!reported && reported.every((r) => r.forkPath && !r.forkPath.startsWith('/workspace')), `systemd: each thread reports a session id and its fork on the host: ${JSON.stringify(reported?.map((r) => r.forkPath))}`);
  check(!records().find(PAT.dir, LIVE.key) && existsSync(path.join(LIVE.fork, 'hello', '.git')), `systemd: no record, the fork and its worktree in ${LIVE.fork}`);
  await as.run(['/bin/sh', '-c', `echo uncommitted-live > ${path.join(LIVE.fork, 'hello', 'wip.txt')}`], { timeoutMs: 10_000 });
  // The cold thread: its runner exits for idleness; the gateway keeps its last report.
  const cold = await until(() => COLD.report()?.status === 'stopped', IDLE_MS + 30_000, 500);
  check(!!cold, `systemd: ${COLD.key}'s runner left for idleness`);
  // Keep the live one live, then drain.
  const again = await LIVE.reply(LIVE.send('remember marker-live-2'));
  check(!!again?.ok, 'systemd: a second turn on the live thread');
}

async function drain() {
  const h = host!;
  // As provision.sh signals it (deploy/vm/legacy-drain.sh): the process running main.ts, not the wrapper.
  const pid = Number(execFileSync('bash', [path.join(ROOT, 'deploy/vm/legacy-drain.sh'), 'host-pid', String(h.pid)], { encoding: 'utf8' }).trim());
  check(pid !== h.pid, `drain: the host runs under tsx's CLI as the unit runs it (pid ${pid} under ${h.pid})`);
  process.kill(pid, 'SIGUSR2');
  await sleep(500);
  const held = LIVE.send('during the drain marker-live-3');
  const out = await exited(h, 120_000);
  check(!!out && h.exitCode === 0, `drain: the systemd host exited on its own (code ${h.exitCode} ${h.signalCode ?? ''})`);
  check(pending.has(held), 'drain: the delivery sent during the drain got no reply from the systemd host');
  return held;
}

async function onPodman(held: string, before: { live?: SessionReport; cold?: SessionReport }) {
  host = startHost('podman');
  const r1 = await LIVE.reply(held, 240_000);
  check(!!r1?.ok, `podman: the held delivery, sent again, is answered on ${LIVE.key} (${r1?.error ?? ''})`);
  const r2 = await COLD.reply(COLD.send('back after the flip marker-cold-2'), 240_000);
  check(!!r2?.ok, `podman: the cold thread, delivered to with its last report's session id and fork, is answered (${r2?.error ?? ''})`);
  const turns = await model.turns();
  const last = (marker: string) => [...turns].reverse().find((t) => t.includes(marker)) ?? '';
  check(last('marker-live-3').includes('marker-live-1') && last('marker-live-3').includes('marker-live-2'), 'podman: the live thread\'s turn carried its earlier turns: resumed');
  check(last('marker-cold-2').includes('marker-cold-1'), "podman: the cold thread's turn carried its earlier turn: resumed");
  for (const [t, was] of [[LIVE, before.live], [COLD, before.cold]] as [Thread, SessionReport | undefined][]) {
    const rec = t.record();
    check(!!rec?.repos?.hello, `podman: ${t.key} has a record with its repository: ${JSON.stringify(rec?.repos)}`);
    const now = await until(() => t.reports().filter((r) => r.forkPath === '/workspace' && r.sdkSessionId).pop());
    check(!!was?.sdkSessionId && now?.sdkSessionId === was.sdkSessionId, `podman: ${t.key} kept its session id ${was?.sdkSessionId}`);
    const seen = await t.inside(`cat /workspace/hello/.git; git -C /workspace/hello status --porcelain; test -f "$HOME/.claude/projects/-workspace/${was?.sdkSessionId}.jsonl" && echo transcript`);
    const wip = t === LIVE ? '?? wip.txt\n' : '';
    check(seen === `gitdir: /clones/hello/.git/worktrees/hello\n${wip}transcript`, `podman: ${t.key}'s worktree works inside, its transcript is in its home: ${JSON.stringify(seen)}`);
  }
  check(!existsSync(path.join(DATA, 'people', PAT.dir, 'sessions.pre-sandbox')), 'podman: no fork was set aside');
}

try {
  await onSystemd();
  const before = { live: LIVE.known(), cold: COLD.known() };
  const held = await drain();
  await onPodman(held, before);
} catch (e) {
  check(false, `threw: ${(e as Error)?.stack ?? e}`);
} finally {
  await cleanup();
  wss.close();
}
say(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
