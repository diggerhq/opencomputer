// Secrets people give sessions (work 046), on the machine, without Slack or
// Claude (the cloud's side, `!secret`, the vault and `request_secret`, is tested
// in services/managed-agents):
//   1. the runner's env file, sourced by a real bash as Claude Code would: values,
//      a change mid-session, removal (unset), file secrets, quoting, reserved names
//   2. redaction: whole values, values split across streamed deltas, PEM lines,
//      the Slack client wrapper, files that contain a value
//   3. a real runner process (fake Slack): secrets over its socket → env file,
//      variables too; files deleted when it exits
//
//   npx tsx src/dev/secrets-check.ts

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebClient } from '@slack/web-api';
import type { RunnerSpec, SessionSecret, SlackPerson } from '../protocol.js';
import { SessionSecrets, redactingClient } from '../runner/session-secrets.js';
import { secretNameProblem } from '../secret-names.js';
import { lines, send } from '../ipc.js';

/** Fake Slack payloads and rows the check pokes into; typing them would only restate Slack's API. */
// biome-ignore lint/suspicious/noExplicitAny: test fakes at the Slack edge
type Payload = any;

let failures = 0;
const check = (name: string, ok: unknown, detail?: unknown) => {
  if (!ok) failures++;
  console.log(ok ? 'PASS' : 'FAIL', name, ok || detail === undefined ? '' : JSON.stringify(detail).slice(0, 600));
};
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'secrets-check-'));

// ---------------------------------------------------------------- 1. env file

const bash = (envFile: string, cmd: string) =>
  execFileSync('bash', ['-c', `. ${envFile}; ${cmd}`], { encoding: 'utf8', env: { PATH: process.env.PATH } });
{
  const s = new SessionSecrets(path.join(tmp, 'run', 'secrets', 'sess1'));
  check('env file: directory is private (700)', (statSync(s.dir).mode & 0o777) === 0o700);
  check('env file: sources cleanly with no secrets', bash(s.envFile, 'echo ok').trim() === 'ok');
  const tricky = `it's "quoted" $HOME \`x\` \\ end`;
  s.apply([
    { name: 'API_KEY', value: 'sk-live-123456', scope: 'session' },
    { name: 'TRICKY', value: tricky, scope: 'user' },
    { name: 'SA_JSON', value: '{"k": "v"}\n', scope: 'workspace', file: true },
    { name: 'PATH', value: '/evil', scope: 'session' },
  ]);
  check('env file: value available to the next command', bash(s.envFile, 'printf %s "$API_KEY"') === 'sk-live-123456');
  check('env file: quoting survives quotes, $, backticks, backslashes', bash(s.envFile, 'printf %s "$TRICKY"') === tricky);
  const f = bash(s.envFile, 'printf %s "$SA_JSON"');
  check(
    'env file: file secret is a path to a 600 file with the exact value',
    f.startsWith(s.dir) && readFileSync(f, 'utf8') === '{"k": "v"}\n' && (statSync(f).mode & 0o777) === 0o600,
    f,
  );
  check('env file: reserved names are dropped', bash(s.envFile, 'printf %s "$PATH"') !== '/evil' && !s.names.includes('PATH'));
  check('env file: values.sh is 600', (statSync(path.join(s.dir, 'values.sh')).mode & 0o777) === 0o600);
  check('runner env: set for processes started later', process.env.API_KEY === 'sk-live-123456');
  s.apply([{ name: 'API_KEY', value: 'sk-live-rotated', scope: 'session' }]);
  check('env file: a change is seen by the next command (same env file)', bash(s.envFile, 'printf %s "$API_KEY"') === 'sk-live-rotated');
  check(
    'env file: a removed secret is unset, even if inherited',
    execFileSync('bash', ['-c', `. ${s.envFile}; printf %s "\${TRICKY-unset}"`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, TRICKY: 'stale' },
    }) === 'unset',
  );
  check('env file: a removed file secret is deleted', !existsSync(f));
  check('runner env: removed ones deleted', process.env.TRICKY === undefined && process.env.SA_JSON === undefined);
  check(
    'names: reserved and malformed refused',
    !!secretNameProblem('CLAUDE_CODE_OAUTH_TOKEN') &&
      !!secretNameProblem('GIT_ASKPASS') &&
      !!secretNameProblem('1X') &&
      !!secretNameProblem('A-B') &&
      !secretNameProblem('MONID_API_KEY'),
  );
  s.cleanup();
  check('env file: cleanup removes the directory', !existsSync(s.dir));
  delete process.env.API_KEY;
}

// ---------------------------------------------------------------- 2. redaction

