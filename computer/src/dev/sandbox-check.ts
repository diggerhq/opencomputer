// End-to-end check of sessions in containers (work 103), on a computer: the
// host agent with SP_LAUNCH=podman against a fake gateway in this process,
// runners rendering to a fake Slack client (SP_FAKE_SLACK=1, read back with
// `podman logs`). No model call: a delivery is `!status`, or a turn whose
// model is src/dev/fake-model.mjs inside the session's container.
//
// It checks a new thread (record, container, unit, cgroup, run directory,
// token socket, the report's path), a warm delivery, what reaches into a
// running container, a stopped one and a resumed one (step 9: previews,
// terminal, files, in sandbox-check-reach.ts), the idle exit (container
// exited, home and record kept) and the resume under the same id with the home
// intact; and it prints what each start took.
//
// Workspaces (step 7), with a definition of two public repositories the fake
// gateway sends: the clones a helper container makes, the workspace and the
// worktrees mounted in a thread, its own worktree registry, a commit made
// inside, a second thread of the same person and a thread of another person
// (what each can see), `git worktree prune` in one thread and its sibling,
// ws-add.sh a second time, the mount helper's refusals, a journal directory
// for a session of the API, `checkout`, the definition rewritten for a running
// container, and an idle thread's build directories removed by housekeeping.
// `checkout` is called in this process on the host's own parts, since only a
// model turn makes a runner ask for it.
//
// It needs what deploy/vm/provision.sh sets up (the runners' user and its
// Podman, the session image, the run and state directories) and github.com,
// so it runs on a computer, as the host's user, from a release, and not in CI:
//   cd /opt/slack-presence/current && set -a && . ./.sp-version.env && set +a && \
//     sudo -u sp-host env SP_RUNNER_USER=agent SP_IMAGE="$SP_IMAGE" SP_IMAGE_ABI="$SP_IMAGE_ABI" \
//       node --import tsx src/dev/sandbox-check.ts [--keep]
//
// With `--spares` it runs the checks and timings of step 10 instead (spare
// containers: sandbox-check-spares.ts), on hosts it starts and stops itself.
//
// Invariants:
// - It refuses to run beside a host agent: it is a host itself, on the
//   computer's SP_RUN and SP_DATA (or the ones in its environment, set up the
//   same way) and on the preview proxy's port.
// - The gateway it plays speaks protocol 4, so the host serves its wire
//   socket, and the check is the relay on it. Two threads of one person are
//   Slack threads, whose `cs_` ids the host learns from an `api` frame each
//   (their runners write no journal); the other person's thread is a session
//   of the API: its deliveries carry its `sessionId`, and its runner writes
//   its journal.
// - It removes what it made (containers, home volumes, records, run
//   directories, the previews table, the person directories `sandbox-check`
//   and `sandbox-check-b`, the journal directories, the upload records, the
//   definition it saved, every container whose run directory is below its
//   SP_RUN: the spares), pass or fail, unless `--keep`.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import type net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { runnerUser } from '../host/runner-user.js';
import { mounts } from '../host/sandbox/mounts.js';
import { asRunner, type PodmanError } from '../host/sandbox/podman.js';
import { containerName, execArgs, mountArgs, pidArgs, unitName, unshareRmArgs, volumeName } from '../host/sandbox/podman-args.js';
import { sandboxRecords } from '../host/sandbox/records.js';
import { sandboxScripts } from '../host/sandbox/scripts.js';
import { sandboxWorkspaces } from '../host/sandbox/workspace.js';
import { runnersDir, sandboxRunFor, secretsFor, socketFor, tokenSocketFor } from '../ipc.js';
import type { GatewayToHost, HostToGateway, Person, PreviewConfig, PreviewRequest, SessionSpec, TraceContext, WorkspaceDefinition } from '../protocol.js';
import { mintId } from '../session-ids.js';
import { createTelemetry } from '../telemetry/emitter.js';
import { type TelemetryEvent, uuidv7 } from '../telemetry/envelope.js';
import { safeKey, useScripts } from '../workspaces/clones.js';
import { gatewayDefinitionPath } from '../workspaces/definition.js';
import { APP_PORT, type Kit, MODEL_URL, type Thread as Reached, reachResumed, reachRunning, reachStopped } from './sandbox-check-reach.js';
import { spareChecks } from './sandbox-check-spares.js';
import { type WireClient, wireClient } from './wire-client.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const KEEP = process.argv.includes('--keep');
const SPARES = process.argv.includes('--spares');
const RUN = process.env.SP_RUN ?? '/run/slack-presence';
const DATA = process.env.SP_DATA ?? '/data';
const IDLE_MS = 20_000;
/** Hours a stopped thread's build directories stay: 9 s here, less than a thread's idle time. */
const ARTIFACTS_IDLE_HOURS = 0.0025;
const NOW = Date.now() / 1000;
const SESSION_ID = `cs_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const definition = (about: string, repos = true): WorkspaceDefinition => ({
  name: 'sandbox-check', about,
  repos: repos ? [
    { name: 'hello', remote: 'https://github.com/octocat/Hello-World' },
    { name: 'spoon', remote: 'https://github.com/octocat/Spoon-Knife', clone: 'lazy', description: 'checked out on demand' },
  ] : [],
});

const t0 = Date.now();
const say = (...a: unknown[]) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
let failed = 0;
const check = (ok: boolean, what: string) => {
  say(ok ? 'PASS' : 'FAIL', what);
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | undefined | Promise<T | undefined>, ms = 30_000, every = 100): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) {
    const v = await f();
    if (v) return v;
  }
}
const refuse = (why: string): never => {
  console.error(`sandbox-check: ${why}`);
  process.exit(2);
};

const user = runnerUser(process.env) ?? refuse('set SP_RUNNER_USER (the runners\' user, `agent` on a computer)');
const IMAGE: string = process.env.SP_IMAGE || refuse('set SP_IMAGE (the release\'s .sp-version.env has it)');
if (!process.env.SP_IMAGE_ABI) refuse("set SP_IMAGE_ABI (the release's .sp-version.env has it)");
if (!existsSync(path.join(ROOT, 'dist/runner-boot.mjs'))) refuse(`${ROOT} has no dist/runner-boot.mjs: run it from a release (node scripts/bundle-runner.mjs builds one)`);
try {
  execFileSync('/usr/bin/systemctl', ['is-active', '--quiet', 'slack-presence-host.service']);
  refuse('slack-presence-host is running here; this check would be a second host on its directories');
} catch {
  // not active: the directories are ours for the run
}
const as = asRunner(user.sudo);
const podman = (args: string[], timeoutMs = 30_000) => as.podman(args, { timeoutMs });
const mnt = mounts({ as, root: ROOT, dataDir: DATA });
/** Read anew at every use: the host writes the records. */
const records = () => sandboxRecords(path.join(DATA, 'state', 'sandboxes'));
const savedDefinition = existsSync(gatewayDefinitionPath()) ? readFileSync(gatewayDefinitionPath(), 'utf8') : undefined;

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
/** `userId`: the member the wire socket knows the person as, who alone may open a terminal in their sessions. */
const person = (dir: string, slackUserId: string, userId: string): Person => ({ slackUserId, userId, dir, gitName: 'Sandbox Check', gitEmail: 'check@example.com' });
const PAT = person('sandbox-check', 'U_OWNER', 'usr_sandbox_check');
const QUINN = person('sandbox-check-b', 'U_OTHER', 'usr_sandbox_check_b');
/** The previews this gateway registered: the allow-list holds APP_PORT from the start, which no host with containers may serve. */
const preview: PreviewConfig = { tunnelToken: '', key: randomBytes(32).toString('base64url'), ports: [APP_PORT] };
const asked: { from: string; req: PreviewRequest }[] = [];
const names = new Map<string, number>();
/** No model credential: the endpoint is src/dev/fake-model.mjs inside the session's own container, and the key is a word. */
const credentials = { slackBotToken: 'xoxb-fake', slackBotUserId: 'U_BOT', anthropicApiKey: 'no-key-the-model-is-a-stand-in', anthropicBaseUrl: MODEL_URL };
/** What the gateway's welcome carries: with `--spares` the organization's Claude credential too (a spare parks a Claude Code with it), and repositories or none. */
const gateway = { spares: SPARES, repos: true };
/** Protocol 4: the host serves its wire socket, and a thread with a session id gets a journal (work 084), which its container must have mounted. */
const welcome = (about: string) =>
  toHost({ t: 'welcome', protocol: 4, credentials: gateway.spares ? credentials : { slackBotToken: '', slackBotUserId: '' }, people: [PAT, QUINN], definition: definition(about, gateway.repos), preview, wire: { key: preview.key } });
wss.on('connection', (c) => {
  conn = c;
  c.on('message', (d) => {
    const m = JSON.parse(String(d)) as HostToGateway;
    events.push(m);
    if (m.t === 'hello') welcome('first');
    if (m.t === 'preview') {
      asked.push({ from: m.from, req: m.req });
      const name = m.req.name ?? `p${m.req.port}`;
      names.set(name, m.req.port);
      preview.ports = [APP_PORT, ...names.values()];
      toHost({ t: 'previews', preview });
      toHost({ t: 'previewed', id: m.id, result: { url: `https://${name}.opencomputer.app`, name, port: m.req.port } });
    }
    if (m.t === 'unpreview') {
      names.delete(m.req.name);
      preview.ports = [APP_PORT, ...names.values()];
      toHost({ t: 'previews', preview });
      toHost({ t: 'previewed', id: m.id, result: { url: '', name: m.req.name, port: 0 } });
    }
    if (m.t === 'token') {
      tokenSessions.push(m.sessionKey);
      toHost({ t: 'token', id: m.id, result: { token: `ghs_fake${tokenSessions.length}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
    }
  });
});
let ts = 1;
/** Tell the host a thread's `cs_` id, as a gateway does with the first API call for a session it does not know. */
async function known(session: SessionSpec): Promise<string> {
  const sessionId = session.sessionId ?? mintId('cs');
  const id = randomUUID();
  const member = session.owner.userId ?? '';
  toHost({ t: 'api', id, sessionId, method: 'sessions.get', params: { sessionId }, actor: { id: member, name: null, via: 'api', client: null }, member, session });
  await until(() => events.find((e) => e.t === 'api-result' && e.id === id), 15_000);
  return sessionId;
}

/** One thread of the check: its spec, and what the check reads of its container. */
function thread(owner: Person, n: number, sessionId?: string) {
  const key = `C_SANDBOX:${(NOW + n).toFixed(3)}`;
  const spec: SessionSpec = { key, kind: 'thread', channel: 'C_SANDBOX', threadTs: key.split(':')[1], owner, title: `sandbox check ${n}`, mode: 'bypassPermissions', ...(sessionId && { sessionId }) };
  const record = () => records().find(owner.dir, key);
  const id = () => record()?.id ?? '';
  const t = {
    key, owner, spec, record, id,
    get run() { return sandboxRunFor(RUN, id()); },
    /** The thread's files, its worktree registry for a repository, on the host. */
    workspace: mnt.workspace({ person: owner.dir, key }),
    registry: (repo: string) => mnt.registry({ person: owner.dir, key }, repo),
    branch: `sp/${safeKey(key)}`,
    async deliver(trace = mkTrace(), text = '!status') {
      const d = randomUUID();
      const at = Date.now();
      toHost({ t: 'deliver', id: d, session: spec, msg: { userId: owner.slackUserId ?? 'U_OWNER', text, ts: `3.${ts++}` }, credentials, trace });
      const reply = await until(() => events.find((e): e is Extract<HostToGateway, { t: 'reply' }> => e.t === 'reply' && e.id === d), 120_000, SPARES ? 5 : 100);
      return { reply, ms: Date.now() - at, trace };
    },
    reports: () => events.flatMap((e) => (e.t === 'session' && e.report.key === key ? [e.report] : [])),
    inspect: (format: string) => podman(['inspect', '--format', format, containerName(id())]).then((s) => s.trim(), () => ''),
    logs: () => podman(['logs', containerName(id())]).catch(() => ''),
    unitActive: () => as.run(['/usr/bin/systemctl', '--user', 'is-active', '--quiet', unitName(id())], { timeoutMs: 5000 }).then(() => true, () => false),
    /** A shell script inside, as the session's user (or root, which is the runners' user outside); what it printed, or `error: …`. */
    inside: (script: string, as_ = '1500:1500') =>
      podman(['exec', '--user', as_, containerName(id()), '/bin/sh', '-c', script], 60_000).then((s) => s.trim(), (e: PodmanError) => `error: ${(e.stderr || e.message).trim()}`),
    pid: async () => Number((await podman(pidArgs(id()))).trim()),
    /** One request on the session's own token socket, from inside its container. */
    askToken: () =>
      t.inside(`node -e 'const s=require("net").createConnection(process.env.SP_TOKEN_SOCKET,()=>s.write(JSON.stringify({sessionKey:"C_OTHER:1.1"})+"\\n"));let b="";s.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).token)).on("error",e=>{console.log("error "+e.message)})'`),
  };
  return t;
}
type Thread = ReturnType<typeof thread>;
const A1 = thread(PAT, 1);
const A2 = thread(PAT, 2);
const B = thread(QUINN, 3, SESSION_ID);
const all = [A1, A2, B];
/** The `cs_` ids the host was told for the Slack threads. */
const sessions: string[] = [];
let wire: WireClient | undefined;
/** A thread as sandbox-check-reach.ts takes one: read once its container is there. */
const reached = (name: string, t: Thread, sessionId: string): Reached => ({ name, spec: t.spec, sessionId, id: t.id(), run: t.run, workspace: t.workspace, member: t.owner.userId as string });

// ---- the host, and the cleanup

function startHost(env: Record<string, string> = {}): ChildProcess {
  const { SP_DEFINITION, WORKDIR, SLACK_BOT_TOKEN, ...rest } = process.env;
  const h = spawn(process.execPath, ['--import', 'tsx', 'src/host/main.ts'], {
    cwd: ROOT,
    env: { ...rest, SP_GATEWAY_URL: `ws://127.0.0.1:${(wss.address() as net.AddressInfo).port}/host`, SP_HOST_TOKEN: 'check-token', SP_HOST_ID: 'sandbox-check',
      SP_RUN: RUN, SP_DATA: DATA, SP_IDLE_MS: String(IDLE_MS), SP_LAUNCH: 'podman', SP_POOL_SIZE: '0', SP_FAKE_SLACK: '1', SP_ARTIFACTS_IDLE_HOURS: String(ARTIFACTS_IDLE_HOURS),
      SP_TELEMETRY_URL: `http://127.0.0.1:${(collector.address() as net.AddressInfo).port}`, SP_TELEMETRY_CREDENTIAL: 'check-credential', SP_REGION: 'local', SP_SUBSTRATE: 'vm', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const s of [h.stdout!, h.stderr!]) s.on('data', (d) => process.stdout.write(String(d).replace(/^(?=.)/gm, '    host| ')));
  return h;
}

async function cleanup() {
  if (KEEP) return say('--keep: left the containers and their files');
  const quiet = (p: Promise<unknown>) => p.catch((e) => say(`cleanup: ${e.message}`));
  rmSync(path.join(DATA, 'state', 'previews.json'), { force: true });
  for (const s of [...sessions, SESSION_ID]) rmSync(path.join(DATA, 'state', 'uploads', `${s}.json`), { force: true });
  for (const s of sessions) rmSync(path.join(DATA, 'journals', s), { recursive: true, force: true });
  // The threads', and what no record names below this check's SP_RUN: the spares.
  const below = (() => { try { return readdirSync(path.join(RUN, 'sandbox')); } catch { return []; } })();
  const spares = below.filter((id) => /^[0-9a-f]{16}$/.test(id) && !records().get(id));
  for (const id of new Set([...all.map((t) => t.id()), ...spares])) {
    if (!id) continue;
    const run = sandboxRunFor(RUN, id);
    await quiet(podman(['rm', '--force', '--volumes', containerName(id)]));
    await quiet(podman(['volume', 'rm', '--force', volumeName(id)]));
    await podman(unshareRmArgs([runnersDir(run), path.dirname(secretsFor(run, id))])).catch(() => {});
    rmSync(run, { recursive: true, force: true });
    records().delete(id);
  }
  // In the user namespace: a session writes there as root and as its own users.
  await quiet(podman(unshareRmArgs([PAT, QUINN].map((p) => path.join(DATA, 'people', p.dir))), 60_000));
  rmSync(path.join(DATA, 'journals', SESSION_ID), { recursive: true, force: true });
  if (savedDefinition === undefined) rmSync(gatewayDefinitionPath(), { force: true });
  else writeFileSync(gatewayDefinitionPath(), savedDefinition);
}

/** Threads delivered to every 8 s, so that none leaves for idleness while it is looked at. */
const kept = new Set<Thread>();
const keeping = setInterval(() => void Promise.all([...kept].map((t) => t.deliver())), 8000);

/** The step 7 checks on running threads: `a` and its sibling `a2` of one person, `b` of another, with a journal. */
async function workspaces(a: Thread, a2: Thread, b: Thread) {
  // ---- what a thread got
  const ra = a.record();
  const hello = ra?.repos?.hello;
  check(!!hello && hello.branch === a.branch && hello.from === 'origin/master' && /^[0-9a-f]{40}$/.test(hello.base) && !ra?.repos?.spoon,
    `the record is the fork's record: ${JSON.stringify(ra?.repos)}`);
  const seen = await a.inside('cd /workspace/hello && git status --porcelain --branch && git rev-parse HEAD && cat .git && LC_ALL=C ls -A /workspace && ls /clones && ls /clones/hello/.git/worktrees && git -C /clones/hello config gc.worktreePruneExpire');
  check(seen === [`## ${a.branch}`, hello?.base, 'gitdir: /clones/hello/.git/worktrees/hello', '.claude', '.fork.json', 'AGENTS.md', 'hello', 'hello', 'hello', 'never'].join('\n'),
    `inside: /workspace/hello is a clean worktree of /clones/hello on ${a.branch}, the registry holds it alone, the clone never prunes: ${JSON.stringify(seen)}`);
  const mounted = (await a.inside("awk '{print $5}' /proc/self/mountinfo | grep -E '^/(workspace|clones)' | sort")).split('\n');
  check(mounted.join(' ') === '/clones/hello /clones/hello/.git/worktrees /workspace', `mounted for it: ${mounted.join(' ')}`);
  const fork = JSON.parse((await a.inside('cat /workspace/.fork.json')) || '{}');
  check(fork.key === a.key && fork.owner === a.owner.dir && fork.repos?.hello?.base === hello?.base, `.fork.json in the workspace is a copy of the record: ${JSON.stringify(fork)}`);
  check(/spoon/.test(await a.inside('cat /workspace/AGENTS.md')), 'AGENTS.md lists the repository that is not checked out');
  check(lstatSync(path.join(a.workspace, 'hello', '.git')).isFile() && lstatSync(path.join(a.registry('hello'), 'hello', 'HEAD')).isFile(),
    `on the host: the worktree is in ${a.workspace}, its registry in ${a.registry('hello')}`);
  const commit = await a.inside('cd /workspace/hello && echo edited >> README && node -e "console.log(require(\'fs\').readFileSync(\'README\',\'utf8\').includes(\'edited\'))" && git -c user.name=check -c user.email=check@example.com commit -qam "sandbox check" && git log --format=%s -1 && git status --porcelain | wc -l');
  check(commit === 'true\nsandbox check\n0', `a session edits, runs and commits in its worktree: ${JSON.stringify(commit)}`);

  // ---- a sibling thread of the same person, and another person's
  const [d2, d3] = await Promise.all([a2.deliver(), b.deliver()]);
  kept.add(a2).add(b);
  check(!!d2.reply?.ok && !!d3.reply?.ok, `a second thread of ${a.owner.dir} and one of ${b.owner.dir} → ok in ${d2.ms} and ${d3.ms} ms (${d2.reply?.error ?? ''}${d3.reply?.error ?? ''})`);
  await a.inside('echo secret-of-a > /workspace/marker-a && echo secret-of-a > /workspace/hello/marker-a');
  const view = (t: Thread) => t.inside(`ls -A /workspace /workspace/hello | grep -c marker-a; cat /proc/self/mountinfo | grep -c -e '${safeKey(a.key)}'${t.owner === a.owner ? '' : ` -e '/${a.owner.dir}/'`}; ls -d ${a.workspace} ${path.join(DATA, 'people')} 2>&1 | grep -c -v 'No such file'; ls /clones/hello/.git/worktrees | tr '\\n' ' '`);
  check((await view(a2)) === '0\n0\n0\nhello', `the sibling sees neither the first thread's files nor its registry (${JSON.stringify(await view(a2))})`);
  const other = await b.inside(`${`cat /proc/self/mountinfo | grep -c '/${a.owner.dir}/'`}; timeout 40 find / -name marker-a -not -path '/proc/*' 2>/dev/null | wc -l; ls ${path.join(DATA, 'people')} 2>&1 | grep -c -v 'No such file'; git -C /workspace/hello log --all --format=%s | grep -c 'sandbox check'; true`);
  check(other === '0\n0\n0\n0', `the other person's thread has no mount of ${a.owner.dir}'s, finds no file of theirs anywhere, and its clone has not their commit (${JSON.stringify(other)})`);
  const pruned = await a2.inside('cd /workspace/hello && git worktree prune --expire now -v 2>&1; git -C /clones/hello worktree prune --expire now -v 2>&1; git worktree list | wc -l');
  const sibling = await a.inside('cd /workspace/hello && git status --porcelain --branch && git log --format=%s -1');
  check(pruned === '2' && sibling === `## ${a.branch}\n?? marker-a\nsandbox check` && lstatSync(path.join(a.registry('hello'), 'hello', 'gitdir')).isFile(),
    `git worktree prune in the sibling removes nothing (${JSON.stringify(pruned)}) and the first thread's worktree works (${JSON.stringify(sibling)})`);

  // ---- ws-add.sh again, and the mount helper
  const row = `hello\tok\t${a2.branch}\tmaster\t${a2.record()?.repos?.hello?.base}\t`;
  const again = await podman(execArgs(a2.id(), ['/bin/sh', path.join(ROOT, 'bin/ws-add.sh'), '/clones', '/workspace', a2.branch, '0', 'hello'], { dir: '/' }));
  check(again.trimEnd() === row.trimEnd() && (await a2.inside('git -C /workspace/hello status --porcelain --branch')) === `## ${a2.branch}`, `ws-add.sh a second time answers the same and changes nothing: ${JSON.stringify(again)}`);
  const pid = await a2.pid();
  await a2.inside(`ln -s ${b.workspace} /workspace/link-out; ln -s /etc /tmp/link-etc`);
  const mount = (id: string, p: number, who: string, src: string, dst: string) =>
    as.podman(mountArgs(ROOT, p, id, who, [{ src, dst }]), { timeoutMs: 10_000, env: { SP_DATA: DATA } }).then(() => 'mounted', (e: PodmanError) => `exit ${e.code}: ${e.stderr.trim().split('\n').at(-1)}`);
  const me = a2.owner.dir;
  const refusals: [string, Promise<string>, string][] = [
    ["another person's workspace", mount(a2.id(), pid, me, b.workspace, '/mnt/x'), '2'],
    ['a directory outside the data', mount(a2.id(), pid, me, '/etc', '/mnt/x'), '2'],
    ['a link the session left in its workspace', mount(a2.id(), pid, me, path.join(a2.workspace, 'link-out'), '/mnt/x'), '2'],
    ['a source written with ..', mount(a2.id(), pid, me, `${a2.workspace}/../../../${b.owner.dir}/sessions`, '/mnt/x'), '2'],
    ['a destination through a link in the container', mount(a2.id(), pid, me, a2.workspace, '/tmp/link-etc/x'), '[24]'],
    ["another container's process", mount(a2.id(), await b.pid(), me, a2.workspace, '/mnt/x'), '3'],
  ];
  for (const [what, r, code] of refusals) check(new RegExp(`^exit ${code}: `).test(await r), `the mount helper refuses ${what}: ${await r}`);
  check((await mount(a2.id(), pid, me, a2.workspace, '/workspace')) === 'mounted' && (await a2.inside("grep -c ' /workspace ' /proc/self/mountinfo; ls /mnt | wc -l")) === '1\n0',
    'mounting what is mounted changes nothing, and nothing refused was mounted');

  // ---- the journal of a session of the API
  const journal = path.join(DATA, 'journals', SESSION_ID);
  const j = await b.inside(`grep -c ' ${journal} ' /proc/self/mountinfo; ls ${journal}; ls ${path.dirname(journal)} | wc -l`);
  check(new RegExp(`^1\\n(.*\\n)*${SESSION_ID}\\.jsonl\\n(.*\\n)*1$`).test(j) && existsSync(path.join(journal, `${SESSION_ID}.jsonl`)), `a session with a journal has its own journal directory mounted at the host's path, and no other (${JSON.stringify(j)})`);

  // ---- checkout, by the host's own parts in this process
  const tm = createTelemetry({ service: 'host', version: 'check', region: 'local', send: async () => {} });
  const scripts = sandboxScripts({ as, sudo: user.sudo, tm, root: ROOT, dataDir: DATA, helperRun: path.join(RUN, 'helper'), image: IMAGE,
    execIn: (id, argv, o) => as.podman(execArgs(id, argv, { dir: o.dir, interactive: o.stdin !== undefined }), { timeoutMs: o.timeoutMs, stdin: o.stdin }) });
  useScripts((clonesDir) => scripts.helperScripts(path.basename(path.dirname(clonesDir))));
  kept.delete(a2);
  await a2.deliver(); // the host writes the record at a delivery: the last one before the checkout, which the host does not know of
  const ws = sandboxWorkspaces({ as, records: records(), mounts: mnt, scripts: scripts.sessionScripts, pid: () => a2.pid() });
  const at = Date.now();
  const out = await ws.checkout(a2.id(), ['octocat/Spoon-Knife', 'nope', '../hello']);
  const spoon = out.find((r) => r.name === 'spoon');
  check(!!spoon && !spoon.error && spoon.branch === a2.branch && out.filter((r) => r.error).length === 2, `checkout in ${Date.now() - at} ms (cloned by a helper container): ${JSON.stringify(out)}`);
  const co = await a2.inside('git -C /workspace/spoon status --porcelain --branch; ls /clones; ls /clones/spoon/.git/worktrees; node -p "Object.keys(require(\'/workspace/.fork.json\').repos).join()"');
  check(co === `## ${a2.branch}\nhello\nspoon\nspoon\nhello,spoon` && Object.keys(a2.record()?.repos ?? {}).join() === 'hello,spoon', `the repository is mounted and checked out, the record and its copy have it: ${JSON.stringify(co)}`);
  check((await a.inside('ls /clones')) === 'hello', 'the thread that did not ask has no mount of it');

  // ---- the definition changes: a running container reads the new one
  welcome('second');
  const def = () => { try { return JSON.parse(readFileSync(path.join(a2.run, 'definition.json'), 'utf8')).about; } catch { return undefined; } };
  check(!!(await until(() => (def() === 'second' ? true : undefined), 10_000)) && /"about": ?"second"/.test(await a2.inside('cat $SP_DEFINITION')), 'a definition the gateway sends is written again for a running container, which reads it');
}

async function finish(host?: ChildProcess): Promise<never> {
  clearInterval(keeping);
  wire?.close();
  host?.kill('SIGTERM');
  await sleep(1500);
  host?.kill('SIGKILL');
  await cleanup();
  wss.close();
  collector.close();
  say(failed ? `${failed} check(s) FAILED` : 'all checks passed');
  process.exit(failed ? 1 : 0);
}

if (SPARES) {
  let host: ChildProcess | undefined;
  await spareChecks({
    run: RUN, data: DATA, image: IMAGE, idleMs: IDLE_MS, say, check, until, sleep, podman, events, tel, tokenSessions, mkTrace, people: [PAT, QUINN],
    records, clone: (p, name) => mnt.clone(p.dir, name),
    thread: (owner, n) => { const t = thread(owner, n); all.push(t); return t; },
    welcome: (about, repos) => { gateway.repos = repos; welcome(about); },
    start: (env) => (host = startHost(env)),
  }).catch((e) => check(false, `the check itself failed: ${(e as Error)?.stack ?? e}`));
  await finish(host);
}

const host = startHost();
try {
  check(!!(await until(() => events.find((e) => e.t === 'hello'))), 'host with SP_LAUNCH=podman dialed the gateway and said hello');
  const cloneAt = Date.now();
  const clones = [PAT, QUINN].map((p) => path.join(mnt.clone(p.dir, 'hello'), '.git', 'worktrees'));
  check(!!(await until(() => (clones.every((c) => existsSync(c)) ? true : undefined), 180_000)), `helper containers cloned the eager repository for both people in ${Date.now() - cloneAt} ms`);
  check(!existsSync(mnt.clone(PAT.dir, 'spoon')), 'the lazy repository is not cloned');

  // ---- a new thread
  const d1 = await A1.deliver();
  check(!!d1.reply?.ok, `first delivery → reply ok in ${d1.ms} ms (${d1.reply?.error ?? ''})`);
  const record = await until(A1.record, 5000);
  const id = record?.id;
  check(!!record && record.key === A1.key && record.person === PAT.dir, `the thread has a record: ${JSON.stringify(record)}`);
  if (!id) throw new Error('no record: nothing more can be checked');
  const run = A1.run;
  check((await A1.inspect('{{.State.Status}}')) === 'running' && (await A1.unitActive()), `container ${containerName(id)} runs and its unit ${unitName(id)} is active`);
  const pid = await A1.pid();
  const cgroup = pid ? readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim() : '';
  check(new RegExp(`/${unitName(id).replace(/\./g, '\\.')}/`).test(cgroup), `its first process (${pid}) is in that unit's cgroup: ${cgroup}`);
  check((await A1.inspect('{{.Config.Image}}')) === IMAGE && (await A1.inspect('{{index .Config.Labels "sp.abi"}}')) === process.env.SP_IMAGE_ABI,
    'it was created from SP_IMAGE and carries SP_IMAGE_ABI');
  check(lstatSync(socketFor(run, id)).isSocket(), `the runner listens on ${socketFor(run, id)}`);
  check(!!(await until(async () => (/chat\.postMessage .*cwd/.test(await A1.logs()) ? true : undefined))), 'the runner answered !status into the fake Slack');
  const status = (await A1.logs()).split('\n').find((l) => /chat\.postMessage .*cwd/.test(l)) ?? '';
  check(/\/workspace\b/.test(status) && !status.includes(DATA), 'its cwd is /workspace, and it names no host path');
  const fp = (await until(() => A1.reports().find((r) => r.status === 'idle')))?.forkPath;
  check(fp === A1.workspace, `the report the gateway got names the host's path: ${fp}`);
  const seen = (await A1.inside('id -u; echo $SP_RUN')).split('\n').join(' ');
  check(seen === `1500 ${run}`, `inside: uid 1500, SP_RUN its own run directory (${seen})`);
  check(readlinkSync(path.join(run, 'token.sock')) === path.relative(run, tokenSocketFor(run, id)), `token.sock in its run directory links to ${path.relative(run, tokenSocketFor(run, id))}`);
  const tk = await A1.askToken();
  check(tk.startsWith('ghs_fake') && tokenSessions.at(-1) === A1.key, `a token asked for inside, naming another session, is asked of the gateway for this one (${tk}, ${JSON.stringify(tokenSessions)})`);
  const l1 = launched(d1.trace) ?? (await until(() => launched(d1.trace), 10_000));
  check(l1?.data?.launch_mode === 'podman' && typeof l1.data['container.create_ms'] === 'number' && typeof l1.data['container.start_ms'] === 'number' && l1.data['container.recreated'] === undefined
    && typeof l1.data['container.mount_ms'] === 'number' && typeof l1.data['container.add_ms'] === 'number', `runner.launched: ${JSON.stringify(l1?.data)} duration ${l1?.duration_ms} ms`);
  await A1.inside('echo kept > /home/agent/sandbox-check-marker');

  // ---- workspaces, while the thread runs; then build directories for housekeeping to find once it has stopped
  kept.add(A1);
  await workspaces(A1, A2, B);
  await A1.inside('cd /workspace/hello && mkdir -p node_modules/pkg .venv/bin && echo node_modules > .gitignore');
  await A1.inside('echo x > /workspace/hello/node_modules/pkg/made-by-root && chmod 600 /workspace/hello/node_modules/pkg/made-by-root', '0:0');

  // ---- warm
  const d2 = await A1.deliver();
  check(!!d2.reply?.ok && (await A1.pid()) === pid, `second delivery → ok in ${d2.ms} ms, same container process`);

  // ---- what reaches into a running container (step 9): the two threads of one person
  const dA2 = await A2.deliver();
  kept.add(A2);
  check(!!dA2.reply?.ok && !!A2.id() && A2.id() !== id && (await A2.inspect('{{.State.Status}}')) === 'running', `the second thread of the same person runs in its own container ${containerName(A2.id())}`);
  sessions.push(await known(A1.spec), await known(A2.spec));
  const a = reached('A', A1, sessions[0]);
  const b = reached('B', A2, sessions[1]);
  const q = reached('Q', B, await known(B.spec));
  const wireSocket = path.join(RUN, 'wire', 'wire.sock');
  check(!!(await until(() => existsSync(wireSocket) || undefined, 10_000)), `the host serves its wire socket ${wireSocket}`);
  wire = await wireClient(wireSocket);
  const byId = (cid: string) => all.find((t) => t.id() === cid) ?? refuse(`no thread ${cid}`);
  const kit: Kit = {
    root: ROOT, dataDir: DATA, key: preview.key, member: PAT.userId as string, say, check, until, asked, wire,
    inside: (cid, script) => podman(['exec', '--user', '1500:1500', containerName(cid), '/bin/sh', '-c', script]).then((s) => s.trim()),
    detached: (cid, argv) => podman(['exec', '--detach', '--user', '1500:1500', containerName(cid), ...argv]),
    asRunner: (argv) => as.run(argv, { timeoutMs: 10_000 }),
    status: (cid) => byId(cid).inspect('{{.State.Status}}'),
    tell: (t, text) => byId(t.id).deliver(mkTrace(), text),
  };
  await reachRunning(kit, a, b, q);

  // ---- idle exit
  kept.clear();
  clearInterval(keeping);
  await A1.deliver();
  const idleAt = Date.now();
  check(!!(await until(async () => ((await A1.inspect('{{.State.Status}}')) === 'exited' ? true : undefined), IDLE_MS + 40_000)),
    `idle for ${IDLE_MS} ms: the runner left and the container is exited (${Date.now() - idleAt} ms after the delivery)`);
  check(!!(await until(async () => ((await A1.unitActive()) ? undefined : true), 10_000)), 'its unit is gone');
  check((await podman(['volume', 'exists', volumeName(id)]).then(() => true, () => false)) && !!A1.record(), 'its home volume and its record stay');
  check(!!(await until(() => A1.reports().find((r) => r.status === 'stopped'))), 'the gateway was told the session stopped');

  // ---- housekeeping: the stopped thread's build directories, asked of git in a helper container
  const modules = path.join(A1.workspace, 'hello', 'node_modules');
  check(existsSync(modules), 'the stopped thread still has the node_modules it made');
  await sleep(Math.max(0, ARTIFACTS_IDLE_HOURS * 3600e3 + 1000 - (Date.now() - idleAt)));
  const keepAt = Date.now();
  // A changed definition starts a housekeeping pass, unless one is running: asked again until it shows.
  for (let n = 0; n < 6 && existsSync(modules); n++) {
    welcome(`third ${n}`);
    await until(() => (existsSync(modules) ? undefined : true), 20_000);
  }
  check(!existsSync(modules) && existsSync(path.join(A1.workspace, 'hello', '.venv')) && existsSync(path.join(A1.workspace, 'hello', 'README')),
    `housekeeping removed the ignored node_modules (with a file root made inside) ${Date.now() - keepAt} ms after it was asked, and kept .venv, which git does not ignore`);

  // ---- what reaches a stopped thread (step 9)
  check(!!(await until(async () => ((await A2.inspect('{{.State.Status}}')) === 'exited' && !(await A2.unitActive()) ? true : undefined), 30_000)), 'the second thread is stopped too');
  check(!!(await until(async () => ((await B.inspect('{{.State.Status}}')) === 'exited' && !(await B.unitActive()) ? true : undefined), 30_000)), "and the other person's");
  await reachStopped(kit, a, b, q);

  // ---- resume
  const d3 = await A1.deliver();
  check(!!d3.reply?.ok, `delivery after the idle exit → ok in ${d3.ms} ms (${d3.reply?.error ?? ''})`);
  check(A1.record()?.id === id && (await A1.inspect('{{.State.Status}}')) === 'running' && (await A1.unitActive()), 'the same container runs again, under the same id');
  check((await A1.inside('cat /home/agent/sandbox-check-marker')) === 'kept', 'a file written in its home before the exit is there');
  const l3 = launched(d3.trace) ?? (await until(() => launched(d3.trace), 10_000));
  check(l3?.data?.['container.recreated'] === false && l3.data['container.create_ms'] === undefined && typeof l3.data['container.mount_ms'] === 'number' && l3.data['container.add_ms'] === undefined,
    `runner.launched of the resume: ${JSON.stringify(l3?.data)} duration ${l3?.duration_ms} ms`);
  check((await A1.askToken()).startsWith('ghs_fake'), 'its token socket answers again');
  const back = await A1.inside('cd /workspace/hello && git log --format=%s -1 && cat /workspace/marker-a && ls /clones/hello/.git/worktrees');
  check(back === 'from the terminal\nsecret-of-a\nhello', `its workspace, its worktree and its registry are mounted again, as it left them (${JSON.stringify(back)})`);
  await reachResumed(kit, a, b);
} catch (e) {
  check(false, `the check itself failed: ${(e as Error)?.stack ?? e}`);
}
await finish(host);
