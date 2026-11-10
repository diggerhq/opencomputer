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
//
// Invariants: a request fails fast when the gateway is not connected and
// times out after 15 s; a failed request is not cached. Tokens are never logged.

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { GitHubToken, HostToGateway, TokenKind } from '../protocol.js';
import { lines } from '../ipc.js';
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
  /** A runner's own token socket in the runners' directory, for the session it serves now; closed when its socket closes. */
  serveRunner(id: string, runner: net.Socket, session: () => string | undefined): void;
}

/**
 * `ask` sends to the gateway and returns false when it is not connected.
 * `runnerDir`: where runners' own sockets go, emptied and made again here. Only the host writes there, so a session
 * cannot put its own socket in another's place; 02750 keeps SP_RUN's setgid group on the sockets, so runners running
 * as another user (work 077) can still reach their own.
 */
export function tokenRelay(ask: (m: Extract<HostToGateway, { t: 'token' }>) => boolean, tm: Telemetry, runnerDir?: string): TokenRelay {
  if (runnerDir) {
    rmSync(runnerDir, { recursive: true, force: true });
    mkdirSync(runnerDir, { recursive: true });
    chmodSync(runnerDir, 0o2750);
  }
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
    serveRunner(id, runner, session) {
      if (!runnerDir) throw new Error('no runner token directory');
      const server = relay.serve(path.join(runnerDir, `${id}.sock`), session);
      runner.once('close', () => server.close());
    },
    serve(socket, session) {
      rmSync(socket, { force: true });
      const server = net.createServer((sock) => {
        sock.on('error', () => {});
        lines(sock, async (req: { repos?: string[]; kind?: TokenKind }) => {
          const kind = req.kind === 'opencomputer' || req.kind === 'automation-repo' ? req.kind : 'github';
          const res = await request(session?.() || undefined, req.repos, kind).catch((e) => ({ error: String(e?.message ?? e) }));
          sock.end(JSON.stringify(res) + '\n');
        });
      });
      // 0660: runners reach it through the group of SP_RUN (setgid), also when they run as another user (work 077).
      server.listen(socket, () => chmodSync(socket, 0o660));
      return server;
    },
  };
  return relay;
}
