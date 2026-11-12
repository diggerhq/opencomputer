import net from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { loopbackDialer } from './preview-dial.js';

const servers: net.Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function listen(): Promise<number> {
  const s = net.createServer((c) => c.end('hello'));
  servers.push(s);
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  return (s.address() as net.AddressInfo).port;
}

describe('loopbackDialer', () => {
  it('connects to a port that listens on loopback', async () => {
    const c = loopbackDialer(await listen());
    await once(c, 'connect');
    const [data] = await once(c, 'data');
    expect(String(data)).toBe('hello');
    c.destroy();
  });

  it('reports ECONNREFUSED as an error event when nothing listens', async () => {
    const port = await listen();
    servers.splice(0)[0].close();
    await new Promise((r) => setTimeout(r, 20));
    const [e] = await once(loopbackDialer(port), 'error');
    expect((e as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
  });
});
