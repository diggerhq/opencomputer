// The model access of sandbox-check.ts (work 097 and 103): the release's
// oc-modelproxy, run by the check beside its host, with the shipped profiles
// and one more, `stand-in`, whose upstream is src/dev/fake-model.mjs on this
// host. A session's harness in its container connects to the proxy's API
// socket (the one file of the proxy its container mounts), is named by its
// unit's cgroup like any runner of a computer, and its turn is answered by
// the stand-in. No model and no credential is involved.
//
// Invariants:
// - The computer's own proxy (/run/oc-modelproxy) is neither used nor changed.
// - The sockets are in a directory of the run root, which the runners' user
//   can enter. The API socket is opened to every user (0666): this proxy runs
//   as the check's user, not as `modelproxy` with the runners' group.
// - stop() ends both processes and removes the directory.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { modelKey } from '../model-key.js';
import type { ModelRoute } from '../protocol.js';

/** Where the stand-in listens, on the host's loopback. */
const MODEL_PORT = 18443;
const PROFILE = 'stand-in';

export interface ModelCall { tool: string; input: unknown; result?: string }

export interface CheckModel {
  /** The proxy's sockets: the host's SP_MODEL_PROXY and SP_MODEL_SOCKET. */
  control: string;
  api: string;
  /** The route every session of the check runs on. */
  route: ModelRoute;
  /** The tool calls the stand-in made, with the results it was given. */
  calls(): Promise<ModelCall[]>;
  /** Per turn the stand-in answered, the text of the person's messages it was sent, earlier turns' too. */
  turns(): Promise<string[]>;
  stop(): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start the stand-in and the proxy; throws when the release has no proxy, or it does not come up. */
export async function checkModel(o: { root: string; run: string }): Promise<CheckModel> {
  const bin = path.join(o.root, 'modelproxy', 'oc-modelproxy');
  if (!existsSync(bin)) throw new Error(`${bin} is absent: deploy/bundle.sh builds it into a release (or: cd modelproxy && go build -o oc-modelproxy .)`);
  const dir = path.join(o.run, 'check-model');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  chmodSync(dir, 0o755);
  const key = path.join(dir, 'model.key');
  const cert = path.join(dir, 'model.crt');
  // A profile's upstream is https: the stand-in gets a certificate of its own, which only this proxy trusts.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const shipped = JSON.parse(readFileSync(path.join(o.root, 'modelproxy', 'profiles', 'default.json'), 'utf8'));
  const profiles = path.join(dir, 'profiles.d');
  mkdirSync(profiles);
  writeFileSync(path.join(profiles, 'default.json'), JSON.stringify(shipped));
  writeFileSync(path.join(profiles, `${PROFILE}.json`), JSON.stringify({ [PROFILE]: {
    upstream: `https://127.0.0.1:${MODEL_PORT}`,
    routes: { 'POST /v1/messages': {}, 'POST /v1/messages/count_tokens': {} },
    set: { 'X-Api-Key': '{token}' },
    harness: { claude: shipped['anthropic-key'].harness.claude },
  } }));
  const control = path.join(dir, 'control.sock');
  const api = path.join(dir, 'api.sock');
  const out = (name: string, p: ChildProcess) => {
    for (const s of [p.stdout!, p.stderr!]) s.on('data', (d) => process.stdout.write(String(d).replace(/^(?=.)/gm, `   ${name}| `)));
    return p;
  };
  const model = out('model', spawn(process.execPath, [path.join(o.root, 'src/dev/fake-model.mjs'), String(MODEL_PORT), key, cert], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const proxy = out('proxy', spawn(bin, ['-profiles', profiles, '-api-socket', api, '-control-socket', control, '-bindings-file', ''], {
    env: { PATH: process.env.PATH, SSL_CERT_FILE: cert }, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const stop = () => {
    for (const p of [proxy, model]) p.kill('SIGKILL'); // no stream of the check is worth its drain
    rmSync(dir, { recursive: true, force: true });
  };
  for (const end = Date.now() + 10_000; !(existsSync(api) && existsSync(control)); await sleep(100))
    if (Date.now() > end || proxy.exitCode !== null) {
      stop();
      throw new Error(`${bin} did not open its sockets in ${dir}`);
    }
  chmodSync(api, 0o666);
  const token = 'check-not-a-credential';
  const get = <T>(what: string) => new Promise<T[]>((resolve) => {
    https.get({ host: '127.0.0.1', port: MODEL_PORT, path: what, ca: readFileSync(cert), timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (d) => (body += d)).on('end', () => resolve(JSON.parse(body || '[]')));
    }).on('timeout', function (this: { destroy(): void }) { this.destroy(); }).on('error', () => resolve([]));
  });
  const calls = () => get<ModelCall>('/calls');
  const turns = () => get<string>('/turns');
  return { control, api, route: { mode: 'profile', profile: PROFILE, vars: { token }, key: modelKey(PROFILE, { token }) }, calls, turns, stop };
}
