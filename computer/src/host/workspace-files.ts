// A session's workspace as the `/files` routes see it (work 084; opc docs
// http/workspace.mdx): list, stat and read one file, archive a directory,
// and unpack an upload beside the repositories. wire-link.ts moves the bytes;
// this decides what is allowed and does the filesystem work.
//
// Invariants:
// - Every path resolves inside the session's fork (symlinks included); one
//   that leaves it is `invalid_path`, one that does not exist `path_not_found`.
// - Writes run as the runner user (`user.sudo`, as runners are launched), so
//   an upload belongs to the agent and the host never writes into a fork as
//   itself. Reads of content (`cat`, `tar -c`) run as that user too; listing
//   and stat run in the host, which is in the agent's group.
// - An upload is checked as it streams (tar-check.ts), unpacked into a hidden
//   directory beside its target, and renamed into place only when complete;
//   a failure removes it and changes nothing. A name that exists and was not
//   uploaded is `path_exists`; uploads in one session are serialized.
// - Which top-level names were uploaded, when and by whom, is kept in
//   `<stateDir>/<sessionId>.json` (0600, the host's); losing it fails safe
//   (a re-push of that name is refused until it is removed).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import type { ApiActor, ApiError } from '../protocol.js';
import { apiError } from '../api/writer.js';
import type { RunnerUser } from './runner-user.js';
import { TarCheck, TarError, UPLOAD_MAX_BYTES, UPLOAD_MAX_FILES } from './tar-check.js';

export const FILE_MAX_BYTES = 100 * 1024 ** 2;
const LIST_WALK_MAX = 200_000;

export interface Workspace {
  sessionId: string;
  forkPath: string;
}

export interface ListEntry {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  bytes: number | null;
  modifiedAt: string;
  pushedAt: string | null;
  pushedBy: ApiActor | null;
}

export interface Pushed {
  pushedAt: string;
  pushedBy: ApiActor;
}

export interface Upload {
  path: string;
  files: number;
  bytes: number;
  replaced: Pushed | null;
}

type Fail = { error: ApiError };
export type Streamed = { stream: Readable; done: Promise<void> };

export interface WorkspaceFiles {
  list(ws: Workspace, q: { path: string; depth?: number; limit?: number; cursor?: string }): Promise<{ path: string; entries: ListEntry[]; nextCursor: string | null } | Fail>;
  file(ws: Workspace, rel: string): Promise<{ size: number; etag: string; contentType: string; read(): Streamed } | Fail>;
  archive(ws: Workspace, rel: string): Promise<{ files: number; bytes: number; read(): Streamed } | Fail>;
  /** Fails fast, before the body is read, when the name is taken. */
  canUpload(ws: Workspace, name: string): Promise<Fail | undefined>;
  upload(ws: Workspace, name: string, format: 'tar' | 'tar+gzip' | 'tar+zstd', actor: ApiActor, body: Readable): Promise<{ upload: Upload } | Fail>;
}

export interface WorkspaceFilesOptions {
  /** Scratch (unused today beyond the default state dir). */
  dir: string;
  /** Where upload records live; should survive a reboot (HOST_DATA/state/uploads). Default `<dir>/state`. */
  stateDir?: string;
  user?: RunnerUser;
}

const notFound = (): Fail => ({ error: apiError('path_not_found', 'Nothing at path.', 404) });
const badPath = (): Fail => ({ error: apiError('invalid_path', 'path must be relative and stay inside the workspace.', 400) });

const TYPES: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.ts': 'text/plain', '.css': 'text/css', '.csv': 'text/csv', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar', '.wasm': 'application/wasm',
};

/** A Content-Type from the name, else from the first bytes. HTML and SVG are served as text, never rendered on the API's origin. */
export function contentType(name: string, head: Buffer): string {
  const t = TYPES[path.extname(name).toLowerCase()];
  if (t) return t.startsWith('text/') ? `${t}; charset=utf-8` : t;
  return head.includes(0) ? 'application/octet-stream' : 'text/plain; charset=utf-8';
}

