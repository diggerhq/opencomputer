// GitHub tokens for sessions, relayed through the host (work 045), one-hour
// OpenComputer keys for the opencomputer shim (work 067, kind 'opencomputer'),
// and push credentials for the organization's automations repository (kind
// 'automation-repo'): the git credential helper and the shims ask on the host's token socket, runners
// ask over their own sockets, and the host asks the gateway once per session
// and repository set, caching the answer until 5 minutes before it expires.
//
// The session a token is for is the host's word, never the asker's (work 080):
// each runner has its own token socket in a directory only the host writes, and
// the host names the session it serves. The shared socket names none.
// The helper containers' socket (work 103) serves no session either, and only
// GitHub tokens for repositories of the workspace definition: a helper runs
// git on clones a session can write.
//
// Invariants: a request fails fast when the gateway is not connected and
// times out after 15 s; a failed request is not cached. Tokens are never logged.

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { type GitHubToken, HOST_RUN, HOST_TOKEN_SOCKET, type HostToGateway, RUNNER_TOKEN_DIR, type TokenKind } from '../protocol.js';
import { type RunRoot, lines, tokenSocketFor } from '../ipc.js';
import type { Telemetry } from '../telemetry/emitter.js';

export interface TokenRelay {
  /** A token from the gateway, cached until 5 minutes before it expires. */
  request(sessionKey?: string, repos?: string[], kind?: TokenKind): Promise<GitHubToken>;
  /** The gateway's `token` answer. */
  answer(m: { id: string; result?: GitHubToken; error?: string }): void;
  /**
   * Listen on a token socket: one JSON line in ({repos?, kind?}), one out ({token, expiresAt} | {error}).
   * `session`: the session asking, for a runner's own socket; a `sessionKey` in the request is ignored.
   */
  serve(socket: string, session?: () => string | undefined): net.Server;
  /**
   * A runner's own token socket below its run root (`tokenSocketFor`); `session` is the host's word for who asks.
   * Idempotent per id; the caller closes it when the runner is gone. The directory is the caller's to make (`freshTokenDir`).
   * In a sandbox's run root (work 103) it also makes `token.sock` a relative link to it, so the helpers find it under the
   * name they know; at HOST_RUN that name is the host's shared token socket and stays.
   */
  serveRunner(run: RunRoot, id: string, session: () => string | undefined): { close(): void };
  /**
   * The helper containers' token socket: GitHub tokens only, for no session, and only for repositories among
   * `allowed()` (`owner/name` of each repository in the workspace definition). A request naming none is refused.
   */
  serveHelper(socket: string, allowed: () => string[]): net.Server;
}

/**
 * Empty and make again the directory of a run root's token sockets, once at host start. Only the host writes there,
 * so a session cannot put its own socket in another's place; 02750 keeps SP_RUN's setgid group on the sockets, so
 * runners running as another user (work 077) can still reach their own.
 */
export function freshTokenDir(run: RunRoot) {
  const dir = path.dirname(tokenSocketFor(run, 'x'));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o2750);
  return dir;
}

/** `ask` sends to the gateway and returns false when it is not connected. */
export function tokenRelay(ask: (m: Extract<HostToGateway, { t: 'token' }>) => boolean, tm: Telemetry): TokenRelay {
  /** The runners' sockets being served, by path. */
  const served = new Map<string, { close(): void }>();
  const waiters = new Map<string, (m: { result?: GitHubToken; error?: string }) => void>();
  const tokens = new Map<string, Promise<GitHubToken>>();

  function request(sessionKey?: string, repos?: string[], kind: TokenKind = 'github'): Promise<GitHubToken> {
    const k = `${kind}|${sessionKey ?? ''}|${[...(repos ?? [])].sort().join(',')}`;
    const data = { repos: repos?.length ?? 0, kind };
    const cached = tokens.get(k);
    if (cached) {
      tm.emit('token.minted', { session_key: sessionKey, duration_ms: 0, data: { ...data, cache_hit: true } });
      return cached;
    }
    const minted = tm.start('token.minted', { session_key: sessionKey, data: { ...data, cache_hit: false } });
    const id = randomUUID();
    const p = new Promise<GitHubToken>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error('token request timed out'));
      }, 15_000);
      waiters.set(id, (m) => {
        clearTimeout(timer);
        waiters.delete(id);
        m.result ? resolve(m.result) : reject(new Error(m.error ?? 'no token'));
      });
      if (!ask({ t: 'token', id, sessionKey, repos, ...(kind !== 'github' && { kind }) })) {
        clearTimeout(timer);
        waiters.delete(id);
        reject(new Error('gateway not connected'));
      }
    });
    tokens.set(k, p);
    p.then(
      (t) => {
        minted.end({ outcome: 'completed' });
        setTimeout(() => tokens.get(k) === p && tokens.delete(k), Date.parse(t.expiresAt) - Date.now() - 5 * 60_000).unref();
      },
      (e) => {
        minted.end({ outcome: 'failed', error_type: /timed out/.test(String(e?.message)) ? 'timeout' : 'socket' });
        tokens.delete(k);
      },
    );
    return p;
  }

  const relay: TokenRelay = {
    request,
    answer: (m) => waiters.get(m.id)?.(m),
    serveRunner(run, id, session) {
      const socket = tokenSocketFor(run, id);
      const open = served.get(socket);
      if (open) return open;
      const server = relay.serve(socket, session);
      if (path.resolve(run) !== path.resolve(HOST_RUN)) {
        const link = path.join(run, HOST_TOKEN_SOCKET);
        rmSync(`${link}.tmp`, { force: true });
        symlinkSync(path.join(RUNNER_TOKEN_DIR, `${id}.sock`), `${link}.tmp`);
        renameSync(`${link}.tmp`, link);
      }
      const handle = { close: () => void (served.get(socket) === handle && (served.delete(socket), server.close())) };
      served.set(socket, handle);
      return handle;
    },
    serve: (socket, session) =>
      listen(socket, (req) => request(session?.() || undefined, req.repos, req.kind === 'opencomputer' || req.kind === 'automation-repo' ? req.kind : 'github')),
    serveHelper: (socket, allowed) =>
      listen(socket, async (req) => {
        if (req.kind !== undefined && req.kind !== 'github') throw new Error('this socket gives GitHub tokens only');
        const slug = (r: string) => r.replace(/\.git$/, '').toLowerCase();
        const granted = new Set(allowed().map(slug));
        const repos = Array.isArray(req.repos) ? req.repos.filter((r): r is string => typeof r === 'string') : [];
        if (!repos.length || !repos.every((r) => granted.has(slug(r)))) throw new Error('not a repository of this workspace');
        return request(undefined, repos, 'github');
      }),
  };
  /** One JSON line in, one out: `answer`'s token, or its error's message. */
  function listen(socket: string, answer: (req: { repos?: string[]; kind?: TokenKind }) => Promise<GitHubToken>) {
    rmSync(socket, { force: true });
    const server = net.createServer((sock) => {
      sock.on('error', () => {});
      lines(sock, async (req: { repos?: string[]; kind?: TokenKind }) => {
        const res = await Promise.resolve().then(() => answer(req ?? {})).catch((e) => ({ error: String(e?.message ?? e) }));
        sock.end(JSON.stringify(res) + '\n');
      });
    });
    // 0660: runners reach it through the group of SP_RUN (setgid), also when they run as another user (work 077).
    server.listen(socket, () => chmodSync(socket, 0o660));
    return server;
  }
  return relay;
}
