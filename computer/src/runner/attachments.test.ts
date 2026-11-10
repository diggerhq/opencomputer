import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAttachments, interruptDownloads, userContent } from './attachments.js';

const respond = (body: BodyInit, type: string, status = 200) =>
  vi.fn(async () => new Response(body, { status, headers: { 'content-type': type } }));

const KEY = `attachments-test-${process.pid}`;
const DIR = path.join(os.tmpdir(), 'slack-presence', KEY);
const LIMITS = { maxBytes: 1024, stallMs: 60_000, waitBytes: 100 };
const files = (prefix: string) => (existsSync(DIR) ? readdirSync(DIR).filter((n) => n.startsWith(prefix)) : []);

afterEach(() => vi.unstubAllGlobals());
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe('fetchAttachments', () => {
  it('downloads a large video in the background, without holding up the message', async () => {
    const size = 45 * 1024 * 1024;
    let send!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => (send = r))),
    );
    const [a] = await fetchAttachments(
      [{ id: 'F1', name: 'demo.mp4', mimetype: 'video/mp4', size, url_private_download: 'https://files/x' }],
      'xoxb-test',
      KEY,
    );
    expect(existsSync(a.path)).toBe(false);
    expect(userContent('', [a])).toEqual([
      { type: 'text', text: `[attached file demo.mp4 (video/mp4) downloading to ${a.path}: it appears there when complete; if the download fails, ${a.path}.error says why]` },
    ]);
    send(new Response(new Uint8Array(size), { headers: { 'content-type': 'video/mp4' } }));
    await a.pending;
    expect(statSync(a.path).size).toBe(size);
    expect(files('F1-')).toEqual(['F1-demo.mp4']);
  });

  it('waits for small files and inlines small images', async () => {
    vi.stubGlobal('fetch', respond(new Uint8Array([1, 2, 3]), 'image/png'));
    const [a] = await fetchAttachments(
      [{ id: 'F2', name: 'shot.png', mimetype: 'image/png', size: 3, url_private: 'https://files/y' }],
      'xoxb-test',
      KEY,
    );
    expect(a.pending).toBeUndefined();
    expect(a.image?.data).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('tells the model why a download failed', async () => {
    vi.stubGlobal('fetch', respond('nope', 'text/plain', 403));
    const atts = await fetchAttachments(
      [{ id: 'F3', name: 'clip.mov', mimetype: 'video/quicktime', size: 10, url_private: 'https://files/z' }],
      'xoxb-test',
      KEY,
    );
    expect(userContent('hi', atts)).toEqual([{ type: 'text', text: 'hi\n[attached clip.mov: could not be downloaded (HTTP 403)]' }]);
  });

  it('holds the size cap when Slack declares no size, leaving the reason and no partial file', async () => {
    vi.stubGlobal('fetch', respond(new Uint8Array(2048), 'video/mp4'));
    const [a] = await fetchAttachments([{ id: 'F4', name: 'big.mp4', mimetype: 'video/mp4', url_private: 'https://files/w' }], 'xoxb-test', KEY, LIMITS);
    await a.pending;
    expect(readFileSync(`${a.path}.error`, 'utf8')).toBe('too large (over 1024 bytes)\n');
    expect(files('F4-')).toEqual(['F4-big.mp4.error']);
  });

  it('drops a download that stops sending', async () => {
    // Like real fetch: sends one chunk, then nothing, and errors the body on abort.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const hang = new ReadableStream<Uint8Array>({
          start: (c) => {
            c.enqueue(new Uint8Array(10));
            init.signal?.addEventListener('abort', () => c.error(init.signal?.reason));
          },
        });
        return new Response(hang, { headers: { 'content-type': 'video/mp4' } });
      }),
    );
    const [a] = await fetchAttachments([{ id: 'F5', name: 'stuck.mp4', mimetype: 'video/mp4', size: 99, url_private: 'https://files/v' }], 'xoxb-test', KEY, {
      ...LIMITS,
      stallMs: 50,
    });
    expect(a.error).toBe('download stalled');
  });

  it('leaves a reason for each background download a stopping runner interrupts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const hang = new ReadableStream<Uint8Array>({
          start: (c) => {
            c.enqueue(new Uint8Array(10));
            init.signal?.addEventListener('abort', () => c.error(init.signal?.reason));
          },
        });
        return new Response(hang, { headers: { 'content-type': 'video/mp4' } });
      }),
    );
    const [a] = await fetchAttachments([{ id: 'F6', name: 'long.mp4', mimetype: 'video/mp4', size: 500, url_private: 'https://files/u' }], 'xoxb-test', KEY, LIMITS);
    await new Promise((r) => setTimeout(r, 20));
    await interruptDownloads();
    expect(readFileSync(`${a.path}.error`, 'utf8')).toMatch(/^interrupted: /);
    expect(files('F6-')).toEqual(['F6-long.mp4.error']);
  });
});
