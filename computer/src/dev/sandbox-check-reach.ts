// The part of sandbox-check.ts about reaching into a session's container
// (work 103, step 9; C9 and C13): its previews through the runner's preview
// socket, the virtual ports and the host's proxy; its terminal; and its files,
// while it runs, while it is stopped and once it runs again. sandbox-check.ts
// owns the host, the fake gateway and the threads; this file only asks and
// compares.
//
// The `preview` and `unpreview` tools are called by the real runner and the
// real Agent SDK: the turn's model is src/dev/fake-model.mjs, started inside
// the session's container, which answers `call <tool> <json>` with that tool
// call. No model and no credential is involved.
//
// Invariants:
// - Two threads of one person, each serving a different answer on the same
//   port number inside its container, and the check itself listening on that
//   number on the host: whose answer comes back says who was reached.
// - `/files` has one place per thread, the workspace directory on the host
//   that is mounted at `/workspace`: what is uploaded while the thread runs is
//   read back while it is stopped, and the other way round.
// - A third thread, another person's and with a session id of the API, is
//   what a link out of a workspace points at, and whose journal is read.
// - What it makes inside a container goes with the container; what it uploads
//   to a stopped thread is in the thread's workspace, which sandbox-check.ts
//   removes with the person's directory.

import { type ChildProcess, execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sandboxDialer } from '../host/preview-dial.js';
import { PREVIEW_PROXY_PORT } from '../host/preview-proxy.js';
import type { Place } from '../host/workspace-files.js';
import { VIRTUAL_PORTS } from '../host/sandbox/preview-ports.js';
import { type RunRoot, previewSocketFor } from '../ipc.js';
import type { PreviewRequest, SessionSpec } from '../protocol.js';
import { signPreview } from '../signed-header.js';
import type { WireClient } from './wire-client.js';

/** The port every server of the check listens on: inside each container, and on the host. */
export const APP_PORT = 5173;
const MODEL_PORT = 18080;
/** The model endpoint a session's harness is given: the fake, on the container's own loopback. */
export const MODEL_URL = `http://127.0.0.1:${MODEL_PORT}`;

export interface Thread {
  name: string;
  spec: SessionSpec;
  /** The `cs_…` id the wire knows it by. */
  sessionId: string;
  /** Its sandbox id and run directory. */
  id: string;
  run: RunRoot;
  /** Its workspace on the host. */
  workspace: string;
  /** Its owner, as the wire names a member. */
  member: string;
}

export interface Kit {
  root: string;
  dataDir: string;
  /** The preview config's signing key. */
  key: string;
  member: string;
  say(...a: unknown[]): void;
  check(ok: boolean, what: string): void;
  until<T>(f: () => T | undefined | Promise<T | undefined>, ms?: number): Promise<T | undefined>;
  /** `sh -c` inside a thread's container, as the session's user. */
  inside(id: string, script: string): Promise<string>;
  /** A detached process inside a thread's container. */
  detached(id: string, argv: string[]): Promise<unknown>;
  /** A command as the runners' user on the host. */
  asRunner(argv: string[]): Promise<string>;
  status(id: string): Promise<string>;
  /** A message delivered to a thread. */
  tell(t: Thread, text: string): Promise<unknown>;
  /** The `preview` requests the gateway got, with who asked. */
  asked: { from: string; req: PreviewRequest }[];
  wire: WireClient;
  /** Where a `/files` script of a thread runs (sandbox/scripts.ts), as the host would be given it: `running` or stopped. */
  filesPlace(t: Thread, running: boolean): Place;
}

type Got = { status: number; body: string; headers: http.IncomingHttpHeaders } | { refused: string };
export const show = (g: Got) => ('refused' in g ? `refused (${g.refused})` : `${g.status} ${JSON.stringify(g.body.slice(0, 60))}`);
export const said = (g: Got, body: string) => !('refused' in g) && g.status === 200 && g.body === body;

