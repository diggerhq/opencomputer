import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlackThread } from './thread.js';

describe('SlackThread.upload', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uploads a file whose size is not a multiple of 100 bytes', async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'thread-')), 'clip.mp4');
    await writeFile(file, Buffer.alloc(101, 1));
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const complete = vi.fn(async () => ({ ok: true }));
    const client = {
      files: { getUploadURLExternal: async () => ({ ok: true, upload_url: 'https://up', file_id: 'F1' }), completeUploadExternal: complete },
    } as any;
    const thread = new SlackThread(client, { kind: 'thread', channel: 'C1', threadTs: '1.2', userId: 'U1', title: 't' });
    await thread.upload({ path: file, filename: 'clip.mp4' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