{
  const s = new SessionSecrets(path.join(tmp, 'run', 'secrets', 'sess2'));
  const pem = '-----BEGIN KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7\n-----END KEY-----\n';
  s.apply([
    { name: 'TOKEN', value: 'ghp_abcdefghijklmnop', scope: 'session' },
    { name: 'PEM', value: pem, scope: 'user', file: true },
    { name: 'SHORT', value: 'abc', scope: 'workspace' },
  ]);
  check('redact: whole value', s.redact('token=ghp_abcdefghijklmnop.') === 'token=[secret:TOKEN].');
  check('redact: a line of a multi-line value', s.redact('see MIIEvQIBADANBgkqhkiG9w0BAQEFAASC here') === 'see [secret:PEM] here');
  check('redact: values under 6 chars are left (would match ordinary text)', s.redact('abc') === 'abc');
  const text = 'start ghp_abcdefghijklmnop middle ghp_abcdefghijklmnop end ghp_abc';
  let allSplits = true;
  for (let i = 0; i <= text.length; i++)
    for (let j = i; j <= text.length; j += 7) {
      const f = s.stream();
      const out = f.push(text.slice(0, i)) + f.push(text.slice(i, j)) + f.push(text.slice(j)) + f.flush();
      if (out !== 'start [secret:TOKEN] middle [secret:TOKEN] end ghp_abc') allSplits = false;
    }
  check('redact: streamed text, the value split at every point across deltas', allSplits);
  const f = s.stream();
  check('redact: stream holds back only a possible prefix', f.push('hello gh') === 'hello ' && f.push('x') === 'ghx');
  const seen: Payload[] = [];
  const fake = {
    chat: { postMessage: async (a: Payload) => (seen.push(a), { ok: true }) },
    files: { uploadV2: async (a: Payload) => (seen.push(a), { ok: true }) },
  };
  const c = redactingClient(fake, (t) => s.redact(t));
  const buf = Buffer.from('ghp_abcdefghijklmnop');
  await c.chat.postMessage({ text: 'x ghp_abcdefghijklmnop', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'ghp_abcdefghijklmnop' } }] });
  await c.files.uploadV2({ file: buf, initial_comment: 'ghp_abcdefghijklmnop' });
  check(
    'client: nested block text redacted',
    JSON.stringify(seen[0]) ===
      JSON.stringify({ text: 'x [secret:TOKEN]', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '[secret:TOKEN]' } }] }),
    seen[0],
  );
  check('client: buffers untouched, comments redacted', seen[1].file === buf && seen[1].initial_comment === '[secret:TOKEN]');
  // The real WebClient (classes, bound methods, axios inside) against a local Slack stand-in.
  const bodies: string[] = [];
  const api = createServer((req, res) => {
    let b = '';
    req
      .on('data', (d) => (b += d))
      .on('end', () => {
        bodies.push(`${req.url} ${decodeURIComponent(b)}`);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"ts":"1.1"}');
      });
  });
  await new Promise<void>((ok) => api.listen(0, ok));
  const real = redactingClient(
    new WebClient('xoxb-x', { slackApiUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/`, retryConfig: { retries: 0 } }),
    (t) => s.redact(t),
  );
  const r = await real.chat.postMessage({ channel: 'C1', text: 'real ghp_abcdefghijklmnop' });
  await real.apiCall('chat.update', { channel: 'C1', ts: '1.1', text: 'via apiCall ghp_abcdefghijklmnop' });
  api.close();
  check(
    'client: a real WebClient works wrapped and sends redacted text',
    r.ok && bodies.length === 2 && bodies.every((b) => b.includes('[secret:TOKEN]') && !b.includes('ghp_abcdefghijklmnop')),
    bodies,
  );
  check(
    'send_file guard: a file holding a value is caught',
    s.foundIn(Buffer.from('a\nghp_abcdefghijklmnop\n')) === 'TOKEN' && !s.foundIn(Buffer.from('nothing')),
  );
  s.cleanup();
}

// ---------------------------------------------------------------- 3. a real runner

{
  const owner: SlackPerson = { slackUserId: 'U_OWNER', dir: 'owner', gitName: 'Owner', gitEmail: 'i@x', admin: true };
  const RUN = mkdtempSync('/tmp/scr-'); // short: unix socket paths are limited
  const fork = path.join(tmp, 'fork');
  execFileSync('git', ['init', '-q', fork]);
  const key = 'C9:900.1';
  const sock = path.join(RUN, 'runners', 'r.sock');
  const rs: RunnerSpec = {
    session: { key, kind: 'thread', channel: 'C9', threadTs: '900.1', owner, title: 't', mode: 'default', forkPath: fork },
    socket: sock,
    version: 'check',
  };
  let out = '';
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, '..', 'runner', 'main.ts')], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, RUNNER_SPEC: JSON.stringify(rs), SP_RUN: RUN, SP_FAKE_SLACK: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const s of [child.stdout!, child.stderr!]) s.setEncoding('utf8').on('data', (d) => (out += d));
  let conn: net.Socket | undefined;
  for (let i = 0; i < 200 && !conn; i++) {
    await sleep(50);
    conn = await new Promise<net.Socket | undefined>((ok) => {
      const c = net.createConnection(sock);
      c.once('connect', () => ok(c));
      c.once('error', () => ok(undefined));
    });
  }
  check('runner: started and listening', !!conn, out.slice(-500));
  if (conn) {
    const replies: Payload[] = [];
    lines(conn, (m) => replies.push(m));
    const dir = path.join(RUN, 'secrets', Buffer.from(key).toString('base64url'));
    const secrets: SessionSecret[] = [
      { name: 'RUNNER_CHECK_KEY', value: 'rck_9876543210', scope: 'session' },
      { name: 'RUNNER_CHECK_ORG', value: 'public-org-name-42', scope: 'workspace', variable: true },
    ];
    send(conn, { t: 'secrets', secrets });
    await sleep(300);
    check(
      'runner: env file sourced by bash gives the value',
      existsSync(path.join(dir, 'env.sh')) && bash(path.join(dir, 'env.sh'), 'printf %s "$RUNNER_CHECK_KEY"') === 'rck_9876543210',
    );
    check(
      'runner: a variable is in the env file',
      bash(path.join(dir, 'env.sh'), 'printf %s "$RUNNER_CHECK_ORG"') === 'public-org-name-42',
    );
    send(conn, { t: 'exit' });
    for (let i = 0; i < 100 && child.exitCode === null; i++) await sleep(50);
    check('runner: exits and deletes its secrets directory', child.exitCode === 0 && !existsSync(dir), {
      code: child.exitCode,
      exists: existsSync(dir),
    });
  }
  child.kill();
}

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
