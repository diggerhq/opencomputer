// /tmp's aging lives in a tmpfiles.d file (deploy/vm/tmp.conf, installed by
// provision.sh); this runs the real systemd-tmpfiles --clean on it in a scratch
// root, next to Ubuntu's own tmp.conf, and checks what goes and what stays.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const CONF = path.resolve(import.meta.dirname, '../../deploy/vm/tmp.conf');
const tmpfiles = (() => {
  try {
    execFileSync('systemd-tmpfiles', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const DAY = 24 * 60 * 60;
let root = '';
afterEach(() => root && fs.rmSync(root, { recursive: true, force: true }));

/** Runs the clean on a root holding `files` (path under /tmp → age in days), and returns what is left under /tmp. */
function clean(files: Record<string, number>, dirs: Record<string, number>): string[] {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-tmp-'));
  const etc = path.join(root, 'etc/tmpfiles.d');
  const usr = path.join(root, 'usr/lib/tmpfiles.d');
  fs.mkdirSync(etc, { recursive: true });
  fs.mkdirSync(usr, { recursive: true });
  fs.writeFileSync(path.join(usr, 'tmp.conf'), 'D /tmp 1777 root root 30d\n'); // Ubuntu 24.04's
  // Birth and change times cannot be set back, so the test ages by access and modification only.
  const conf = fs.readFileSync(CONF, 'utf8');
  expect(conf).toMatch(/^D \/tmp 1777 root root 7d$/m);
  fs.writeFileSync(path.join(etc, 'tmp.conf'), conf.replace(/^(D \/tmp .*) 7d$/m, '$1 amAM:7d'));
  const tmp = path.join(root, 'tmp');
  const now = Date.now() / 1000;
  for (const f of Object.keys(files)) {
    fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
    fs.writeFileSync(path.join(tmp, f), '');
  }
  for (const d of Object.keys(dirs)) fs.mkdirSync(path.join(tmp, d), { recursive: true });
  for (const [f, days] of Object.entries(files)) fs.utimesSync(path.join(tmp, f), now - days * DAY, now - days * DAY);
  // Deepest first, so setting a child's times does not touch its parent's afterwards.
  for (const [d, days] of Object.entries(dirs).sort(([a], [b]) => b.length - a.length)) fs.utimesSync(path.join(tmp, d), now - days * DAY, now - days * DAY);
  execFileSync('systemd-tmpfiles', ['--clean', `--root=${root}`], { stdio: 'pipe' });
  return (fs.readdirSync(tmp, { recursive: true }) as string[]).sort();
}

describe.skipIf(!tmpfiles)('deploy/vm/tmp.conf', () => {
  it('removes week-old scratch and keeps recent entries', () => {
    expect(clean({ 'old.txt': 8, 'new.txt': 1, 'ws-prompt-1': 30 }, { 'session-test-1': 10, 'track-i': 2 })).toEqual(['new.txt', 'track-i']);
  });

  it('keeps an old directory while anything inside is recent, and empties old files out of a recent one', () => {
    const left = clean(
      { 'oc-src/new.ts': 1, 'oc-src/sub/old.ts': 9, 'vid/old.mp4': 9 },
      { 'oc-src': 20, 'oc-src/sub': 20, vid: 1 },
    );
    expect(left).toEqual(['oc-src', 'oc-src/new.ts', 'vid']);
  });

  it('never ages the host’s attachments or other services’ private /tmp', () => {
    const keep = ['slack-presence/s-1/F1-a.png', 'systemd-private-abc-x/tmp/f', 'snap-private-tmp/f', '.X11-unix/X0', '.ICE-unix/1'];
    const left = clean(Object.fromEntries(keep.map((f) => [f, 20])), Object.fromEntries(keep.map((f) => [path.dirname(f), 20])));
    for (const f of keep) expect(left).toContain(f);
  });
});
