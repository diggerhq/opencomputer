// A session's workspace as the `/files` routes see it (work 084; opc docs
// http/workspace.mdx): list, stat and read one file, archive a directory,
// and unpack an upload beside the repositories. wire-link.ts moves the bytes;
// this decides what is allowed and does the filesystem work.
//
// Invariants:
// - The host never opens, lists or stats a workspace file itself (work 103,
//   C13): every operation is one `sh -c` script (GNU coreutils, findutils and
//   tar) started by the workspace's Place, as the runners' user where the
//   session's files are. On a host whose sessions run in containers that is
//   inside the session's container, or a helper container with the
//   workspace bound when the session is stopped (sandbox/scripts.ts
//   `filesPlace`); there a workspace without a sandbox has no Place and the
//   call fails.
// - A script that ended because the session stopped under it (the Place says
//   so, `lost`) is run once more, where the session is then, only when it
//   changes nothing and none of its output was passed on: a listing, a stat,
//   a download that had sent no byte. A script that writes, and a download
//   cut part way, fail as Unavailable, with words that say the session
//   stopped (work 103, C13).
// - Every path resolves inside the workspace (symlinks included); one that
//   leaves it is `invalid_path` (the script's exit 45), one that does not
//   exist `path_not_found` (44). The check and the read are the same script
//   in the same process, so nothing on the host acts on a path checked
//   earlier. Paths and names reach a script as arguments, never as its text.
// - An upload is checked as it streams (tar-check.ts), unpacked into a hidden
//   directory beside its target, and renamed into place only when complete;
//   a failure removes it and changes nothing. The script that unpacks removes
//   its own directory when it does not finish, and the next upload of the
//   session removes what a killed one left: the host's own removal is not
//   relied on, since the script may outlive the process the host started. A
//   name that exists and was not uploaded is `path_exists`; uploads in one
//   session are serialized.
// - A script is ended before it is done (its time is up, it printed too
//   much, its upload failed, the reader of its download went away) with
//   SIGTERM, never SIGKILL: the place decides what that ends (on a `podman`
//   host timeout(1) under sudo, and the limit inside the container or of the
//   helper, sandbox/scripts.ts `filesPlace`).
// - Which top-level names were uploaded, when and by whom, is kept in
//   `<stateDir>/<sessionId>.json` (0600, the host's); losing it fails safe
//   (a re-push of that name is refused until it is removed).

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough, type Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import type { ApiActor, ApiError } from '../protocol.js';
import { apiError } from '../api/writer.js';
import type { RunnerUser } from './runner-user.js';
import { Unavailable, unavailable } from './unavailable.js';
import type { SandboxPlace } from './sandbox/scripts.js';
import { TarCheck, TarError, UPLOAD_MAX_BYTES, UPLOAD_MAX_FILES } from './tar-check.js';
import { ARCHIVE, CAN_UPLOAD, CAT, COUNT, LIST, MOVE_IN, NOT_FOUND, OUTSIDE, REMOVE, STAT, UNPACK } from './workspace-scripts.js';

export const FILE_MAX_BYTES = 100 * 1024 ** 2;
const LIST_WALK_MAX = 200_000;

/** How long a script that answers with a few lines may take (a helper container starts in well under a second). */
const SCRIPT_WAIT_MS = 30_000;
/** Seconds a script that carries a file, an archive or an upload may take. */
const STREAM_WAIT_S = 3600;
const OUTPUT_MAX = 64 * 2 ** 20;
/** How long a script that was told to end has before its process is killed: past timeout(1)'s own 2 s (sandbox/podman.ts). */
const LAST_RESORT_MS = 5_000;

export interface Workspace {
  sessionId: string;
  /** The workspace on the host. */
  forkPath: string;
  /** Where it is when the session runs in a container (work 103). */
  sandbox?: SandboxPlace;
}

/** Where a workspace's files are reached: `root` is the workspace as a process started by `spawn` sees it. */
export interface Place {
  root: string;
  /**
   * `argv`: `/bin/sh` and what it is given. `write`: the script changes the workspace; `stdin`: it reads its standard
   * input; `seconds`: how long it may run, for a Place that can end it where it runs. stdio is always three pipes.
   * A Place that cannot start anything now rejects with Unavailable (unavailable.ts), which the caller is told.
   */
  spawn(argv: string[], o: { write?: boolean; stdin?: boolean; seconds?: number }): ChildProcess | Promise<ChildProcess>;
  /** A script this Place started has ended, and not by itself: the session it ran in stopped under it. */
  lost?(p: ChildProcess): Promise<boolean>;
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
  /** How long a script that answers with a few lines may take (30 s); tests pass less. */
  scriptWaitMs?: number;
  /** Where a workspace's scripts run. Default: on this machine, as `user`, at the workspace's own path. */
  place?(ws: Workspace): Place;
}