function get(o: http.RequestOptions): Promise<Got> {
  return new Promise((resolve) => {
    const req = http.get({ ...o, timeout: 10_000 }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (d) => (body += d)).on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))).on('error', (e) => resolve({ refused: e.message }));
  });
}
/** A request through the host's preview proxy, signed as the previews Worker signs it. */
export const viaProxy = (k: Kit, port: number) =>
  get({ host: '127.0.0.1', port: PREVIEW_PROXY_PORT, path: '/', headers: { 'x-preview-port': String(port), 'x-preview-auth': signPreview(k.key, port), 'x-preview-host': 'check.opencomputer.app' } });
/** A request to a port of a thread through its runner's preview socket, as the proxy dials it. */
const viaSocket = (t: Thread, port: number) => get({ host: '127.0.0.1', port, path: '/', createConnection: () => sandboxDialer(t.run, t.id)(port) as never });

export const serve = (k: Kit, t: Thread, port: number) =>
  k.detached(t.id, ['node', '-e', `require("http").createServer((q,s)=>s.end("inside ${t.name}")).listen(${port},"127.0.0.1")`]);

/** The model stand-in, started inside a thread's container: it goes with the container's processes at every stop. */
export const model = (k: Kit, t: Thread) => k.detached(t.id, ['node', path.join(k.root, 'src/dev/fake-model.mjs'), String(MODEL_PORT)]);

interface Call { tool: string; input: unknown; result?: string }
const calls = async (k: Kit, t: Thread): Promise<Call[]> => JSON.parse((await k.inside(t.id, `curl -s -m 5 ${MODEL_URL}/calls`).catch(() => '')) || '[]');
/** One turn in which the (fake) model calls `tool` with `input`: the tool's result as the model got it, parsed when it is JSON. */
export async function toolCall(k: Kit, t: Thread, tool: string, input: object): Promise<{ text: string; json?: Record<string, unknown>; ms: number }> {
  const before = (await calls(k, t)).length;
  const at = Date.now();
  await k.tell(t, `sandbox-check: call ${tool} ${JSON.stringify(input)}`);
  const c = await k.until(async () => (await calls(k, t)).slice(before).find((x) => x.result !== undefined), 60_000);
  const text = c?.result ?? '(the tool was never called, or its result never reached the model)';
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(text);
  } catch {
    // an error sentence
  }
  return { text, json, ms: Date.now() - at };
}