export function createWorkspaceFiles(o: WorkspaceFilesOptions): WorkspaceFiles {
  const stateDir = o.stateDir ?? path.join(o.dir, 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const chains = new Map<string, Promise<unknown>>();

  const asUser = (argv: string[], stdio: ('pipe' | 'ignore')[] = ['ignore', 'pipe', 'pipe']) => {
    const [cmd, ...args] = [...(o.user?.sudo ?? []), ...argv];
    return spawn(cmd, args, { stdio: stdio as ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...o.user?.env } });
  };
  const runAsUser = (argv: string[]) =>
    new Promise<void>((resolve, reject) => {
      const p = asUser(argv);
      let err = '';
      p.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')).slice(0, 2000));
      p.stdout?.resume();
      p.once('error', reject);
      p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${argv[0]} exited ${code}`))));
    });
  const streamed = (argv: string[]): Streamed => {
    const p = asUser(argv);
    let err = '';
    p.stderr?.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-2000)));
    const done = new Promise<void>((resolve, reject) => {
      p.once('error', reject);
      p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${argv[0]} exited ${code}`))));
    });
    done.catch(() => {});
    return { stream: p.stdout as Readable, done };
  };

  const statePath = (sessionId: string) => path.join(stateDir, `${sessionId}.json`);
  const readState = (sessionId: string): Record<string, Pushed> => {
    try {
      return JSON.parse(readFileSync(statePath(sessionId), 'utf8'));
    } catch {
      return {};
    }
  };
  const writeState = (sessionId: string, s: Record<string, Pushed>) => {
    const tmp = `${statePath(sessionId)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    renameSync(tmp, statePath(sessionId));
  };

  /** The real path of `rel` in the fork, if it exists and stays inside. */
  async function resolveIn(ws: Workspace, rel: string): Promise<{ abs: string } | Fail> {
    if (rel.startsWith('/') || rel.split('/').includes('..') || rel.includes('\0')) return badPath();
    let root: string;
    let abs: string;
    try {
      root = await realpath(ws.forkPath);
      abs = await realpath(path.join(root, rel));
    } catch {
      return notFound();
    }
    if (abs !== root && !abs.startsWith(root + path.sep)) return badPath();
    return { abs };
  }

  async function count(abs: string, limitFiles: number, limitBytes: number) {
    let files = 0;
    let bytes = 0;
    const visit = async (p: string): Promise<void> => {
      const st = await lstat(p);
      if (!st.isDirectory()) {
        files += 1;
        if (st.isFile()) bytes += st.size;
        return;
      }
      files += 1;
      if (files > limitFiles || bytes > limitBytes) return;
      for (const name of await readdir(p)) {
        if (name === '.git') continue;
        await visit(path.join(p, name));
        if (files > limitFiles || bytes > limitBytes) return;
      }
    };
    await visit(abs);
    return { files, bytes };
  }

  function serialized<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    chains.set(sessionId, tail);
    tail.then(() => chains.get(sessionId) === tail && chains.delete(sessionId));
    return next;
  }

  const self: WorkspaceFiles = {
    async list(ws, q) {
      const depth = q.depth ?? 1;
      const limit = q.limit ?? 20;
      let offset = 0;
      if (q.cursor) {
        try {
          const c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'));
          if (c.p !== q.path || c.d !== depth || !Number.isInteger(c.o) || c.o < 0) throw new Error('mismatch');
          offset = c.o;
        } catch {
          return { error: apiError('invalid_cursor', 'cursor is not from this listing.', 400) };
        }
      }
      const r = await resolveIn(ws, q.path);
      if ('error' in r) return r;
      if (!(await stat(r.abs)).isDirectory()) return notFound();
      const pushed = q.path === '' ? readState(ws.sessionId) : {};
      const entries: ListEntry[] = [];
      let seen = 0;
      let more = false;
      const walk = async (dir: string, rel: string, level: number): Promise<boolean> => {
        let names: string[];
        try {
          names = (await readdir(dir)).sort();
        } catch {
          return true;
        }
        for (const name of names) {
          const childRel = rel ? `${rel}/${name}` : name;
          const p = path.join(dir, name);
          const st = await lstat(p).catch(() => undefined);
          if (!st) continue;
          if (seen++ >= offset) {
            if (entries.length === limit) {
              more = true;
              return false;
            }
            const type = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file';
            const pr = level === 1 && type === 'dir' ? pushed[name] : undefined;
            entries.push({
              path: q.path ? `${q.path}/${childRel}` : childRel,
              type,
              bytes: type === 'file' ? st.size : null,
              modifiedAt: st.mtime.toISOString(),
              pushedAt: pr?.pushedAt ?? null,
              pushedBy: pr?.pushedBy ?? null,
            });
          }
          if (seen > LIST_WALK_MAX) return false;
          if (st.isDirectory() && name !== '.git' && level < depth && !(await walk(p, childRel, level + 1))) return false;
        }
        return true;
      };
      await walk(r.abs, '', 1);
      const nextCursor = more ? Buffer.from(JSON.stringify({ p: q.path, d: depth, o: offset + entries.length })).toString('base64url') : null;
      return { path: q.path, entries, nextCursor };
    },

    async file(ws, rel) {
      const r = await resolveIn(ws, rel);
      if ('error' in r) return r;
      const st = await stat(r.abs);
      if (!st.isFile()) return notFound();
      if (st.size > FILE_MAX_BYTES) return { error: apiError('too_large', 'The file is over 100 MiB. Download it as an archive.', 413, { bytes: st.size }) };
      const head = Buffer.alloc(Math.min(8192, st.size));
      try {
        const fh = await open(r.abs, 'r');
        await fh.read(head, 0, head.length, 0).finally(() => fh.close());
      } catch {
        head.fill(0); // unreadable here: still served as the user, typed as bytes
      }
      return {
        size: st.size,
        etag: `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}-${st.ino.toString(36)}"`,
        contentType: contentType(r.abs, head),
        read: () => streamed(['cat', '--', r.abs]),
      };
    },

    async archive(ws, rel) {
      const r = await resolveIn(ws, rel);
      if ('error' in r) return r;
      const n = await count(r.abs, UPLOAD_MAX_FILES, UPLOAD_MAX_BYTES);
      if (n.files > UPLOAD_MAX_FILES || n.bytes > UPLOAD_MAX_BYTES) {
        return { error: apiError('too_large', 'Over 1 GiB or 100,000 files.', 413, { bytes: n.bytes, files: n.files }) };
      }
      const isDir = (await stat(r.abs)).isDirectory();
      const [cwd, member] = isDir ? [r.abs, '.'] : [path.dirname(r.abs), path.basename(r.abs)];
      const argv = ['tar', '-c', '--exclude=.git', '--owner=0', '--group=0', '--numeric-owner', '--mode=u+rw,go-w,a+rX', '-C', cwd, '-f', '-', '--', member];
      return { ...n, read: () => streamed(argv) };
    },

    async canUpload(ws, name) {
      const target = path.join(ws.forkPath, name);
      const exists = await lstat(target).then(
        () => true,
        () => false,
      );
      if (exists && !readState(ws.sessionId)[name]) {
        return { error: apiError('path_exists', `${name} exists in the workspace and was not uploaded.`, 409) };
      }
      return undefined;
    },

    upload(ws, name, format, actor, body) {
      return serialized(ws.sessionId, async () => {
        const taken = await self.canUpload(ws, name);
        if (taken) {
          body.resume();
          return taken;
        }
        const tag = randomBytes(6).toString('hex');
        const tmp = path.join(ws.forkPath, `.opc-upload-${name}-${tag}`);
        const trash = path.join(ws.forkPath, `.opc-replaced-${name}-${tag}`);
        const target = path.join(ws.forkPath, name);
        const check = new TarCheck();
        const tar = asUser(['sh', '-c', 'mkdir -- "$1" && exec tar -x --no-same-owner --no-same-permissions -C "$1" -f -', 'sh', tmp], ['pipe', 'ignore', 'pipe']);
        let tarErr = '';
        tar.stderr?.on('data', (d: Buffer) => (tarErr = (tarErr + d.toString('utf8')).slice(-1000)));
        const exited = new Promise<number | null>((resolve) => {
          tar.once('exit', resolve);
          tar.once('error', () => resolve(-1));
        });
        tar.stdin?.on('error', () => {});
        const sink = tar.stdin as Writable;
        const z = format === 'tar+gzip' ? zlib.createGunzip() : format === 'tar+zstd' ? zlib.createZstdDecompress() : undefined;
        let failure: ApiError | undefined;
        try {
          await (z ? pipeline(body, z, check, sink) : pipeline(body, check, sink));
        } catch (e) {
          failure = e instanceof TarError ? e.error : apiError('invalid_archive', `The body could not be read as ${format}.`, 400);
          tar.kill('SIGKILL');
        }
        const code = await exited;
        // tar quitting first breaks the pipe: its own message says why, the pipe's does not.
        if (code !== 0 && tarErr.trim() && failure?.code === 'invalid_archive' && failure.message.startsWith('The body could not be read')) failure = undefined;
        if (!failure && code !== 0) failure = apiError('invalid_archive', `The archive could not be unpacked: ${tarErr.trim().split('\n').pop() ?? ''}`, 400);
        if (failure) {
          await runAsUser(['rm', '-rf', '--', tmp]).catch(() => {});
          return { error: failure };
        }
        const state = readState(ws.sessionId);
        const prev = state[name] ?? null;
        try {
          // -T: never move into a directory that appeared meanwhile; a name the agent created since the check fails here.
          await runAsUser(['sh', '-c', 'set -e; if [ -n "$4" ]; then mv -T -- "$2" "$3"; fi; mv -T -- "$1" "$2"; rm -rf -- "$3"', 'sh', tmp, target, trash, prev ? '1' : '']);
        } catch {
          await runAsUser(['rm', '-rf', '--', tmp]).catch(() => {});
          return { error: apiError('path_exists', `${name} changed in the workspace during the upload.`, 409) };
        }
        state[name] = { pushedAt: new Date().toISOString(), pushedBy: actor };
        writeState(ws.sessionId, state);
        return { upload: { path: name, files: check.result.files, bytes: check.result.bytes, replaced: prev } };
      });
    },
  };
  return self;
}
