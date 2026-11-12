import net from 'node:net';
import { mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectChecked, pinSocket } from './checked-socket.js';
import { checkedDial, remotePort } from './remote-port.js';
import { dialSocket } from './runner-sockets.js';

const servers: net.Server[] = [];
const dir = () => mkdtempSync(path.join(tmpdir(), 'checked-'));
const serve = (p: string, says: string) =>
  new Promise<void>((r) => servers.push(net.createServer((c) => void c.on('error', () => {}).end(says)).listen(p, r)));
const read = (s: net.Socket) =>
  new Promise<string>((resolve, reject) => {
    let out = '';
    s.on('data', (b) => (out += b)).on('end', () => resolve(out)).on('error', reject);
  });
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const linux = process.platform === 'linux';

describe('connectChecked', () => {
  it('connects to a socket', async () => {
    const p = path.join(dir(), 'a.sock');
    await serve(p, 'a');
    expect(await read(connectChecked(p, { uid: process.getuid!() }))).toBe('a');
  });

  it('refuses a link to a socket, a file, and a socket of another user; nothing there is ENOENT', async () => {
    const d = dir();
    await serve(path.join(d, 'a.sock'), 'a');
    symlinkSync(path.join(d, 'a.sock'), path.join(d, 'link.sock'));
    writeFileSync(path.join(d, 'file.sock'), '');
    expect(() => connectChecked(path.join(d, 'link.sock'))).toThrow(/not a socket/);
    expect(() => connectChecked(path.join(d, 'file.sock'))).toThrow(/not a socket/);
    expect(() => connectChecked(path.join(d, 'a.sock'), { uid: process.getuid!() + 1 })).toThrow(/owned by uid/);
    expect(() => connectChecked(path.join(d, 'none.sock'))).toThrow(/ENOENT/);
  });

  it.runIf(linux)('connects to what it checked, whatever the path holds a moment later', async () => {
    const d = dir();
    const a = path.join(d, 'a.sock');
    await serve(a, 'checked');
    await serve(path.join(d, 'other.sock'), 'swapped in');
    const pin = pinSocket(a);
    // The session swaps the path for a link to another socket between the check and the connect.
    symlinkSync(path.join(d, 'other.sock'), path.join(d, 'l'));
    renameSync(path.join(d, 'l'), a);
    expect(await read(net.connect(a))).toBe('swapped in'); // what lstat-then-connect would reach
    expect(await read(net.connect(pin.path))).toBe('checked');
    pin.close();
    pin.close(); // twice is once
  });

  it.runIf(linux)('holds no file descriptor once connected or refused', async () => {
    const d = dir();
    const p = path.join(d, 'a.sock');
    await serve(p, 'a');
    const fds = () => readdirSync('/proc/self/fd').length as number;
    const before = fds();
    for (let i = 0; i < 20; i++) await read(connectChecked(p));
    rmSync(p); // nobody listens at the pinned inode's path any more; the next pin is ENOENT
    expect(() => connectChecked(p)).toThrow(/ENOENT/);
    expect(fds()).toBeLessThanOrEqual(before + 1);
  });
});

describe('the dials built on it', () => {
  const planted = async () => {
    const d = dir();
    await serve(path.join(d, 'real.sock'), '{"t":"hello"}\n');
    symlinkSync(path.join(d, 'real.sock'), path.join(d, 'link.sock'));
    return d;
  };

  it("dialSocket: a runner's socket, never a link a session put in its place, never another user's", async () => {
    const d = await planted();
    const s = await dialSocket(path.join(d, 'real.sock'), { uid: process.getuid!() });
    expect(s).toBeDefined();
    s!.destroy();
    expect(await dialSocket(path.join(d, 'link.sock'))).toBeUndefined();
    expect(await dialSocket(path.join(d, 'real.sock'), { uid: process.getuid!() + 1 })).toBeUndefined();
    expect(await dialSocket(path.join(d, 'none.sock'))).toBeUndefined();
  });

  it("a runner's API socket is dialled the same way, by default", async () => {
    const d = await planted();
    await expect(checkedDial()(path.join(d, 'link.sock'), 'token')).rejects.toThrow(/not a socket/);
    const port = remotePort(path.join(d, 'link.sock'), 'token', { dialMs: 0 });
    await expect(port.call('sessions.get', {}, {} as never)).rejects.toThrow(/not a socket/);
    port.close();
  });
});
