// The runner's side of bin/calvin-send-file: a script that renders a
// screenshot, chart or video posts it itself, in the same Bash call, instead of
// waiting for a model step to call send_file (work 063: ~11 s at p50).
//
// One JSON line in, {"path", "comment"?, "title"?, "alt_text"?, "cwd"?}; one
// line back, {"ok", "text"}. The same checks as the tool apply (FileSender):
// workspace or temp files only, no secrets, one limit per session.

import { chmodSync, rmSync } from 'node:fs';
import net from 'node:net';
import { lines, send } from '../ipc.js';
import type { FileSender } from './send-file.js';

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
/** A client that connects and never sends its line is dropped. */
const REQUEST_TIMEOUT_MS = 10_000;

export function serveFiles(socket: string, sendFile: FileSender) {
  rmSync(socket, { force: true });
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.setTimeout(REQUEST_TIMEOUT_MS, () => sock.destroy());
    let taken = false; // one request per connection; later lines are ignored
    lines(sock, async (m) => {
      if (taken) return;
      taken = true;
      sock.setTimeout(0);
      let r: { ok: boolean; text: string };
      try {
        const path = str(m?.path);
        r = path
          ? await sendFile({ path, comment: str(m.comment), title: str(m.title), alt_text: str(m.alt_text) }, str(m.cwd), 'script')
          : { ok: false, text: 'no path' };
      } catch (e: any) {
        r = { ok: false, text: e?.message ?? String(e) }; // fileSender never throws; this is the last resort
      }
      send(sock, r);
      sock.end();
    });
  });
  server.listen(socket, () => chmodSync(socket, 0o600));
  return server;
}
