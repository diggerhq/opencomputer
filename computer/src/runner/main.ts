// Session runner (work 045): one process per active session, started by the
// host agent outside its own process tree. Runs one Session (Agent SDK query)
// in the session's fork and renders straight to Slack with the bot token. It
// listens on a unix socket for the host (HostToRunner / RunnerToHost, one JSON
// per line) and outlives the host: when the host restarts it reconnects here
// and gets the current report.
//
// A spare runner (work 069) starts with no session: it parks a Claude Code
// (spare.ts) and reports `spare` until the host `claim`s it for a session,
// whose fork is complete by then; from there it is that session's runner.
// Its socket, unit and secrets are named by its id, not the session.
//
// The session's harness is its spec's (work 082): Claude Code, or Codex for
// `harness: 'codex'`. harness/codex/ is imported only then, so a Claude
// runner neither loads nor parses it. A spare parks Claude Code; claimed for
// a Codex session it closes it, drops the managed Claude credential it parked
// with, and starts Codex as a cold runner would, minus the runner's launch.
//
//   RUNNER_SPEC='<RunnerSpec JSON>' node --import tsx src/runner/main.ts
//
// Credentials arrive as a `credentials` message (or SLACK_BOT_TOKEN /
// CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY in the environment) and are kept
// in memory and in this process's environment only. Secrets people give the
// session (work 046) arrive as `secrets` before deliveries and on change; see
// session-secrets.ts for how they reach commands and stay out of Slack.
// Work 084: with RunnerSpec.api or claim.api it is the session's API writer too (api/attach.ts).
// SP_FAKE_SLACK=1 renders
// to a fake client that prints every call; SP_SLACK_API_URL points the real
// client at another Slack API base URL (a local fake, in dev checks).

import net from 'node:net';
import './clean-env.js'; // first: before any module reads the environment
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebClient } from '@slack/web-api';
import { Session, type SessionHooks, prompts } from './session.js';
import { fetchAttachments, interruptDownloads } from './attachments.js';
import { type Linked, withLinked } from '../links.js';
import { SessionSecrets, redactingClient } from './session-secrets.js';
import { PromptGuard } from './prompt-guard.js';
import { codexBin } from '../runner-env.js';
import { fakeSlack } from '../dev/fake-slack.js';
import { lines, pidFileFor, secretsFor, send, tokenSocketFor } from '../ipc.js';
import { HOST_RUN, isSlackSpec, type RunnerApi } from '../protocol.js';
import { type AttachedApi, attachApi } from './api/attach.js';
import { NullSurface } from './api/surface.js';
import { RunningSubagents } from './api/running.js';
import { workspacesEnabled } from '../workspaces/index.js';
import type {
  CheckoutResult,
  Delivery,
  HostCredentials,
  TraceContext,
  HostToRunner,
  RunnerSpec,
  RunnerToHost,
  SecretRequest,
  SessionReport,
  SpawnRequest,
  SpawnResult,
  PostThreadRequest,
  PostThreadResult,
  PreviewToolResult,
  ReadThreadRequest,
} from '../protocol.js';
import { log } from '../log.js';
import { createTelemetry } from '../telemetry/emitter.js';
import type { Dimensions } from '../telemetry/envelope.js';
import { TIERS, tierOf } from '../tiers.js';
import { codexRoot } from '../codex-home.js';
import { meteredClient } from './surface-meter.js';
import { serveFiles } from './send-file-socket.js';
import { Waiters } from './waiters.js';
import { TurnEvents } from './turn-events.js';
import { sampleLoopLag } from './loop-lag.js';
import { applyPromptCacheTtl, presetTtls } from './cache-ttl.js';
import { configureCompaction } from './harness/claude/shadow.js';
import { Ordered } from './ordered.js';
import { Spare } from './harness/claude/spare.js';
import { claudeSpare } from './harness/claude/harness.js';
import { effortOf, speedOf } from './model-switch.js';
import { ensureSkills } from './skills.js';
import { credentialFingerprint } from '../credential-fingerprint.js';
import { MODEL_SOCKET } from './model-access.js';
import { createRunnerModelAccess } from './model-access-impl.js';
import type { Harness, HarnessKind } from './harness/types.js';
import { nameSession } from './harness/claude/title.js';