function tarOf(files: Record<string, string>): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), 'sandbox-check-'));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    return execFileSync('/usr/bin/tar', ['-cf', '-', '-C', dir, ...Object.keys(files)], { maxBuffer: 64 << 20 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
type Listing = { entries: { path: string; type: string; pushedBy: { id: string } | null }[] };
const list = async (k: Kit, t: Thread) =>
  (await k.wire.call<Listing>({ t: 'files.list', sessionId: t.sessionId, member: t.member, path: '', depth: 3, limit: 200 })).result?.entries.map((e) => e.path) ?? [];
const code = (r: object) => ('error' in r ? (r.error as { code?: string; reason?: string }) : undefined);
/** A path that was not followed out of a workspace: refused, or not there where the script ran. */
const kept = (r: object) => ['invalid_path', 'path_not_found'].includes(code(r)?.code ?? '');
/** What `/files` answers for each of these names of `t`, as an archive and as a file. */
const reads = async (k: Kit, t: Thread, names: string[]) => (await Promise.all(names.flatMap((n) => [k.wire.get(t.sessionId, t.member, n, false), k.wire.get(t.sessionId, t.member, `${n}/marker-q`, true)])));
const codes = (rs: object[]) => rs.map((r) => code(r)?.code ?? 'READ').join(' ');

const exit = (p: ChildProcess) => new Promise<number | null>((resolve) => p.once('close', (c) => resolve(c)).once('error', () => resolve(null)));
/** Nothing of a `/files` script is left where `t`'s scripts run, and no upload's directory in its workspace. Waits: the host ends what is left after its own command ended. */
async function nothingLeft(k: Kit, t: Thread, running: boolean): Promise<string> {
  let left = '';
  await k.until(async () => {
    const procs = running
      ? await k.inside(t.id, 'pgrep -af "[O]PC_FILES=|[s]leep 30[0-9]|[s]9-big" || true')
      : (await k.asRunner(['/usr/bin/podman', 'ps', '--all', '--filter', 'name=sp-files-', '--format', '{{.Names}} {{.Status}}'])).trim();
    const dirs = (await k.asRunner(['/bin/sh', '-c', 'ls -A "$1" | grep "^\\.opc-" || true', 'sh', t.workspace])).trim();
    left = [procs, dirs].filter(Boolean).join('; ');
    return left ? undefined : true;
  }, 20_000);
  return left || 'nothing';
}
/**
 * `/files` scripts of `t` that do not run to their end (the spec's "Timeouts and failures"): one that reaches its
 * limit, one whose command the host ends, an upload whose body stops, a download nobody reads on.
 */
async function filesEnded(k: Kit, t: Thread, running: boolean) {
  const { check } = k;
  const where = running ? "running A's container" : 'a helper of stopped A';
  const place = k.filesPlace(t, running);
  const t0 = Date.now();
  const limit = await exit(place.spawn(['/bin/sh', '-c', 'sleep 300 & sleep 301', 'sh'], { seconds: 2 }));
  const ms = Date.now() - t0;
  // In the container timeout(1) ends it (124); a helper is ended by Podman, which says 255.
  const l1 = await nothingLeft(k, t, running);
  check(limit === (running ? 124 : 255) && l1 === 'nothing', `a /files script in ${where} that reaches its limit of 2 s exits ${limit} after ${ms} ms and leaves ${l1}`);
  const p = place.spawn(['/bin/sh', '-c', 'sleep 302', 'sh'], { seconds: 120 });
  const closed = exit(p);
  await new Promise((r) => setTimeout(r, 3000));
  p.kill('SIGTERM');
  const ended = await closed;
  const l2 = await nothingLeft(k, t, running);
  check(l2 === 'nothing', `one that writes nothing and whose command the host ends (exit ${ended}) leaves ${l2}`);
  const big = tarOf({ 'big.bin': 'x'.repeat(24 << 20) });
  const cut = await k.wire.putCut(t.sessionId, t.member, 's9-cut', big, big.length >> 1);
  const l3 = await nothingLeft(k, t, running);
  check(!!cut.error && l3 === 'nothing' && !(await list(k, t)).some((x) => x.startsWith('s9-cut')), `an upload whose body stops halfway is ${cut.error?.code}, and leaves ${l3} and no s9-cut`);
  const part = await k.wire.getCut(t.sessionId, t.member, 's9-big', true);
  const l4 = await nothingLeft(k, t, running);
  check('got' in part && part.got > 0 && l4 === 'nothing', `a download of 90 MB whose reader hangs up after ${'got' in part ? part.got : JSON.stringify(part.error)} bytes leaves ${l4}`);
}

/**
 * All three threads run: `a` and `b` of one person, `q` of another, with a journal. Starts the fake model in `a` and
 * `b` and leaves `a`'s preview of APP_PORT taken down, `b`'s up.
 */
export async function reachRunning(k: Kit, a: Thread, b: Thread, q: Thread) {
  const { check } = k;
  const host = http.createServer((_, res) => res.end('the host')).listen(APP_PORT, '127.0.0.1');
  try {
    await new Promise((r, j) => host.once('listening', r).once('error', j));
    for (const t of [a, b]) {
      await model(k, t);
      await serve(k, t, APP_PORT);
    }
    check((await k.until(async () => ((await k.inside(a.id, `curl -s -m 2 127.0.0.1:${APP_PORT}`).catch(() => '')) === 'inside A' ? true : undefined), 15_000)) === true
      && said(await get({ host: '127.0.0.1', port: APP_PORT, path: '/' }), 'the host'),
      `a server listens on ${APP_PORT} inside each container, and the check on the host's ${APP_PORT}`);

    // ---- the preview socket, before any preview
    const st = lstatSync(previewSocketFor(a.run, a.id));
    check(st.isSocket() && (st.mode & 0o777) === 0o660, `the runner listens on ${previewSocketFor(a.run, a.id)} (mode ${(st.mode & 0o777).toString(8)})`);
    const early = await viaSocket(a, APP_PORT);
    check('refused' in early, `before a preview its socket gives no way to port ${APP_PORT}: ${show(early)}`);
    const early2 = await viaProxy(k, APP_PORT);
    check(!('refused' in early2) && early2.status === 403 && /port not previewed/.test(early2.body), `and the proxy refuses port ${APP_PORT}, which the gateway's list allows: ${show(early2)}`);

    // ---- preview, in thread A
    const pa = await toolCall(k, a, 'preview', { port: APP_PORT, name: 's9-a' });
    const va = k.asked.find((x) => x.req.name === 's9-a');
    check(!!va && va.from === a.spec.key && va.req.port >= VIRTUAL_PORTS.first && va.req.port <= VIRTUAL_PORTS.last,
      `the runner's preview tool reached the gateway as port ${va?.req.port} (a virtual port) from ${va?.from}`);
    check(pa.json?.url === 'https://s9-a.opencomputer.app' && pa.json.listening === true && !/3\d{4}/.test(pa.text),
      `the model was answered in ${pa.ms} ms: ${pa.text}`);
    if (!va) throw new Error('no preview reached the gateway: nothing more of previews can be checked');
    const ga = await viaProxy(k, va.req.port);
    check(said(ga, 'inside A') && !('refused' in ga) && ga.headers['x-preview-origin'] === 'computer', `the proxy, asked for ${va.req.port}, answers from inside A's container: ${show(ga)}`);
    const raw = await viaProxy(k, APP_PORT);
    check(!('refused' in raw) && raw.status === 403, `asked for ${APP_PORT} itself it still refuses, so the host's own ${APP_PORT} never answers: ${show(raw)}`);
    check(said(await viaSocket(a, APP_PORT), 'inside A'), `the runner's socket now carries port ${APP_PORT}`);
    const other = await viaSocket(a, MODEL_PORT);
    check('refused' in other, `and no other port of the session (${MODEL_PORT}, where its model stand-in listens): ${show(other)}`);

    // ---- the probe, on a port nothing listens on
    const pn = await toolCall(k, a, 'preview', { port: APP_PORT + 1, name: 's9-none' });
    const vn = k.asked.find((x) => x.req.name === 's9-none');
    check(pn.json?.listening === false, `a port nothing listens on is reported so, after ${pn.ms} ms: ${pn.text}`);
    const gn = vn && (await viaProxy(k, vn.req.port));
    check(!!gn && !('refused' in gn) && gn.status === 503 && gn.headers['x-preview-state'] === 'closed', `and the proxy says closed for ${vn?.req.port}: ${gn && show(gn)}`);

    // ---- thread B: the same port number, another container
    const earlyB = await viaSocket(b, APP_PORT);
    check('refused' in earlyB, `B's socket gives no way to ${APP_PORT} because A previewed it: ${show(earlyB)}`);
    const pb = await toolCall(k, b, 'preview', { port: APP_PORT, name: 's9-b' });
    const vb = k.asked.find((x) => x.req.name === 's9-b');
    check(!!vb && vb.from === b.spec.key && vb.req.port !== va.req.port && pb.json?.listening === true, `B previews its own ${APP_PORT} as ${vb?.req.port} (${pb.ms} ms): ${pb.text}`);
    check(!!vb && said(await viaProxy(k, vb.req.port), 'inside B') && said(await viaProxy(k, va.req.port), 'inside A'), `${vb?.req.port} answers from inside B, ${va.req.port} still from inside A`);
    const fromB = await k.inside(b.id, `test -e ${a.run} && echo there || echo absent; test -S ${previewSocketFor(b.run, b.id)} && echo own; curl -s -m 2 127.0.0.1:${APP_PORT}`);
    check(fromB.split('\n').join(' ') === 'absent own inside B', `inside B: A's run directory (and so its preview socket) is ${fromB.split('\n')[0]}, and ${APP_PORT} is B's own (${fromB.split('\n').slice(1).join(', ')})`);
    const file = path.join(k.dataDir, 'state', 'previews.json');
    const table = JSON.parse(readFileSync(file, 'utf8')) as { entries: { virtual: number; id: string; port: number; name?: string }[] };
    check((statSync(file).mode & 0o777) === 0o600 && table.entries.length === 3 && table.entries.some((e) => e.id === b.id && e.port === APP_PORT && e.virtual === vb?.req.port && e.name === 's9-b'),
      `${file} (0600) holds the three: ${JSON.stringify(table.entries)}`);

    // ---- unpreview
    const ua = await toolCall(k, a, 'unpreview', { name: 's9-a' });
    const gone = await viaProxy(k, va.req.port);
    const closed = await viaSocket(a, APP_PORT);
    check(ua.text === '{}' && !('refused' in gone) && gone.status === 403 && 'refused' in closed, `after unpreview (${ua.ms} ms) ${va.req.port} is refused (${show(gone)}) and A's socket no longer carries ${APP_PORT} (${show(closed)})`);
    check(!!vb && said(await viaProxy(k, vb.req.port), 'inside B'), "B's preview is untouched");

    // ---- terminal
    await k.inside(a.id, 'echo only-in-A > /tmp/s9-mark');
    const t0 = Date.now();
    const ta = await k.wire.terminal(a.sessionId, k.member, 'id -u; hostname; pwd; cat /tmp/s9-mark; echo "$SP_RUN" 2>&1');
    check('out' in ta && ta.exitCode === 0 && ta.out.trim().split('\n').join(' ') === `1500 session /workspace only-in-A ${a.run}`,
      `a terminal of A opens inside A's container, as the session's user, in /workspace (${Date.now() - t0} ms): ${JSON.stringify('out' in ta ? ta.out : ta.error)}`);
    const tb = await k.wire.terminal(b.sessionId, k.member, 'cat /tmp/s9-mark 2>&1; echo "$SP_RUN"');
    check('out' in tb && /No such file/.test(tb.out) && tb.out.includes(b.run), `a terminal of B is in B's: ${JSON.stringify('out' in tb ? tb.out : tb.error)}`);
    const tx = await k.wire.terminal(a.sessionId, 'usr_someone_else', 'id');
    check(code(tx)?.code === 'forbidden', `another member is refused a terminal: ${JSON.stringify(code(tx))}`);
    const open = await k.wire.call<{ terminalId: string }>({ t: 'terminal.open', sessionId: a.sessionId, member: k.member, cols: 80, rows: 24, command: 'sleep 600', tty: true });
    const running = await k.until(async () => ((await k.inside(a.id, 'pgrep -f "[s]leep 600" || true')) ? true : undefined), 10_000);
    await k.wire.call({ t: 'terminal.close', terminalId: open.result?.terminalId });
    const hungUp = await k.until(async () => ((await k.inside(a.id, 'pgrep -f "[s]leep 600|[t]erminal-pty" || echo none')) === 'none' ? true : undefined), 15_000);
    check(!!open.result && running === true && hungUp === true, 'a terminal that is closed leaves no process behind in the container');

    // ---- files, both running
    const up = await k.wire.put(a.sessionId, k.member, 's9-notes', tarOf({ 'a.txt': 'pushed to A\n' }));
    check(up.result?.upload.path === 's9-notes' && up.result.upload.files === 1, `an upload to A: ${JSON.stringify(up.result ?? up.error)}`);
    const inA = await k.inside(a.id, 'cat /workspace/s9-notes/a.txt; stat -c %u /workspace/s9-notes/a.txt');
    const inB = await k.inside(b.id, 'test -e /workspace/s9-notes && echo there || echo absent');
    check(inA.split('\n').join(' ') === 'pushed to A 1500', `it is in A's /workspace, the session user's (${JSON.stringify(inA)})`);
    check(inB === 'absent' && !(await list(k, b)).some((p) => p.startsWith('s9-notes')) && (await list(k, a)).includes('s9-notes/a.txt'), `B's /workspace and B's listing do not have it (${inB}); A's listing does`);
    const back = await k.wire.get(a.sessionId, k.member, 's9-notes/a.txt', true);
    const notB = await k.wire.get(b.sessionId, k.member, 's9-notes/a.txt', true);
    check('body' in back && back.body.toString() === 'pushed to A\n' && code(notB)?.code === 'path_not_found', `it reads back from A, and from B it is ${code(notB)?.code}`);
    await k.inside(a.id, 'ln -s /etc/passwd /workspace/s9-link');
    const out = await k.wire.get(a.sessionId, k.member, '../../etc/passwd', true);
    const link = await k.wire.get(a.sessionId, k.member, 's9-link', true);
    check(code(out)?.code === 'invalid_path' && code(link)?.code === 'invalid_path', `a path that leaves the workspace, by name or by symlink, is ${code(out)?.code} / ${code(link)?.code}`);
    const onHost = (await k.asRunner(['/bin/sh', '-c', 'cat "$1/s9-notes/a.txt"; stat -c %U "$1/s9-notes/a.txt"', 'sh', a.workspace]).catch((e) => String(e.message))).trim();
    check(onHost.split('\n').join(' ') === 'pushed to A agent', `the upload to running A is in A's workspace on the host (${a.workspace}), the runners' user's: ${JSON.stringify(onHost)}`);

    // ---- /files scripts that do not run to their end
    await k.inside(a.id, 'truncate -s 90M /workspace/s9-big');
    await filesEnded(k, a, true);

    // ---- a terminal in a worktree
    const tg = await k.wire.terminal(a.sessionId, a.member, 'cd hello && pwd && git rev-parse --show-toplevel && git status --porcelain --branch | head -n 1 && git log -1 --format=%s && echo from-terminal > s9-term && git add s9-term && git -c user.name=check -c user.email=check@example.com commit -qm "from the terminal" && git log -1 --format=%s 2>&1');
    check('out' in tg && tg.exitCode === 0 && /^\/workspace\/hello\n\/workspace\/hello\n## sp\/\S+\nsandbox check\nfrom the terminal$/.test(tg.out.trim()),
      `a terminal of A works in its worktree /workspace/hello: git knows the branch and the last commit, and commits: ${JSON.stringify('out' in tg ? tg.out : tg.error)}`);

    // ---- links out of a workspace, to a sibling thread's and to another person's
    await k.inside(q.id, 'echo secret-of-q > /workspace/marker-q');
    await k.inside(b.id, 'echo secret-of-b > /workspace/marker-q');
    await k.inside(a.id, `ln -s ${b.workspace} /workspace/s9-run-to-b; ln -s ${q.workspace} /workspace/s9-run-to-q; ln -s ../../../${path.basename(path.dirname(path.dirname(q.workspace)))}/sessions/${path.basename(q.workspace)} /workspace/s9-run-rel`);
    const outs = await reads(k, a, ['s9-run-to-b', 's9-run-to-q', 's9-run-rel']);
    const byName = await k.wire.get(a.sessionId, a.member, `../${path.basename(b.workspace)}/marker-q`, true);
    check(outs.every(kept) && kept(byName), `from running A, links to the sibling's workspace and to another person's (absolute and relative) lead nowhere, as an archive or a file: ${codes(outs)}; by name: ${code(byName)?.code}`);
    const own = await k.wire.get(q.sessionId, q.member, 'marker-q', true);
    check('body' in own && own.body.toString() === 'secret-of-q\n', "and the other person reads that file through their own session's /files");

    // ---- a session of the API, with its journal mounted: what its runner records
    const tq = await k.wire.terminal(q.sessionId, q.member, 'id -u; pwd; cat marker-q');
    check('out' in tq && tq.out.trim().split('\n').join(' ') === '1500 /workspace secret-of-q', `a terminal of the session ${q.sessionId} (another person's) opens in its container: ${JSON.stringify('out' in tq ? tq.out : tq.error)}`);
    const notMine = await k.wire.terminal(q.sessionId, a.member, 'id');
    check(code(notMine)?.code === 'forbidden', `the first person is refused a terminal of it: ${JSON.stringify(code(notMine))}`);
    const pq = await k.wire.put(q.sessionId, q.member, 's9-q', tarOf({ 'q.txt': 'pushed to Q\n' })) as { result?: { upload: { files: number }; seq?: number | null }; error?: unknown };
    check(pq.result?.upload.files === 1 && typeof pq.result.seq === 'number', `an upload to it is recorded by its runner, which answers the event's seq: ${JSON.stringify(pq.result ?? pq.error)}`);
    const journal = path.join(k.dataDir, 'journals', q.sessionId, `${q.sessionId}.jsonl`);
    const events = (await k.until(async () => {
      const lines = (await k.asRunner(['/bin/cat', journal]).catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { seq: number; type: string; data?: Record<string, unknown>; actor?: { id?: string } });
      return lines.some((e) => e.type === 'terminal.closed') ? lines : undefined;
    }, 10_000)) ?? [];
    const opened = events.find((e) => e.type === 'terminal.opened');
    const pushed = events.find((e) => e.type === 'files.pushed');
    check(!!opened && opened.actor?.id === q.member && !!pushed && pushed.seq === pq.result?.seq && pushed.data?.path === 's9-q' && events.some((e) => e.type === 'terminal.closed'),
      `its journal ${journal} has terminal.opened (seq ${opened?.seq}), terminal.closed and files.pushed (seq ${pushed?.seq}: ${JSON.stringify(pushed?.data)})`);
  } finally {
    host.close();
  }
}

/** All three threads are stopped (their containers exited). */
export async function reachStopped(k: Kit, a: Thread, b: Thread, q: Thread) {
  const { check } = k;
  const t = await k.wire.terminal(a.sessionId, k.member, 'id');
  check(code(t)?.code === 'conflict' && code(t)?.reason === 'session_not_running' && (await k.status(a.id)) === 'exited',
    `a terminal of a stopped thread is refused and starts nothing: ${JSON.stringify(code(t))}`);

  const t0 = Date.now();
  const up = await k.wire.put(a.sessionId, k.member, 's9-stopped', tarOf({ 'note.txt': 'pushed while stopped\n' }));
  check(up.result?.upload.files === 1, `an upload to stopped A, through a helper container, in ${Date.now() - t0} ms: ${JSON.stringify(up.result ?? up.error)}`);
  const at = (await k.asRunner(['/bin/sh', '-c', 'cat "$1/s9-stopped/note.txt"; stat -c %U "$1/s9-stopped/note.txt"', 'sh', a.workspace]).catch((e) => String(e.message))).trim();
  check(at.split('\n').join(' ') === 'pushed while stopped agent', `it is in A's workspace on the host, the runners' user's: ${JSON.stringify(at)}`);
  const t1 = Date.now();
  const la = await list(k, a);
  const ms = Date.now() - t1;
  const lb = await list(k, b);
  check(la.includes('s9-stopped/note.txt') && !lb.some((p) => p.startsWith('s9-stopped')), `A's listing has it (${ms} ms), B's does not (A: ${JSON.stringify(la)}; B: ${JSON.stringify(lb)})`);
  const back = await k.wire.get(a.sessionId, k.member, 's9-stopped/note.txt', true);
  const tar = await k.wire.get(a.sessionId, k.member, 's9-stopped', false);
  const notB = await k.wire.get(b.sessionId, k.member, 's9-stopped/note.txt', true);
  check('body' in back && back.body.toString() === 'pushed while stopped\n' && 'body' in tar && tar.body.includes('pushed while stopped') && code(notB)?.code === 'path_not_found',
    `it reads back from A as a file and as an archive, and from B it is ${code(notB)?.code}`);
  const earlier = await k.wire.get(a.sessionId, k.member, 's9-notes/a.txt', true);
  const term = await k.wire.get(a.sessionId, k.member, 'hello/s9-term', true);
  check('body' in earlier && earlier.body.toString() === 'pushed to A\n' && 'body' in term && term.body.toString() === 'from-terminal\n',
    `what was uploaded to A while it ran, and what its terminal wrote in the worktree, read back while it is stopped: ${'body' in earlier ? JSON.stringify(earlier.body.toString()) : code(earlier)?.code}, ${'body' in term ? JSON.stringify(term.body.toString()) : code(term)?.code}`);
  await k.asRunner(['/bin/ln', '-s', b.workspace, path.join(a.workspace, 's9-to-b')]);
  await k.asRunner(['/bin/ln', '-s', q.workspace, path.join(a.workspace, 's9-to-q')]);
  const there = (await k.asRunner(['/bin/cat', path.join(a.workspace, 's9-to-b', 'marker-q'), path.join(a.workspace, 's9-to-q', 'marker-q')]).catch((e) => String(e.message))).trim();
  const outs = await reads(k, a, ['s9-to-b', 's9-to-q', 's9-run-to-b', 's9-run-to-q', 's9-run-rel']);
  const out = await k.wire.get(a.sessionId, k.member, '../' + path.basename(b.workspace), false);
  check(there === 'secret-of-b\nsecret-of-q' && outs.every(kept) && kept(out),
    `from stopped A, links that on the host lead to the sibling's workspace and to another person's (made now, and made inside while it ran) lead nowhere in the helper: ${codes(outs)}; by name: ${code(out)?.code}`);
  const pq = await k.wire.put(q.sessionId, q.member, 's9-q-stopped', tarOf({ 'q.txt': 'pushed to stopped Q\n' }));
  const lq = await list(k, q);
  const qa = await k.wire.get(a.sessionId, k.member, 's9-q-stopped/q.txt', true);
  check(pq.result?.upload.files === 1 && lq.includes('s9-q-stopped/q.txt') && lq.includes('s9-q/q.txt') && code(qa)?.code === 'path_not_found',
    `an upload to the other person's stopped session is in their listing, beside the one made while it ran, and from A it is ${code(qa)?.code}: ${JSON.stringify(pq.result ?? pq.error)}`);
  // Q's runner is gone: the host's own writer records the upload in Q's journal (this process is the host's user: it reads the file itself).
  const sq = (pq.result as { seq?: number | null } | undefined)?.seq;
  const journal = path.join(k.dataDir, 'journals', q.sessionId, `${q.sessionId}.jsonl`);
  const logged = await k.until(async () => {
    const lines = readFileSync(journal, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { seq: number; type: string; data?: Record<string, unknown> });
    return lines.find((e) => e.type === 'files.pushed' && e.data?.path === 's9-q-stopped');
  }, 5000).catch(() => undefined);
  check(typeof sq === 'number' && logged?.seq === sq, `the upload to stopped Q is in its journal, written by the host's writer: seq ${sq}, on file ${JSON.stringify(logged)}`);
  await filesEnded(k, a, false);
  check((await k.status(a.id)) === 'exited' && (await k.status(b.id)) === 'exited' && (await k.status(q.id)) === 'exited', 'none of it started a container');
}

/** `a` runs again; `b` is still stopped. */
export async function reachResumed(k: Kit, a: Thread, b: Thread) {
  const { check } = k;
  const inA = await k.inside(a.id, 'cat /workspace/s9-stopped/note.txt; stat -c %u /workspace/s9-stopped/note.txt; cat /workspace/s9-notes/a.txt');
  const back = await k.wire.get(a.sessionId, k.member, 's9-stopped/note.txt', true);
  check(inA.split('\n').join(' ') === 'pushed while stopped 1500 pushed to A' && 'body' in back && back.body.toString() === 'pushed while stopped\n',
    `what was uploaded to A while it was stopped is in its /workspace now that it runs, the session user's, and reads back through its container: ${JSON.stringify(inA)}`);
  const up = await k.wire.put(a.sessionId, k.member, 's9-stopped', tarOf({ 'note.txt': 'again\n' })) as { result?: { upload: { replaced: unknown } }; error?: unknown };
  const mine = await k.wire.put(a.sessionId, k.member, 'hello', tarOf({ 'note.txt': 'again\n' }));
  check(!!up.result?.upload.replaced && (await k.inside(a.id, 'cat /workspace/s9-stopped/note.txt')) === 'again' && code(mine)?.code === 'path_exists',
    `a second upload of that name, now through the container, replaces it as an upload (${JSON.stringify(up.result ?? up.error)}); one over the worktree is ${code(mine)?.code}`);
  const outs = await reads(k, a, ['s9-to-b', 's9-to-q']);
  check(outs.every(kept) && (await k.status(b.id)) === 'exited', `the links made on the host while it was stopped lead nowhere inside it either: ${codes(outs)}`);
}