const STOPPED_WRITE = 'The session stopped while its files were being changed. Try again.';
const STOPPED_READ = 'The session stopped while its files were being read. Try again.';
const STOPPED_DOWNLOAD = 'The session stopped during the download. Try again.';

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

/** A top-level name an upload may take (the relay checks the same, src/wire/files.ts): it becomes part of file names in the workspace. */
const UPLOAD_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

interface Listed {
  rel: string;
  type: ListEntry['type'];
  bytes: number;
  modifiedAt: string;
}

/** What LIST printed (`type\tsize\tmtime\tpath\0` per entry), in path order: a directory before its contents, names by code unit. */
export function parseListing(out: Buffer): Listed[] {
  const rows: { parts: string[]; e: Listed }[] = [];
  for (const rec of out.toString('utf8').split('\0')) {
    const m = /^(.)\t(\d+)\t([\d.]+)\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    const type = m[1] === 'l' ? 'symlink' : m[1] === 'd' ? 'dir' : 'file';
    rows.push({ parts: m[4].split('/'), e: { rel: m[4], type, bytes: Number(m[2]), modifiedAt: new Date(Math.floor(Number(m[3]) * 1000)).toISOString() } });
  }
  rows.sort((a, b) => {
    for (let i = 0; i < a.parts.length && i < b.parts.length; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] < b.parts[i] ? -1 : 1;
    return a.parts.length - b.parts.length;
  });
  return rows.map((r) => r.e);
}