const env = process.env;
type Bound = NonNullable<RunnerSpec['session']>;
const spec: RunnerSpec = JSON.parse(env.RUNNER_SPEC ?? '');
/** The session: from the start, or once a spare is claimed. */
let ss: Bound | undefined = spec.session;
const ROOT = path.resolve(import.meta.dirname, '..', '..');
// Named as the socket is: the runner's id, or its session key from a host before work 069.
const secrets = new SessionSecrets(secretsFor(HOST_RUN, path.basename(spec.socket, '.sock')));

// Commits are authored by the initiator (sessionVars) and committed by the app identity.
const sessionVars = (b: Bound) => ({ GIT_AUTHOR_NAME: b.owner.gitName, GIT_AUTHOR_EMAIL: b.owner.gitEmail, SP_SESSION_KEY: b.key });
Object.assign(env, {
  GIT_COMMITTER_NAME: env.SP_COMMITTER_NAME ?? 'Computer',
  GIT_COMMITTER_EMAIL: env.SP_COMMITTER_EMAIL ?? 'computer@users.noreply.opencomputer.dev',
  // What bin/git-credential-slack-presence and bin/gh need to find the host: this runner's own
  // token socket, where the host knows which session asks (work 080).
  SP_RUN: HOST_RUN,
  SP_TOKEN_SOCKET: tokenSocketFor(HOST_RUN, path.basename(spec.socket, '.sock')),
  // bin/calvin-send-file: scripts post files into the thread (send-file-socket.ts). Not
  // `.sock`: the host takes every `*.sock` in the runners directory for a runner.
  SP_FILES_SOCKET: spec.socket.replace(/\.sock$/, '.files'),
  // Sourced by Claude Code before Bash commands: the session's secrets, current at each command.
  CLAUDE_ENV_FILE: secrets.envFile,
});
// Prompt cache TTL (cache-ttl.ts): 1 hour on Anthropic's own API, set again
// whenever the credentials change the endpoint.
const CACHE_TTL = env.SP_PROMPT_CACHE_TTL;
const presetCacheTtl = presetTtls(env);
const applyCacheTtl = () => applyPromptCacheTtl(env, CACHE_TTL, presetCacheTtl);
applyCacheTtl();
configureCompaction(env); // between turns in a fork (shadow.ts), Claude Code's own as the backstop
// The gh shim (this release's bin/) goes first on PATH: gh gets a GitHub App
// token from the host's token socket, or runs as is when there is none. With a
// workspace definition (VM), git gets the same tokens through the credential
// helper; on a laptop the person's own git credentials stay.
const bin = path.join(ROOT, 'bin');
const helper = path.join(bin, 'git-credential-slack-presence');
if (existsSync(helper)) {
  env.PATH = `${bin}${path.delimiter}${env.PATH ?? ''}`;
  if (workspacesEnabled()) {
    // Appended to any GIT_CONFIG_* already set. The empty value drops other helpers;
    // useHttpPath sends owner/name, so the token can be narrowed to the repository.
    let n = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
    for (const [k, v] of [
      ['credential.https://github.com.helper', ''],
      ['credential.https://github.com.helper', helper],
      ['credential.https://github.com.useHttpPath', 'true'],
    ]) {
      env[`GIT_CONFIG_KEY_${n}`] = k;
      env[`GIT_CONFIG_VALUE_${n}`] = v;
      n++;
    }
    env.GIT_CONFIG_COUNT = String(n);
  }
}

