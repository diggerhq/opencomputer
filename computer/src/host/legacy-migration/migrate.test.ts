// ONE-TIME systemd->podman migration (work 103). Delete together with the systemd launch path in step 11.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionSpec } from '../../protocol.js';
import type { AsRunner } from '../sandbox/podman.js';
import { sandboxRecords } from '../sandbox/records.js';
import { legacyMigration, migrateArgv, parseResult } from './migrate.js';

// biome-ignore lint/suspicious/noExplicitAny: a plain .mjs, imported for its exports
const script: any = await import('../../../bin/legacy-migrate.mjs' as string);

const SID = '0b7c6a52-1f3e-4d6a-9a43-2f6f4bfb0e11';
const CODEX = 'a1b2c3d4e5f6a1b2c3d4e5f6';

/** A `systemd` host's leftovers of one thread, in a temporary directory: the paths the script sees, and the host's. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'legacy-'));
  const forkHost = path.join(root, 'people/pat/sessions/C1-1.1');
  const clonesHost = path.join(root, 'people/pat/ws');
  const p = {
    claudeProjects: path.join(root, 'agent/.claude/projects'), codex: path.join(root, 'agent/.calvin/codex'),
    home: path.join(root, 'volume'), clones: clonesHost, wt: path.join(root, 'people/pat/wt/C1-1.1'), workspace: forkHost,
  };
  for (const d of [p.home, p.wt]) mkdirSync(d, { recursive: true });
  // The fork: two worktrees and an uncommitted file; .fork.json names a third that is not there.
  const info = { branch: 'sp/C1-1-1', from: 'origin/main', base: 'abc' };
  mkdirSync(forkHost, { recursive: true });
  writeFileSync(path.join(forkHost, '.fork.json'), JSON.stringify({ repos: { hello: info, other: info, gone: info } }));
  for (const [repo, name] of [['hello', 'C1-1.1'], ['other', 'C1-1.12']]) {
    const admin = path.join(clonesHost, repo, '.git/worktrees', name);
    mkdirSync(admin, { recursive: true });
    writeFileSync(path.join(admin, 'gitdir'), `${forkHost}/${repo}/.git\n`);
    writeFileSync(path.join(admin, 'commondir'), '../..\n');
    writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/sp/C1-1-1\n');
    mkdirSync(path.join(forkHost, repo), { recursive: true });
    writeFileSync(path.join(forkHost, repo, '.git'), `gitdir: ${admin}\n`);
  }
  writeFileSync(path.join(forkHost, 'hello/wip.txt'), 'uncommitted\n');
  // The transcript, a subagent's beside it, and a file that is not text.
  const project = path.join(p.claudeProjects, script.claudeSlug(forkHost));
  mkdirSync(path.join(project, SID, 'subagents'), { recursive: true });
  const line = (o: object) => `${JSON.stringify(o)}\n`;
  writeFileSync(path.join(project, `${SID}.jsonl`),
    line({ sessionId: SID, cwd: forkHost, message: { content: 'marker-turn-1' } }) +
    line({ sessionId: SID, tool: { file_path: `${forkHost}/hello/wip.txt`, cd: `${clonesHost}/hello/.git`, sibling: `${forkHost}2/x` } }));
  writeFileSync(path.join(project, SID, 'subagents/agent-1.jsonl'), line({ sessionId: SID, cwd: `${forkHost}/hello` }));
  writeFileSync(path.join(project, 'blob.bin'), forkHost);
  // Another thread's transcript is not copied.
  mkdirSync(path.join(p.claudeProjects, script.claudeSlug(`${forkHost}2`)), { recursive: true });
  mkdirSync(path.join(p.codex, CODEX, 'sessions'), { recursive: true });
  writeFileSync(path.join(p.codex, CODEX, 'sessions/rollout.jsonl'), `{"cwd":"${forkHost}"}\n`);
  return { root, forkHost, clonesHost, p, o: { forkHost, clonesHost, harness: 'claude', sdkSessionId: SID, codexName: CODEX } };
}

describe('legacy-migrate.mjs', () => {
  it('copies the transcript to -workspace with its paths rewritten and its session id kept', () => {
    const f = fixture();
    const out = script.migrate(f.p, f.o);
    expect(out.claude).toBe(true);
    const into = path.join(f.p.home, '.claude/projects/-workspace');
    const lines = readFileSync(path.join(into, `${SID}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ sessionId: SID, cwd: '/workspace', message: { content: 'marker-turn-1' } });
    expect(lines[1].tool).toEqual({ file_path: '/workspace/hello/wip.txt', cd: '/clones/hello/.git', sibling: `${f.forkHost}2/x` });
    expect(JSON.parse(readFileSync(path.join(into, SID, 'subagents/agent-1.jsonl'), 'utf8'))).toEqual({ sessionId: SID, cwd: '/workspace/hello' });
    expect(readFileSync(path.join(into, 'blob.bin'), 'utf8')).toBe(f.forkHost); // not text: as it was
    expect(readFileSync(path.join(f.p.claudeProjects, script.claudeSlug(f.forkHost), `${SID}.jsonl`), 'utf8')).toContain(f.forkHost); // the source is untouched
  });

  it('copies the Codex home as it is', () => {
    const f = fixture();
    expect(script.migrate(f.p, { ...f.o, harness: 'codex' }).codex).toBe(true);
    expect(readFileSync(path.join(f.p.home, '.calvin/codex', CODEX, 'sessions/rollout.jsonl'), 'utf8')).toBe(`{"cwd":"${f.forkHost}"}\n`);
  });

  it('re-points each worktree at container paths, moves its admin directory into the registry, and leaves commondir', () => {
    const f = fixture();
    const out = script.migrate(f.p, f.o);
    expect(Object.keys(out.repos)).toEqual(['hello', 'other']);
    expect(out.skipped).toEqual([{ repo: 'gone', why: 'its worktree is not in the fork' }]);
    for (const [repo, name] of [['hello', 'C1-1.1'], ['other', 'C1-1.12']]) {
      expect(readFileSync(path.join(f.forkHost, repo, '.git'), 'utf8')).toBe(`gitdir: /clones/${repo}/.git/worktrees/${repo}\n`);
      const admin = path.join(f.p.wt, repo, repo);
      expect(readFileSync(path.join(admin, 'gitdir'), 'utf8')).toBe(`/workspace/${repo}/.git\n`);
      expect(readFileSync(path.join(admin, 'commondir'), 'utf8')).toBe('../..\n');
      expect(readFileSync(path.join(admin, 'HEAD'), 'utf8')).toBe('ref: refs/heads/sp/C1-1-1\n');
      expect(existsSync(path.join(f.clonesHost, repo, '.git/worktrees', name))).toBe(false);
    }
    expect(readFileSync(path.join(f.forkHost, 'hello/wip.txt'), 'utf8')).toBe('uncommitted\n');
    // Again: nothing left to do, the same answer.
    expect(script.migrate(f.p, f.o).repos).toEqual(out.repos);
  });

  it("leaves out a worktree whose admin directory is another fork's", () => {
    const f = fixture();
    writeFileSync(path.join(f.clonesHost, 'other/.git/worktrees/C1-1.12/gitdir'), '/elsewhere/other/.git\n');
    const out = script.migrate(f.p, f.o);
    expect(Object.keys(out.repos)).toEqual(['hello']);
    expect(out.skipped).toContainEqual({ repo: 'other', why: "the clone's C1-1.12 belongs to /elsewhere/other/.git" });
    expect(readFileSync(path.join(f.forkHost, 'other/.git'), 'utf8')).toContain(f.clonesHost);
  });

  it('fails, changing nothing of the person\'s, when the transcript to resume or .fork.json is missing', () => {
    const f = fixture();
    expect(() => script.migrate(f.p, { ...f.o, sdkSessionId: 'nope' })).toThrow(/no transcript nope.jsonl/);
    expect(readFileSync(path.join(f.forkHost, 'hello/.git'), 'utf8')).toContain(f.clonesHost);
    const g = fixture();
    writeFileSync(path.join(g.forkHost, '.fork.json'), '');
    expect(() => script.migrate(g.p, g.o)).toThrow();
  });

  it('rewrites only whole path names', () => {
    expect(script.rewritePaths('"/a/s/C1" "/a/s/C1/x" "/a/s/C1.2" "/a/ws/r" "/a/wsx"', '/a/s/C1', '/a/ws')).toBe('"/workspace" "/workspace/x" "/a/s/C1.2" "/clones/r" "/a/wsx"');
  });
});

const owner = { dir: 'pat', gitName: 'Pat', gitEmail: 'pat@example.com' };
const spec: SessionSpec = { key: 'C1:1.1', kind: 'thread', owner, title: 't', mode: 'default', sdkSessionId: SID, forkPath: '/data/people/pat/sessions/C1-1.1' };

function host(o: { there?: boolean; helper?: () => Promise<string>; mv?: () => Promise<string> } = {}) {
  const calls: string[] = [];
  const records = sandboxRecords(mkdtempSync(path.join(tmpdir(), 'records-')));
  const as: AsRunner = {
    podman: async (args) => (calls.push(`podman ${args.slice(0, 3).join(' ')}`), ''),
    run: async (argv) => {
      calls.push(argv[0] === '/usr/bin/systemd-run' ? `helper record=${records.get('00112233445566aa') ? 'yes' : 'no'}` : argv.join(' '));
      if (argv[0] === '/usr/bin/systemd-run') return o.helper ? o.helper() : `noise\n${JSON.stringify({ repos: { hello: { branch: 'b' } }, claude: true, codex: false, skipped: [] })}\n`;
      if (argv[0] === '/bin/mv' && o.mv) return o.mv();
      return '';
    },
    settled: async () => void calls.push('settled'),
  } as AsRunner;
  const migrate = legacyMigration({
    as, records, root: '/opt/slack-presence/releases/abc', image: 'img', helperRun: '/run/sp/helper', runRoot: (id) => `/run/sp/sandbox/${id}` as never,
    agentHome: '/data/home/agent', there: () => o.there ?? true, newId: () => '00112233445566aa',
    mounts: { people: '/data/people', workspace: (r) => `/data/people/${r.person}/sessions/${r.key.replace(':', '-')}`, clones: (p) => `/data/people/${p}/ws` },
  });
  return { calls, records, migrate };
}

describe('legacyMigration', () => {
  it('a thread with no fork is not touched', async () => {
    const h = host({ there: false });
    expect(await h.migrate(spec)).toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  it('makes the home volume first and writes the record last, with the repositories the script re-pointed', async () => {
    const h = host();
    const r = await h.migrate(spec);
    expect(r).toMatchObject({ id: '00112233445566aa', person: 'pat', key: 'C1:1.1', repos: { hello: { branch: 'b' } } });
    expect(h.records.find('pat', 'C1:1.1')).toEqual(r);
    expect(h.calls[0]).toMatch(/^podman volume create/);
    expect(h.calls).toContain('helper record=no');
    expect(h.calls.indexOf('settled')).toBeLessThan(h.calls.indexOf('helper record=no'));
  });

  it('on a failure removes the volume, sets the fork aside and starts fresh, with no record', async () => {
    const h = host({ helper: async () => Promise.reject(new Error('exit 1: legacy-migrate: no transcript')) });
    expect(await h.migrate(spec)).toBeUndefined();
    expect(h.records.find('pat', 'C1:1.1')).toBeUndefined();
    expect(h.calls.slice(-3)).toEqual([
      'podman volume rm --force',
      '/bin/mkdir -p -- /data/people/pat/sessions.pre-sandbox',
      '/bin/mv --backup=numbered -T -- /data/people/pat/sessions/C1-1.1 /data/people/pat/sessions.pre-sandbox/C1-1.1',
    ]);
  });

  it('fails the start when the fork cannot be set aside either', async () => {
    const h = host({ helper: async () => 'not json', mv: async () => Promise.reject(new Error('mv: busy')) });
    await expect(h.migrate(spec)).rejects.toThrow(/mv: busy/);
  });

  it("runs the script in a helper container with the legacy homes read-only, the new home, the registry and the fork", () => {
    const argv = migrateArgv({
      root: '/opt/r', image: 'img', helperRun: '/run/h', people: '/data/people', person: 'pat', id: 'ff', fork: '/data/people/pat/sessions/C1-1.1',
      clones: '/data/people/pat/ws', wt: '/data/people/pat/wt/C1-1.1', claudeProjects: '/home/a/.claude/projects', harness: 'claude', sdkSessionId: SID, codexName: CODEX,
    });
    const s = argv.join(' ');
    expect(s).toContain('--userns=keep-id:uid=1500,gid=1500');
    expect(s).toContain('-v /home/a/.claude/projects:/legacy/claude-projects:ro');
    expect(s).not.toContain('/legacy/codex');
    expect(s).toContain('-v /data/people/pat/wt/C1-1.1:/wt -v /data/people/pat/sessions/C1-1.1:/workspace');
    expect(argv.slice(-6)).toEqual(['/opt/r/bin/legacy-migrate.mjs', '/data/people/pat/sessions/C1-1.1', '/data/people/pat/ws', 'claude', SID, CODEX]);
  });

  it('takes the last line of the output as the result', () => {
    expect(parseResult('x\n{"repos":{},"claude":false,"codex":false,"skipped":[]}\n').repos).toEqual({});
    expect(() => parseResult('{"repos":null}')).toThrow();
  });
});