export function createWorkspaceFiles(o: WorkspaceFilesOptions): WorkspaceFiles {
  const stateDir = o.stateDir ?? path.join(o.dir, 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const chains = new Map<string, Promise<unknown>>();
  const waitMs = o.scriptWaitMs ?? SCRIPT_WAIT_MS;

  const onHost = (ws: Workspace): Place => ({
    root: ws.forkPath,
    spawn(argv) {
      const [cmd, ...args] = [...(o.user?.sudo ?? []), ...argv];
      return spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...o.user?.env } });
    },
  });
  const placeOf = o.place ?? onHost;

  /**
   * End a script before its time: SIGTERM, which sudo passes on and timeout(1) turns into the end of the command and
   * all it started (sandbox/podman.ts), and which a script that cleans up after itself acts on. SIGKILL would stop at
   * sudo, or at the shell, and leave the rest running. `LAST_RESORT_MS` later the child itself is killed, so that
   * whoever waits for its exit never waits for good.
   */
  function end(p: ChildProcess) {
    if (p.exitCode !== null || p.signalCode !== null) return;
    p.kill('SIGTERM');
    const last = setTimeout(() => p.kill('SIGKILL'), LAST_RESORT_MS);
    last.unref();
    p.once('exit', () => clearTimeout(last));
  }

  const places = new WeakMap<ChildProcess, Place>();
  /** `p` failed because the session stopped under it. */
  const lost = async (p: ChildProcess) => (await places.get(p)?.lost?.(p)) ?? false;

  /** Start `script` with the workspace's root as `$1` and `args` after it. */
  async function start(ws: Workspace, script: string, args: string[], mode: { write?: boolean; stdin?: boolean; seconds?: number } = {}): Promise<ChildProcess> {
    const place = placeOf(ws);
    const p = await place.spawn(['/bin/sh', '-c', script, 'sh', place.root, ...args], { seconds: STREAM_WAIT_S, ...mode });
    places.set(p, place);
    p.stdin?.on('error', () => {});
    if (!mode.stdin) p.stdin?.end();
    return p;
  }

  /** Run `script` to its end: its exit code and what it printed. Rejects when it cannot start, runs too long or prints too much. */
  async function run(ws: Workspace, script: string, args: string[], mode: { write?: boolean } = {}, again = true): Promise<{ code: number | null; out: Buffer; err: string }> {
    const p = await start(ws, script, args, { ...mode, seconds: waitMs / 1000 });
    const r = await once(p);
    if (r.code === 0 || !(await lost(p))) return r;
    // What a script that writes had done when the session stopped is not known: it is not done twice.
    if (mode.write) throw new Unavailable(STOPPED_WRITE);
    if (again) return run(ws, script, args, mode, false);
    throw new Unavailable(STOPPED_READ);
  }
  function once(p: ChildProcess): Promise<{ code: number | null; out: Buffer; err: string }> {
    return new Promise((resolve, reject) => {
      const out: Buffer[] = [];
      let bytes = 0;
      let err = '';
      const timer = setTimeout(() => (end(p), reject(new Error(`workspace script ran over ${waitMs} ms`))), waitMs);
      p.stdout?.on('data', (d: Buffer) => {
        out.push(d);
        if ((bytes += d.length) > OUTPUT_MAX) end(p), reject(new Error('workspace script printed too much'));
      });
      p.stderr?.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-2000)));
      p.once('error', (e) => (clearTimeout(timer), reject(e)));
      p.once('close', (code) => (clearTimeout(timer), resolve({ code, out: Buffer.concat(out), err })));
    });
  }

  /** `invalid_path` and `path_not_found` from a script's exit code; any other failure is the host's, and thrown. */
  function failed(r: { code: number | null; err: string }): Fail | undefined {
    if (r.code === 0) return undefined;
    if (r.code === NOT_FOUND) return notFound();
    if (r.code === OUTSIDE) return badPath();
    throw new Error(`workspace script exited ${r.code}: ${r.err.trim().split('\n').pop() ?? ''}`);
  }
  const refusedPath = (rel: string) => rel.startsWith('/') || rel.split('/').includes('..') || rel.includes('\0');

  /** A script whose output is the answer's body. The stream is there at once; the script starts when its place lets it, and `done` says how it went. */
  const streamed = (ws: Workspace, script: string, args: string[]): Streamed => {
    const stream = new PassThrough();
    const attempt = async (again: boolean): Promise<void> => {
      const p = await start(ws, script, args);
      let err = '';
      p.stderr?.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-2000)));
      const exited = new Promise<number | null>((resolve, reject) => {
        p.once('error', reject);
        p.once('exit', resolve);
      });
      // Whoever read it went away before its end (the request was cut): nobody is left to end the script by closing it.
      const gone = () => stream.readableEnded || end(p);
      if (stream.destroyed) end(p);
      else stream.once('close', gone);
      // The body ends when the script is known to have ended well: one the session stopped under may start again.
      const out = p.stdout as Readable;
      let sent = 0;
      out.on('data', (d: Buffer) => (sent += d.length));
      const drained = new Promise<void>((resolve) => {
        for (const e of ['end', 'close', 'error']) out.once(e, () => resolve());
        stream.once('close', () => resolve());
      });
      out.pipe(stream, { end: false });
      const code = await exited;
      if (code === 0) return void (out.readableEnded ? stream.end() : out.once('end', () => stream.end()));
      if (!stream.destroyed) await drained;
      if (!(await lost(p))) throw new Error(err.trim() || `workspace script exited ${code}`);
      if (sent > 0 || !again || stream.destroyed) throw new Unavailable(STOPPED_DOWNLOAD);
      stream.off('close', gone);
      return attempt(false);
    };
    const done = attempt(true);
    // A script that never started has nothing to say: the body ends, and `done` tells why.
    done.catch(() => stream.end());
    return { stream, done };
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
      if (refusedPath(q.path)) return badPath();
      const r = await run(ws, LIST, [q.path, String(depth), String(LIST_WALK_MAX + 1)]);
      const fail = failed(r);
      if (fail) return fail;
      const pushed = q.path === '' ? readState(ws.sessionId) : {};
      const page = parseListing(r.out).slice(offset, offset + limit + 1);
      const entries = page.slice(0, limit).map((e): ListEntry => {
        const pr = e.type === 'dir' && !e.rel.includes('/') ? pushed[e.rel] : undefined;
        return { path: q.path ? `${q.path}/${e.rel}` : e.rel, type: e.type, bytes: e.type === 'file' ? e.bytes : null, modifiedAt: e.modifiedAt,
          pushedAt: pr?.pushedAt ?? null, pushedBy: pr?.pushedBy ?? null };
      });
      const nextCursor = page.length > limit ? Buffer.from(JSON.stringify({ p: q.path, d: depth, o: offset + entries.length })).toString('base64url') : null;
      return { path: q.path, entries, nextCursor };
    },

    async file(ws, rel) {
      if (refusedPath(rel)) return badPath();
      const r = await run(ws, STAT, [rel]);
      const fail = failed(r);
      if (fail) return fail;
      const [stat, head64 = ''] = r.out.toString('latin1').split('\n');
      const [size, mtime, ino] = stat.split(' ');
      const bytes = Number(size);
      if (!Number.isSafeInteger(bytes)) throw new Error(`workspace stat printed ${stat.slice(0, 80)}`);
      if (bytes > FILE_MAX_BYTES) return { error: apiError('too_large', 'The file is over 100 MiB. Download it as an archive.', 413, { bytes }) };
      return {
        size: bytes,
        etag: `"${bytes.toString(36)}-${Math.floor(Number(mtime) * 1000).toString(36)}-${Number(ino).toString(36)}"`,
        contentType: contentType(rel, Buffer.from(head64, 'base64')), // empty when it could not be read: typed as text, served as the user
        read: () => streamed(ws, CAT, [rel]),
      };
    },

    async archive(ws, rel) {
      if (refusedPath(rel)) return badPath();
      const r = await run(ws, COUNT, [rel, String(UPLOAD_MAX_FILES + 1)]);
      const fail = failed(r);
      if (fail) return fail;
      let files = 0;
      let bytes = 0;
      for (const line of r.out.toString('latin1').split('\n')) {
        const m = /^(.) (\d+)$/.exec(line);
        if (!m) continue;
        files += 1;
        if (m[1] === 'f') bytes += Number(m[2]);
      }
      if (!files) throw new Error('workspace count printed nothing');
      if (files > UPLOAD_MAX_FILES || bytes > UPLOAD_MAX_BYTES) {
        return { error: apiError('too_large', 'Over 1 GiB or 100,000 files.', 413, { bytes, files }) };
      }
      return { files, bytes, read: () => streamed(ws, ARCHIVE, [rel]) };
    },

    async canUpload(ws, name) {
      if (!UPLOAD_NAME.test(name)) return badPath();
      const r = await run(ws, CAN_UPLOAD, [name]);
      if (r.code !== 0) throw new Error(`workspace script exited ${r.code}: ${r.err.trim()}`);
      if (r.out.toString('latin1').trim() === 'exists' && !readState(ws.sessionId)[name]) {
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
        const tmp = `.opc-upload-${name}-${tag}`;
        const trash = `.opc-replaced-${name}-${tag}`;
        const remove = () => run(ws, REMOVE, [tmp], { write: true }).catch(() => {});
        const check = new TarCheck();
        const tar = await start(ws, UNPACK, [tmp], { write: true, stdin: true });
        tar.stdout?.resume();
        let tarErr = '';
        tar.stderr?.on('data', (d: Buffer) => (tarErr = (tarErr + d.toString('utf8')).slice(-1000)));
        const exited = new Promise<number | null>((resolve) => {
          tar.once('exit', resolve);
          tar.once('error', () => resolve(-1));
        });
        // tar stops reading at the end-of-archive mark and may exit before the body's last bytes (padding) are written:
        // its closed input is then no failure of the body, so the rest is checked and written to nobody. A tar that
        // failed ends the transfer at once.
        const sink = tar.stdin as Writable;
        let closed = false;
        sink.once('close', () => (closed = true));
        const toTar = new Writable({
          write: (chunk, _enc, cb) => (closed ? cb() : void sink.write(chunk, () => cb())),
          final: (cb) => (closed ? cb() : void sink.end(() => cb())),
          destroy: (err, cb) => (sink.destroy(), cb(err)),
        });
        tar.once('exit', (code) => code !== 0 && toTar.destroy(new Error('tar failed')));
        const z = format === 'tar+gzip' ? zlib.createGunzip() : format === 'tar+zstd' ? zlib.createZstdDecompress() : undefined;
        let failure: ApiError | undefined;
        try {
          await (z ? pipeline(body, z, check, toTar) : pipeline(body, check, toTar));
        } catch (e) {
          failure = e instanceof TarError ? e.error : apiError('invalid_archive', `The body could not be read as ${format}.`, 400);
          end(tar);
        }
        const code = await exited;
        if (code !== 0 && (await lost(tar))) failure = unavailable(new Unavailable(STOPPED_WRITE));
        // tar quitting first breaks the pipe: its own message says why, the pipe's does not.
        else if (code !== 0 && tarErr.trim() && failure?.code === 'invalid_archive' && failure.message.startsWith('The body could not be read')) failure = undefined;
        if (!failure && code !== 0) failure = apiError('invalid_archive', `The archive could not be unpacked: ${tarErr.trim().split('\n').pop() ?? ''}`, 400);
        if (failure) {
          await remove();
          return { error: failure };
        }
        const state = readState(ws.sessionId);
        const prev = state[name] ?? null;
        let stopped: ApiError | undefined;
        const moved = await run(ws, MOVE_IN, [tmp, name, trash, prev ? '1' : ''], { write: true }).catch((e) => void (stopped = unavailable(e)));
        if (moved?.code !== 0) {
          await remove();
          return { error: stopped ?? apiError('path_exists', `${name} changed in the workspace during the upload.`, 409) };
        }
        state[name] = { pushedAt: new Date().toISOString(), pushedBy: actor };
        writeState(ws.sessionId, state);
        return { upload: { path: name, files: check.result.files, bytes: check.result.bytes, replaced: prev } };
      });
    },
  };
  return self;
}