// Telemetry (work 054): batches go to the host, which validates and ships them;
// while no host is connected they wait in the emitter's bounded buffer.
// A spare's events carry the session from its claim on.
const telemetryBase: Dimensions = { harness: 'claude-agent-sdk', ...(env.SP_SUBSTRATE ? { substrate: env.SP_SUBSTRATE } : {}) };
const telemetry = createTelemetry({
  service: 'runner',
  version: spec.version,
  region: env.SP_REGION || 'unknown',
  send: (batch) => out({ t: 'telemetry', batch }),
  base: telemetryBase,
});
const flushTelemetry = () => void (host && telemetry.flush());
setInterval(flushTelemetry, 2000).unref();
const turns = new TurnEvents(telemetry, {
  model: () => s?.info.model,
  tierOf, apiClients: () => api?.api.log.hub.clients, // Q1: turn.started splits by protocol and clients
  provider: () =>
    ss?.harness === 'codex' ? 'chatgpt-subscription'
    : sub.route() === 'subscription' ? 'anthropic-subscription' : env.ANTHROPIC_BASE_URL ? 'anthropic-compatible' : 'anthropic',
});
sampleLoopLag((l) => turns.loopLag(l));
// Work 097: the model access behind one seam (model-access.ts); hosted builds run the owner's Claude subscription
// through oc-modelproxy (work 077; SP_MODEL_SOCKET: its socket, for tests).
const sub = createRunnerModelAccess({ env, socket: env.SP_MODEL_SOCKET || undefined, hooks: {
  session: () => s,
  out: (m) => out(m),
  downgraded: (from, to) => telemetry.emit('model.downgraded', { data: { from, to } }),
} });

const guard = new PromptGuard(env.SP_PROMPT_GUARD !== 'off', (words, where) => turns.promptWithheld(words, where));
const makeClient = (token?: string) =>
  meteredClient(
    redactingClient(
      env.SP_FAKE_SLACK === '1'
        ? fakeSlack((l) => log.info(l))
        : new WebClient(token, env.SP_SLACK_API_URL ? { slackApiUrl: env.SP_SLACK_API_URL } : {}),
      (t) => guard.redact(secrets.redact(t)),
    ),
    (c) => turns.surfaceCall(c),
  );
let botToken = env.SLACK_BOT_TOKEN;

/** The Claude credential in this process's environment, as the harness copies it at spawn. */
const claudeCredential = () =>
  [env.CLAUDE_CODE_OAUTH_TOKEN, env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_BASE_URL].map((v) => v ?? '').join('\n');
const hasClaudeCredential = () => !!(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
/** The fingerprint of that credential, as the host computes it from the credentials it sends. */
const claudeFingerprint = () =>
  credentialFingerprint({ claudeOAuthToken: env.CLAUDE_CODE_OAUTH_TOKEN, anthropicApiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL });

function applyCredentials(c: HostCredentials) {
  const before = claudeCredential();
  const route = sub.apply(c);
  if (route === 'switch') s && hooks.restart?.(); // a new route is a new harness environment: finish the turn, exit
  else if (c.claudeOAuthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = c.claudeOAuthToken;
    delete env.ANTHROPIC_API_KEY;
  } else if (c.anthropicApiKey && c.anthropicBaseUrl) {
    // Another Anthropic-compatible endpoint (an organization's metered key,
    // work 052): bearer auth, and an empty API key so it is not sent instead.
    env.ANTHROPIC_BASE_URL = c.anthropicBaseUrl;
    env.ANTHROPIC_AUTH_TOKEN = c.anthropicApiKey;
    env.ANTHROPIC_API_KEY = '';
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else if (c.anthropicApiKey) {
    env.ANTHROPIC_API_KEY = c.anthropicApiKey;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  // A Claude credential without an endpoint means Anthropic's own: drop a
  // previous endpoint. Updates carrying no Claude credential change nothing.
  if (route === 'managed' && !c.anthropicBaseUrl) {
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  applyCacheTtl();
  if (c.slackBotToken && c.slackBotToken !== botToken) {
    botToken = c.slackBotToken;
    if (s?.thread.slack) s.client = makeClient(botToken);
  }
  // The host sends credentials on connect, so the harness starts before the
  // first message; one no message went into yet restarts on a new credential
  // (a delivery's own, work 052). A harness in use keeps its own until `!restart`.
  // A spare parks one with them, and starts again on another.
  if (!hasClaudeCredential() || route === 'switch') return;
  // A Claude credential change replaces an unused Claude Code; Codex never reads one (it is on the proxy).
  if (s) s.prewarm(s.kind.id === 'claude' && claudeCredential() !== before);
  else spare?.warm(claudeFingerprint()!);
}

// ---- the session

let host: net.Socket | undefined;
let exiting = false; // idle exit: new work cancels it
let restarting = false; // !restart: exits after the turn, whatever arrives
let quitting = false;
const tasks = new RunningSubagents(); // reported; no idle exit until they end (work 084)
const out = (m: RunnerToHost) => send(host, m);

const report = (status: SessionReport['status'] = s!.isBusy ? 'busy' : 'idle'): SessionReport => ({
  key: ss!.key,
  status,
  sdkSessionId: s!.info.sdkSessionId,
  forkPath: s!.info.cwd,
  runnerVersion: spec.version,
  model: s!.info.model,
  effort: s!.info.effort,
  speed: s!.info.speed,
  mode: s!.info.mode,
  ...(ss!.harness === 'codex' && { harness: 'codex' as const }), // absent for Claude: its report is unchanged
  ...(tasks.size > 0 && { subagents: tasks.size }), // absent: none (work 084)
});
const sendSpare = () => spare && out({ t: 'spare', spare: { id: spec.id!, ready: spare.ready, version: spec.version, credential: spare.credential } });

const hooks: SessionHooks = {
  busy: (busy) => {
    out({ t: 'report', report: report() });
    if (!busy) flushTelemetry(); // the turn row leaves before an idle exit can
    if (!busy && ((exiting && !tasks.size) || restarting)) quit();
    else if (!busy) sub.idle(); // a turn refused its model: retried on the one below (work 077)
  },
  output: () => clearFeedback(),
  spawn,
  threads: { read: readThread, post: postThread },
  previews: {
    preview: (req) => askGateway<PreviewToolResult>((id) => ({ t: 'preview', id, req })),
    unpreview: (name) => askGateway<unknown>((id) => ({ t: 'unpreview', id, req: { name } })).then(() => {}),
  },
  ...(workspacesEnabled() && { checkout }),
  restart: () => {
    restarting = true;
    if (!s!.isBusy) setImmediate(quit); // after the reply to this `!restart` goes out
  },
  event: (e) => {
    if (e.t === 'task' && tasks.seen(e)) out({ t: 'report', report: report() }), exiting && !tasks.size && !s?.isBusy && setImmediate(quit);
    if (e.t === 'limit' && e.kind === 'credits') out({ t: 'out-of-credits' });
    void sub.event(e);
    if (e.t === 'turn_ended' && e.reason === 'done') void retitle();
  },
  secrets,
  guard,
  requestSecret,
  turns,
};

/** The session's title in Slack after a turn (work 093): one try at a time, none once it is final. */
let titling = false;
let titled = false;
/** The Codex harness running, for a Codex session. */
let codex: Harness | undefined;
async function retitle() {
  const sid = s?.info.sdkSessionId;
  if (titling || titled || !sid || !s?.thread.slack) return;
  titling = true;
  const named = ss?.harness === 'codex' ? codex?.name?.() : nameSession(sid, s.info.cwd);
  const r = await Promise.resolve(named).finally(() => (titling = false));
  titled = !!r?.done;
  if (r?.title && r.title !== s.info.title) (s.info.title = r.title), await s.thread.rename(r.title);
}

/** Codex for a session whose spec names it (work 082), loaded here and only then; undefined is Claude. */
async function codexFor(b: Bound): Promise<HarnessKind | undefined> {
  if (b.harness !== 'codex') return undefined;
  const { codexKind } = await import('./harness/codex/index.js');
  telemetryBase.harness = 'codex-app-server';
  return codexKind(
    {
      bin: codexBin(env),
      socket: env.SP_MODEL_SOCKET || MODEL_SOCKET,
      // Under the runner user's own home: /data is root's, and $SP_DATA/state is the host's after sp-host.sh's migration.
      root: codexRoot(env.HOME || os.homedir()),
      peerCheck: env.SP_CODEX_PEER_CHECK !== 'off',
      env,
      envFile: secrets.envFile,
      defaults: [TIERS.codex.default, TIERS.claude.default],
      version: spec.version,
      rpcFailed: (method, code) => turns.rpcFailed(method, code),
      peerChecked: (c) => turns.peerChecked(c),
    },
    b.key,
    (h) => (codex = h),
  );
}

let s: Session | undefined;
let files: ReturnType<typeof serveFiles> | undefined;
/** This runner becomes the session's: from the start, or at its claim. `kind` absent: Claude. */
function bind(b: Bound, kind?: HarnessKind) {
  ss = b;
  telemetryBase.session_key = b.key;
  secrets.base(sessionVars(b));
  s = new Session(
    {
      key: b.key,
      kind: b.kind === 'api' ? 'thread' : b.kind,
      channel: b.channel,
      threadTs: b.threadTs,
      userId: b.owner.slackUserId,
      teamId: b.teamId,
      cwd: b.forkPath,
      title: b.title,
      mode: b.mode,
      model: b.model,
      effort: b.effort,
      speed: b.speed,
      sdkSessionId: b.sdkSessionId,
    },
    isSlackSpec(b) ? makeClient(botToken) : new NullSurface(),
    () => out({ t: 'report', report: report() }),
    hooks,
    kind,
  );
  files = serveFiles(env.SP_FILES_SOCKET!, s.sendFile);
  if (b.kind === 'channel') void s.updateContextBar();
  return s;
}

let api: AttachedApi | undefined;
/** The session's API writer (work 084): takes the journal's lock, serves the API socket. */
async function link(b: Bound, a: RunnerApi | undefined = spec.api) {
  if (!a?.token || !s || api) return;
  api = await attachApi(a, s, { owner: b.owner, spec: b, redact: (t) => guard.redact(secrets.redact(t)), suspend: () => ((exiting = true), quit()), telemetry });
}

// A spare's Claude Code starts with what a session's would, reaching the session late-bound.
const parked = ss
  ? undefined
  : claudeSpare({
      gate: (name, input, ask) => s!.gate(name, input, ask),
      tools: { cwd: () => ss!.forkPath, hooks, sendFile: (...a) => s!.sendFile(...a), postCard: (...a) => s!.postCard(...a) },
    });
const spare = parked && new Spare(parked.prewarm, { changed: sendSpare, died: (why) => (log.warn('spare harness:', why), quit()) });

/**
 * `claim`: the parked Claude Code becomes the session's harness. Throws when it
 * refused (the host then starts the session cold, and this runner exits); the
 * claim is answered within ~40 ms, before any message goes in.
 */
async function claim(b: Bound, a?: RunnerApi) {
  if (b.harness === 'codex') return claimForCodex(b, a);
  const p = spare?.take();
  if (!p || s) throw new Error(s ? 'already claimed' : 'no spare is parked');
  ensureSkills(b.forkPath); // project skills must be on disk before the claim scans them
  const session = bind(b);
  const run = parked!.claim(p, { cwd: b.forkPath, mode: session.info.mode, model: session.model, effort: effortOf(session.info), speed: speedOf(session.info) });
  // `option_not_applied`: the model was refused, the session runs regardless; anything else did not take.
  const c = await p.claimed.catch((e) => {
    if (String(e?.message).startsWith('option_not_applied')) return e.claim as { parkedMs?: number } | undefined;
    p.close();
    throw e;
  });
  session.claimed(run, c?.parkedMs);
  await link(b, a);
  out({ t: 'report', report: report() });
  // The first message is labelled with these; looked up now, they are cached by then.
  if (b.owner.slackUserId) void session.thread.nameOf(b.owner.slackUserId);
  void session.thread.where();
}

/** `claim` for a Codex session: the parked Claude Code goes, Codex starts now; the host sends the session's credentials next. */
async function claimForCodex(b: Bound, a?: RunnerApi) {
  if (!spare || s) throw new Error(s ? 'already claimed' : 'no spare is parked');
  const kind = await codexFor(b);
  spare.close();
  // A Codex runner holds no Claude credential (host model-routes.ts forRunner): it gets only the session's.
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete env[k];
  sub.reset();
  const session = bind(b, kind);
  session.prewarm();
  await link(b, a);
  out({ t: 'report', report: report() });
  if (b.owner.slackUserId) void session.thread.nameOf(b.owner.slackUserId);
  void session.thread.where();
}

if (ss) bind(ss, ss.harness === 'codex' ? await codexFor(ss) : undefined), await link(ss);
// Credentials in the environment (dev); otherwise they come with the host.
if (hasClaudeCredential()) s ? s.prewarm() : spare?.warm(claudeFingerprint()!);

// The gateway acknowledges a message on receipt with 👀 (or the assistant
// thread status, which Slack clears when we post). Once output starts, the 👀
// comes off messages that started a turn; messages queued into a running turn
// keep theirs, as they always have.
const awaitingOutput: string[] = [];
function clearFeedback(ts?: string) {
  const all = ts ? [ts] : awaitingOutput.splice(0);
  if (!s?.thread.slack || !ss?.channel) return;
  for (const t of all) void s.client.reactions.remove({ channel: ss.channel, timestamp: t, name: 'eyes' }).catch(() => {});
}

// Deliveries arrive concurrently (one request each); they are handled one at a
// time up to their push, so a later message can't overtake an earlier one. One
// that hangs (a stuck interrupt or command) holds the rest for 20 s at most.
const ordered = new Ordered(20_000, () => log.warn('a delivery is still being handled after 20 s; handling the next one'));
const deliver = (m: Delivery, trace?: TraceContext) => ordered.run(() => handle(m, trace));

async function handle(m: Delivery, trace?: TraceContext) {
  // On the way out: the host waits for this process to go and starts a new one.
  if (quitting) throw new Error('runner gone');
  if (!s || !ss) throw new Error('this runner has no session yet');
  // A re-sent dispatch (the gateway re-flushes after a reconnect) was handled already.
  if (!turns.delivered(trace)) return;
  exiting = false; // new work cancels a pending idle exit
  if (m.api) {
    if (!api) throw new Error('this runner is not the session API writer');
    return void (await api.api.deliver(m.text, m.api));
  }
  if (m.text.startsWith('!')) {
    await s.command(m.text, m.userId);
    return clearFeedback(m.ts);
  }
  if (!s.isBusy) awaitingOutput.push(m.ts);
  else if (s.thread.slack) void s.client.reactions.add({ channel: ss.channel!, timestamp: m.ts, name: 'eyes' }).catch(() => {});
  const fetching = fetchAttachments(m.files, botToken, ss.key);
  const atts = m.files?.length ? turns.timed('attachments', fetching, { count: m.files.length }) : fetching;
  await s.send(withLinked(m.text, m.linked), m.userId, atts, m.mentioned && m.mentionedInline ? 'inline' : m.mentioned);
  // The gateway set the status to `processing` on receipt. A reply that only
  // answered an open prompt starts no turn, and nothing would clear it.
  if (!s.isBusy) void s.setStatus('active');
}

const toHost = (m: RunnerToHost) => !!host && (out(m), true);
const answered = <T>(m: { result?: T; error?: string }, otherwise: string): T => {
  if (!m.result) throw new Error(m.error ?? otherwise);
  return m.result;
};

// spawn_thread, read_thread, post_thread, preview and unpreview: the gateway answers through the host.
const gateway = new Waiters<RunnerToHost, { result?: unknown; error?: string }>({ send: toHost, ms: 30_000, late: 'no answer from the gateway within 30 s' });
const askGateway = <T>(frame: (id: string) => RunnerToHost) => gateway.ask(frame, (m) => answered(m, 'no answer') as T);
function spawn(req: SpawnRequest) {
  return askGateway<SpawnResult>((id) => ({ t: 'spawn', id, req }));
}
function readThread(req: ReadThreadRequest) {
  return askGateway<Linked>((id) => ({ t: 'read', id, req }));
}
function postThread(req: PostThreadRequest) {
  return askGateway<PostThreadResult>((id) => ({ t: 'post', id, req }));
}

// checkout_repo: the host clones if needed and adds the worktree; a first clone of a large repository takes a while.
const checkouts = new Waiters<RunnerToHost, { result?: CheckoutResult[]; error?: string }>({
  send: toHost,
  ms: 10 * 60_000,
  late: 'no answer from the host within 10 minutes; the clone may still finish, try again shortly',
});
function checkout(repos: string[]) {
  return checkouts.ask((id) => ({ t: 'checkout', id, repos }), (m) => answered(m, 'checkout failed'));
}

// request_secret: the gateway posts a button in the thread and answers through the host.
const secretAsks = new Waiters<RunnerToHost, { error?: string }>({ send: toHost, ms: 30_000, late: 'no answer from the gateway within 30 s' });
function requestSecret(req: SecretRequest) {
  return secretAsks.ask(
    (id) => ({ t: 'secret-request', id, req }),
    (m) => {
      if (m.error) throw new Error(m.error);
    },
  );
}

async function onHost(m: HostToRunner) {
  const reply = (p: Promise<unknown>) =>
    p.then(
      () => out({ t: 'reply', id: (m as any).id, ok: true }),
      (e) => out({ t: 'reply', id: (m as any).id, ok: false, error: String(e?.message ?? e) }),
    );
  switch (m.t) {
    case 'deliver':
      return reply(deliver(m.msg, m.trace));
    case 'action':
      return reply(
        (async () => {
          const p = prompts.get(m.promptId);
          if (!p) throw new Error('no such prompt (answered already, or the runner restarted)');
          await p.onAction(m.value, m.userId);
        })(),
      );
    case 'stop':
      return reply(s ? s.interrupt() : Promise.resolve());
    case 'claim':
      return reply(claim(m.session, m.api));
    case 'owner': // a name or email the gateway learned after the session started: commits from now on carry it
      return void (ss && ((ss.owner = m.owner), secrets.base(sessionVars(ss))));
    case 'api': // a cold start's API token: never in RUNNER_SPEC, which is in the unit's argv and environment
      return void ((spec.api = m.api), ss && link(ss));
    case 'credentials':
      return applyCredentials(m.credentials);
    case 'spawned':
    case 'thread':
    case 'posted':
    case 'previewed':
      return gateway.answer(m.id, m);
    case 'secrets':
      return secrets.apply(m.secrets);
    case 'secret-asked':
      return secretAsks.answer(m.id, m);
    case 'checked-out':
      return checkouts.answer(m.id, m);
    case 'exit': // with `ms` (retired): quit after it even if busy, ending its own harness (the host may not signal it)
      exiting = true;
      if (!s?.isBusy && !tasks.size) quit(); else if (m.ms !== undefined) setTimeout(quit, m.ms).unref();
      return;
  }
}

// ---- the socket

function quit() {
  if (quitting) return;
  quitting = true;
  log.info('runner exiting', ss?.key ?? `spare ${spec.id}`);
  if (s) out({ t: 'report', report: report('stopped') });
  s?.end();
  void api?.close();
  spare?.close();
  server.close();
  files?.close();
  rmSync(spec.socket, { force: true });
  rmSync(env.SP_FILES_SOCKET!, { force: true });
  rmSync(pidFileFor(spec.socket), { force: true });
  secrets.cleanup();
  host?.end();
  // Interrupted downloads leave `<path>.error` for the next runner's model to find.
  void Promise.race([interruptDownloads(), new Promise((r) => setTimeout(r, 2000))]).then(() => setTimeout(() => process.exit(0), 200));
}

mkdirSync(path.dirname(spec.socket), { recursive: true });
rmSync(spec.socket, { force: true });
const server = net.createServer((sock) => {
  // One host at a time: a reconnecting host replaces the old connection.
  host?.destroy();
  host = sock;
  sock.on('error', () => {});
  sock.on('close', () => {
    if (host === sock) host = undefined;
    // The host restarted: its answer will never come (the clone may still finish; checking out again joins it).
    checkouts.answerAll({ error: 'the host restarted during the checkout; check out again' });
  });
  lines(sock, onHost);
  if (s) out({ t: 'report', report: report() });
  else sendSpare();
  flushTelemetry();
});
server.listen(spec.socket, () => {
  chmodSync(spec.socket, 0o660); // the host may run as another user in this socket's group (work 077)
  writeFileSync(pidFileFor(spec.socket), String(process.pid));
  log.info(ss ? `runner ${ss.key} (${spec.version}) in ${ss.forkPath}, pid ${process.pid}` : `spare runner ${spec.id} (${spec.version}), pid ${process.pid}`);
});
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
